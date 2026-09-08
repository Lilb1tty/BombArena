import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  canAccountReadGameResult,
  GameResultQueryService,
  GameResultWriter,
  toDetailedGameResult,
} from "../src/results/index.js";

test("maps detailed Game Results and authorizes only participating Accounts", () => {
  const result = toDetailedGameResult({
    id: "result-1",
    status: "COMPLETED",
    roomCode: "ARENA1",
    gameSeed: 42,
    mapVersion: "arena-v1",
    durationMs: 120_000,
    endedAt: new Date("2026-09-07T00:00:00.000Z"),
    outcomeKind: "WINNER",
    endReason: "ELIMINATION",
    abortReason: null,
    participants: [
      {
        accountId: "account-a",
        username: "alpha",
        outcome: "WON",
        kills: 2,
      },
      {
        accountId: "account-b",
        username: "bravo",
        outcome: "LOST",
        kills: 0,
      },
    ],
  });

  assert.deepEqual(result.outcome, {
    kind: "winner",
    reason: "elimination",
  });
  assert.deepEqual(result.participants[0], {
    accountId: "account-a",
    username: "alpha",
    outcome: "won",
    kills: 2,
  });
  assert.equal(canAccountReadGameResult("account-a", result), true);
  assert.equal(canAccountReadGameResult("account-b", result), true);
  assert.equal(canAccountReadGameResult("account-c", result), false);
});

test("records completed and aborted Results atomically with their participants", async () => {
  const writes: unknown[] = [];
  const prisma = {
    $transaction: async (
      callback: (transaction: {
        gameResult: { create: (args: { data: unknown }) => Promise<unknown> };
      }) => Promise<unknown>,
    ) =>
      callback({
        gameResult: {
          create: async ({ data }) => {
            writes.push(data);
            return writes.length === 1
              ? {
                  id: "completed-result",
                  status: "COMPLETED",
                  roomCode: "RESULT",
                  gameSeed: 42,
                  mapVersion: "arena-v1",
                  durationMs: 120_000,
                  endedAt: new Date("2026-09-07T00:00:00.000Z"),
                  outcomeKind: "WINNER",
                  endReason: "ELIMINATION",
                  abortReason: null,
                  participants: [
                    {
                      accountId: "account-a",
                      outcome: "WON",
                      kills: 2,
                      account: { username: "alpha" },
                    },
                    {
                      accountId: "account-b",
                      outcome: "LOST",
                      kills: 0,
                      account: { username: "bravo" },
                    },
                  ],
                }
              : {
                  id: "aborted-result",
                  status: "ABORTED",
                  roomCode: "RESULT",
                  gameSeed: 43,
                  mapVersion: "arena-v1",
                  durationMs: 500,
                  endedAt: new Date("2026-09-07T00:00:01.000Z"),
                  outcomeKind: null,
                  endReason: "ABORTED",
                  abortReason: "deployment",
                  participants: [
                    {
                      accountId: "account-a",
                      outcome: "ABORTED",
                      kills: 0,
                      account: { username: "alpha" },
                    },
                    {
                      accountId: "account-c",
                      outcome: "ABORTED",
                      kills: 0,
                      account: { username: "charlie" },
                    },
                  ],
                };
          },
        },
      }),
  } as unknown as PrismaClient;
  const writer = new GameResultWriter(prisma);

  const completed = await writer.record({
    status: "completed",
    roomCode: "RESULT",
    gameSeed: 42,
    mapVersion: "arena-v1",
    durationMs: 120_000,
    outcome: { kind: "winner", playerId: "account-a", reason: "elimination" },
    participants: [
      { accountId: "account-a", outcome: "won", kills: 2 },
      { accountId: "account-b", outcome: "lost", kills: 0 },
    ],
  });
  const aborted = await writer.record({
    status: "aborted",
    roomCode: "RESULT",
    gameSeed: 43,
    mapVersion: "arena-v1",
    durationMs: 500,
    abortReason: "deployment",
    participants: [
      { accountId: "account-a", outcome: "aborted", kills: 0 },
      { accountId: "account-c", outcome: "aborted", kills: 0 },
    ],
  });

  assert.deepEqual(completed.outcome, {
    kind: "winner",
    reason: "elimination",
  });
  assert.deepEqual(aborted.outcome, { kind: "aborted", reason: "deployment" });
  assert.deepEqual(writes, [
    {
      status: "COMPLETED",
      roomCode: "RESULT",
      gameSeed: 42,
      mapVersion: "arena-v1",
      durationMs: 120_000,
      outcomeKind: "WINNER",
      endReason: "ELIMINATION",
      abortReason: null,
      participants: {
        create: [
          { accountId: "account-a", outcome: "WON", kills: 2 },
          { accountId: "account-b", outcome: "LOST", kills: 0 },
        ],
      },
    },
    {
      status: "ABORTED",
      roomCode: "RESULT",
      gameSeed: 43,
      mapVersion: "arena-v1",
      durationMs: 500,
      outcomeKind: null,
      endReason: "ABORTED",
      abortReason: "deployment",
      participants: {
        create: [
          { accountId: "account-a", outcome: "ABORTED", kills: 0 },
          { accountId: "account-c", outcome: "ABORTED", kills: 0 },
        ],
      },
    },
  ]);
});

