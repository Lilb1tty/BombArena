import { PrismaClient } from "@prisma/client";

import type { GameOutcome } from "../game/index.js";

export type ResultParticipantOutcome = "won" | "lost" | "draw" | "aborted";

export type ResultParticipantInput = Readonly<{
  accountId: string;
  kills: number;
  outcome: ResultParticipantOutcome;
}>;

export type GameResultMetadata = Readonly<{
  roomCode: string;
  gameSeed: number;
  mapVersion: string;
  durationMs: number;
  endedAt?: Date;
}>;

export type CompletedGameResultInput = GameResultMetadata &
  Readonly<{
    status: "completed";
    outcome: GameOutcome;
    participants: readonly ResultParticipantInput[];
  }>;

export type AbortedGameResultInput = GameResultMetadata &
  Readonly<{
    status: "aborted";
    participants: readonly ResultParticipantInput[];
  }>;

export type NewGameResult = CompletedGameResultInput | AbortedGameResultInput;

export type DetailedGameResult = Readonly<{
  id: string;
  status: "completed" | "aborted";
  roomCode: string;
  gameSeed: number;
  mapVersion: string;
  durationMs: number;
  endedAt: Date;
  outcome:
    | Readonly<{
        kind: "winner" | "draw";
        reason: "elimination" | "timeout";
      }>
    | Readonly<{ kind: "aborted" }>;
  participants: readonly Readonly<{
    accountId: string;
    username: string;
    outcome: ResultParticipantOutcome;
    kills: number;
  }>[];
}>;

export type PublicGameResultSummary = Readonly<{
  endedAt: Date;
  durationMs: number;
  outcome: "winner" | "draw";
  reason: "elimination" | "timeout";
  participantCount: number;
}>;

export type PublicGameResultAggregates = Readonly<{
  completedGames: number;
  wins: number;
  kills: number;
  winRate: number;
  recentGames: readonly PublicGameResultSummary[];
}>;

type PersistedResult = Readonly<{
  id: string;
  status: "COMPLETED" | "ABORTED";
  roomCode: string;
  gameSeed: number;
  mapVersion: string;
  durationMs: number;
  endedAt: Date;
  outcomeKind: "WINNER" | "DRAW" | null;
  endReason: "ELIMINATION" | "TIMEOUT" | "ABORTED";
  participants: readonly Readonly<{
    accountId: string;
    username: string;
    outcome: "WON" | "LOST" | "DRAW" | "ABORTED";
    kills: number;
  }>[];
}>;

/** Writes one final or aborted Game Result together with every participant. */
export class GameResultWriter {
  public constructor(private readonly prisma: PrismaClient) {}

  public async record(input: NewGameResult): Promise<DetailedGameResult> {
    validateNewResult(input);

    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.gameResult.create({
        data: {
          status: input.status === "completed" ? "COMPLETED" : "ABORTED",
          roomCode: input.roomCode,
          gameSeed: input.gameSeed,
          mapVersion: input.mapVersion,
          durationMs: input.durationMs,
          ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
          outcomeKind:
            input.status === "completed"
              ? input.outcome.kind === "winner"
                ? "WINNER"
                : "DRAW"
              : null,
          endReason:
            input.status === "completed"
              ? input.outcome.reason === "elimination"
                ? "ELIMINATION"
                : "TIMEOUT"
              : "ABORTED",
          participants: {
            create: input.participants.map((participant) => ({
              accountId: participant.accountId,
              kills: participant.kills,
              outcome: participant.outcome.toUpperCase() as
                "WON" | "LOST" | "DRAW" | "ABORTED",
            })),
          },
        },
        select: detailedResultSelection,
      });
      return toDetailedGameResult(fromPrismaDetailedResult(result));
    });
  }
}

/** Reads participant-scoped details and privacy-safe public aggregate evidence. */
export class GameResultQueryService {
  public constructor(private readonly prisma: PrismaClient) {}

  /** Returns null for both a missing Result and an Account that did not participate. */
  public async getDetailedForAccount(
    accountId: string,
    resultId: string,
  ): Promise<DetailedGameResult | null> {
    const result = await this.prisma.gameResult.findFirst({
      where: {
        id: resultId,
        participants: { some: { accountId } },
      },
      select: detailedResultSelection,
    });
    return result === null
      ? null
      : toDetailedGameResult(fromPrismaDetailedResult(result));
  }

  public async getPublicAggregates(): Promise<PublicGameResultAggregates> {
    return this.prisma.$transaction(async (transaction) => {
      const [completedGames, wins, killTotals, recent] = await Promise.all([
        transaction.gameResult.count({ where: { status: "COMPLETED" } }),
        transaction.gameResultParticipant.count({
          where: {
            outcome: "WON",
            gameResult: { status: "COMPLETED" },
          },
        }),
        transaction.gameResultParticipant.aggregate({
          where: { gameResult: { status: "COMPLETED" } },
          _sum: { kills: true },
        }),
        transaction.gameResult.findMany({
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
        }),
      ]);

      return {
        completedGames,
        wins,
        kills: killTotals._sum.kills ?? 0,
        winRate: completedGames === 0 ? 0 : wins / completedGames,
        recentGames: recent.map(toPublicGameResultSummary),
      };
    });
  }
}

