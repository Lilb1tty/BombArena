import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createApp } from "../src/app.js";
import {
  LOGIN_SESSION_COOKIE,
  type AuthenticationDependencies,
} from "../src/auth.js";
import { type GameResultQueryService } from "../src/results/index.js";

test("Game Result HTTP routes scope detail to the authenticated Account", async () => {
  const authentication = {
    redis: {
      get: async () => "participant",
      expire: async () => 1,
    },
    prisma: {
      account: {
        findUnique: async () => ({ id: "participant", username: "player" }),
      },
    },
  } as unknown as AuthenticationDependencies;
  const results = {
    getDetailedForAccount: async (accountId: string, resultId: string) =>
      accountId === "participant" && resultId === "known"
        ? { id: "known", participants: [] }
        : null,
    getPublicAggregates: async () => ({
      completedGames: 1,
      wins: 1,
      kills: 2,
      winRate: 1,
      recentGames: [],
    }),
  } as unknown as GameResultQueryService;
  const server = createApp({ authentication, results }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const publicResult = await fetch(`${baseUrl}/public/game-results`);
    assert.deepEqual(await publicResult.json(), {
      aggregates: {
        completedGames: 1,
        wins: 1,
        kills: 2,
        winRate: 1,
        recentGames: [],
      },
    });

    assert.equal((await fetch(`${baseUrl}/game-results/known`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/game-results/known`, {
          headers: { Cookie: `${LOGIN_SESSION_COOKIE}=${"a".repeat(43)}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/game-results/missing`, {
          headers: { Cookie: `${LOGIN_SESSION_COOKIE}=${"a".repeat(43)}` },
        })
      ).status,
      404,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