test("requires bounded abort diagnostics and exposes persistence failures", async () => {
  const writer = new GameResultWriter({
    $transaction: async () => {
      throw new Error("database unavailable");
    },
  } as unknown as PrismaClient);
  const aborted = {
    status: "aborted" as const,
    roomCode: "RESULT",
    gameSeed: 43,
    mapVersion: "arena-v1",
    durationMs: 500,
    abortReason: "x".repeat(201),
    participants: [
      { accountId: "account-a", outcome: "aborted" as const, kills: 0 },
      { accountId: "account-b", outcome: "aborted" as const, kills: 0 },
    ],
  };

  await assert.rejects(writer.record(aborted), /at most 200 characters/);
  await assert.rejects(
    writer.record({ ...aborted, abortReason: "   " }),
    /must be non-empty/,
  );
  await assert.rejects(
    writer.record({
      ...aborted,
      abortReason: "deployment",
    }),
    /database unavailable/,
  );
});

test("scopes detailed queries to participants and exposes completed aggregate evidence only", async () => {
  const detailedQueries: unknown[] = [];
  const aggregateQueries: unknown[] = [];
  const transaction = {
    gameResult: {
      count: async (args: unknown) => {
        aggregateQueries.push(args);
        return 4;
      },
      findMany: async (args: unknown) => {
        aggregateQueries.push(args);
        return [
          {
            endedAt: new Date("2026-09-07T00:00:00.000Z"),
            durationMs: 120_000,
            outcomeKind: "DRAW",
            endReason: "TIMEOUT",
            _count: { participants: 3 },
          },
        ];
      },
      findFirst: async (args: unknown) => {
        detailedQueries.push(args);
        return null;
      },
    },
    gameResultParticipant: {
      count: async (args: unknown) => {
        aggregateQueries.push(args);
        return 3;
      },
      aggregate: async (args: unknown) => {
        aggregateQueries.push(args);
        return { _sum: { kills: 9 } };
      },
    },
  };
  const prisma = {
    gameResult: transaction.gameResult,
    $transaction: async (
      callback: (client: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  } as unknown as PrismaClient;
  const queries = new GameResultQueryService(prisma);

  assert.equal(
    await queries.getDetailedForAccount("account-a", "completed-result"),
    null,
  );
  assert.deepEqual(await queries.getPublicAggregates(), {
    completedGames: 4,
    wins: 3,
    kills: 9,
    winRate: 0.75,
    recentGames: [
      {
        endedAt: new Date("2026-09-07T00:00:00.000Z"),
        durationMs: 120_000,
        outcome: "draw",
        reason: "timeout",
        participantCount: 3,
      },
    ],
  });
  assert.deepEqual(detailedQueries, [
    {
      where: {
        id: "completed-result",
        participants: { some: { accountId: "account-a" } },
      },
      select: {
        id: true,
        status: true,
        roomCode: true,
        gameSeed: true,
        mapVersion: true,
        durationMs: true,
        endedAt: true,
        outcomeKind: true,
        endReason: true,
        abortReason: true,
        participants: {
          orderBy: { accountId: "asc" },
          select: {
            accountId: true,
            outcome: true,
            kills: true,
            account: { select: { username: true } },
          },
        },
      },
    },
  ]);
  assert.deepEqual(aggregateQueries, [
    { where: { status: "COMPLETED" } },
    {
      where: {
        outcome: "WON",
        gameResult: { status: "COMPLETED" },
      },
    },
    { where: { gameResult: { status: "COMPLETED" } }, _sum: { kills: true } },
    {
      where: { status: "COMPLETED" },
      orderBy: { endedAt: "desc" },
      take: 10,
      select: {
        endedAt: true,
        durationMs: true,
        outcomeKind: true,
        endReason: true,
        _count: { select: { participants: true } },
      },
    },
  ]);
});

test("Game Result persistence and aggregate queries use real MySQL when available", async (context) => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    await prisma.$disconnect();
    context.skip(
      "requires reachable MySQL with the current Prisma migrations (for example, Docker Compose or CI services)",
    );
    return;
  }

  const writer = new GameResultWriter(prisma);
  const queries = new GameResultQueryService(prisma);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const accounts = await Promise.all(
    ["a", "b", "c"].map((letter) =>
      prisma.account.create({
        data: {
          username: `result${letter}${suffix}`,
          passwordCredentialHash: "test-only-password-credential-hash",
        },
      }),
    ),
  );
  const [winner, loser, outsider] = accounts;
  const before = await queries.getPublicAggregates();
  const resultIds: string[] = [];

  try {
    const completed = await writer.record({
      status: "completed",
      roomCode: "RESULT",
      gameSeed: 42,
      mapVersion: "arena-v1",
      durationMs: 120_000,
      outcome: {
        kind: "winner",
        playerId: winner.id,
        reason: "elimination",
      },
      participants: [
        { accountId: winner.id, outcome: "won", kills: 2 },
        { accountId: loser.id, outcome: "lost", kills: 0 },
      ],
    });
    resultIds.push(completed.id);
    const aborted = await writer.record({
      status: "aborted",
      roomCode: "RESULT",
      gameSeed: 43,
      mapVersion: "arena-v1",
      durationMs: 500,
      abortReason: "test_abort",
      participants: [
        { accountId: winner.id, outcome: "aborted", kills: 0 },
        { accountId: outsider.id, outcome: "aborted", kills: 0 },
      ],
    });
    resultIds.push(aborted.id);

    const abortedDetail = await queries.getDetailedForAccount(
      winner.id,
      aborted.id,
    );
    assert.deepEqual(abortedDetail?.outcome, {
      kind: "aborted",
      reason: "test_abort",
    });

    const participantDetail = await queries.getDetailedForAccount(
      winner.id,
      completed.id,
    );
    assert.equal(participantDetail?.id, completed.id);
    assert.equal(participantDetail?.participants.length, 2);
    assert.equal(
      await queries.getDetailedForAccount(outsider.id, completed.id),
      null,
    );

    const after = await queries.getPublicAggregates();
    assert.equal(after.completedGames, before.completedGames + 1);
    assert.equal(after.wins, before.wins + 1);
    assert.equal(after.kills, before.kills + 2);
    assert.equal(after.winRate, after.wins / after.completedGames);
    assert.ok(
      after.recentGames.some(
        (summary) =>
          summary.durationMs === 120_000 &&
          summary.outcome === "winner" &&
          summary.reason === "elimination" &&
          summary.participantCount === 2,
      ),
    );
    assert.equal(
      "accountId" in after.recentGames[0],
      false,
      "public summaries must not identify participants",
    );
  } finally {
    await prisma.gameResult.deleteMany({ where: { id: { in: resultIds } } });
    await prisma.account.deleteMany({
      where: { id: { in: accounts.map((account) => account.id) } },
    });
    await prisma.$disconnect();
  }
});