/** Pure authorization predicate for adapters that already loaded a detailed Result. */
export function canAccountReadGameResult(
  accountId: string,
  result: Pick<DetailedGameResult, "participants">,
): boolean {
  return result.participants.some(
    (participant) => participant.accountId === accountId,
  );
}

/** Maps the persistence representation into the stable detailed Result contract. */
export function toDetailedGameResult(
  result: PersistedResult,
): DetailedGameResult {
  const outcome =
    result.status === "ABORTED"
      ? { kind: "aborted" as const }
      : {
          kind: toCompletedOutcomeKind(result.outcomeKind),
          reason: toCompletedReason(result.endReason),
        };
  return {
    id: result.id,
    status: result.status.toLowerCase() as "completed" | "aborted",
    roomCode: result.roomCode,
    gameSeed: result.gameSeed,
    mapVersion: result.mapVersion,
    durationMs: result.durationMs,
    endedAt: result.endedAt,
    outcome,
    participants: result.participants.map((participant) => ({
      accountId: participant.accountId,
      username: participant.username,
      outcome: participant.outcome.toLowerCase() as ResultParticipantOutcome,
      kills: participant.kills,
    })),
  };
}

function toPublicGameResultSummary(result: {
  endedAt: Date;
  durationMs: number;
  outcomeKind: "WINNER" | "DRAW" | null;
  endReason: "ELIMINATION" | "TIMEOUT" | "ABORTED";
  _count: { participants: number };
}): PublicGameResultSummary {
  return {
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    outcome: toCompletedOutcomeKind(result.outcomeKind),
    reason: toCompletedReason(result.endReason),
    participantCount: result._count.participants,
  };
}

function fromPrismaDetailedResult(result: {
  id: string;
  status: "COMPLETED" | "ABORTED";
  roomCode: string;
  gameSeed: number;
  mapVersion: string;
  durationMs: number;
  endedAt: Date;
  outcomeKind: "WINNER" | "DRAW" | null;
  endReason: "ELIMINATION" | "TIMEOUT" | "ABORTED";
  participants: readonly {
    accountId: string;
    outcome: "WON" | "LOST" | "DRAW" | "ABORTED";
    kills: number;
    account: { username: string };
  }[];
}): PersistedResult {
  return {
    ...result,
    participants: result.participants.map((participant) => ({
      accountId: participant.accountId,
      username: participant.account.username,
      outcome: participant.outcome,
      kills: participant.kills,
    })),
  };
}

function validateNewResult(input: NewGameResult): void {
  if (
    !Number.isInteger(input.gameSeed) ||
    input.gameSeed < 0 ||
    input.gameSeed > 4_294_967_295
  ) {
    throw new Error("Game Result gameSeed must be an unsigned 32-bit integer");
  }
  if (
    !Number.isInteger(input.durationMs) ||
    input.durationMs < 0 ||
    input.durationMs > 4_294_967_295
  ) {
    throw new Error(
      "Game Result durationMs must be an unsigned 32-bit integer",
    );
  }
  if (!input.roomCode || input.roomCode.length > 6)
    throw new Error("Game Result roomCode must contain at most six characters");
  if (!input.mapVersion || input.mapVersion.length > 32)
    throw new Error(
      "Game Result mapVersion must contain at most 32 characters",
    );
  if (input.participants.length < 2 || input.participants.length > 4)
    throw new Error("A Game Result needs two to four participants");
  if (
    new Set(input.participants.map((participant) => participant.accountId))
      .size !== input.participants.length
  ) {
    throw new Error("Game Result participants must be distinct Accounts");
  }
  for (const participant of input.participants) {
    if (!participant.accountId)
      throw new Error("Game Result participant Account is required");
    if (!Number.isInteger(participant.kills) || participant.kills < 0)
      throw new Error("Game Result kills must be a non-negative integer");
  }

  if (input.status === "aborted") {
    if (
      input.participants.some(
        (participant) => participant.outcome !== "aborted",
      )
    )
      throw new Error("Aborted Game Result participants must be aborted");
    return;
  }

  if (input.outcome.kind === "winner") {
    const winnerId = input.outcome.playerId;
    const winners = input.participants.filter(
      (participant) => participant.outcome === "won",
    );
    if (
      winners.length !== 1 ||
      winners[0].accountId !== winnerId ||
      input.participants.some(
        (participant) =>
          participant.accountId !== winnerId && participant.outcome !== "lost",
      )
    ) {
      throw new Error(
        "Winner Game Result outcomes must agree with the Game outcome",
      );
    }
    return;
  }
  if (input.participants.some((participant) => participant.outcome !== "draw"))
    throw new Error("Draw Game Result participants must all be draws");
}

function toCompletedOutcomeKind(
  outcomeKind: "WINNER" | "DRAW" | null,
): "winner" | "draw" {
  if (outcomeKind === "WINNER") return "winner";
  if (outcomeKind === "DRAW") return "draw";
  throw new Error("Completed Game Result is missing an outcome kind");
}

function toCompletedReason(
  reason: "ELIMINATION" | "TIMEOUT" | "ABORTED",
): "elimination" | "timeout" {
  if (reason === "ELIMINATION") return "elimination";
  if (reason === "TIMEOUT") return "timeout";
  throw new Error("Completed Game Result cannot have an aborted reason");
}

const detailedResultSelection = {
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
} as const;
