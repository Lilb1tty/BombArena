import assert from "node:assert/strict";
import test from "node:test";

import {
  createHealthProbes,
  GameAbortCoordinator,
  OperationsMetrics,
  type OperationalLogEntry,
} from "../src/operations/index.js";

test("operational metrics expose connection and tick-delay counters", () => {
  const logs: OperationalLogEntry[] = [];
  const metrics = new OperationsMetrics((entry) => logs.push(entry));

  assert.equal(metrics.connectionOpened(), 1);
  assert.equal(metrics.connectionOpened(), 2);
  assert.equal(metrics.connectionClosed(), 1);
  assert.equal(metrics.connectionClosed(), 0);
  assert.equal(metrics.connectionClosed(), 0);
  metrics.observeTickDelay(0);
  metrics.observeTickDelay(20);
  metrics.observeTickDelay(1_001);

  assert.deepEqual(metrics.snapshot(), {
    activeConnections: 0,
    tickDelay: {
      count: 3,
      delayedCount: 2,
      totalMs: 1_021,
      maxMs: 1_001,
      buckets: [
        { upperBoundMs: 10, count: 1 },
        { upperBoundMs: 50, count: 1 },
        { upperBoundMs: 100, count: 0 },
        { upperBoundMs: 250, count: 0 },
        { upperBoundMs: 500, count: 0 },
        { upperBoundMs: 1_000, count: 0 },
        { upperBoundMs: null, count: 1 },
      ],
    },
  });
  assert.deepEqual(logs.at(-1), {
    level: "info",
    event: "connection_closed",
    fields: { activeConnections: 0 },
  });
  assert.throws(() => metrics.observeTickDelay(-1), /non-negative/);
});

test("health probes make readiness failures observable without an HTTP framework", async () => {
  const probes = createHealthProbes({
    isLive: () => true,
    isReady: async () => false,
  });

  assert.deepEqual(await probes.live(), { ok: true, status: "alive" });
  assert.deepEqual(await probes.ready(), { ok: false, status: "unavailable" });
});

test("abort coordinator carries diagnostic reasons and continues after a failure", async () => {
  const recorded: { gameId: string; reason: string }[] = [];
  const logs: OperationalLogEntry[] = [];
  const coordinator = new GameAbortCoordinator(
    async ({ gameId, reason }) => {
      if (gameId === "game-fail") throw new Error("database unavailable");
      recorded.push({ gameId, reason });
    },
    (entry) => logs.push(entry),
  );

  const shutdown = await coordinator.recordGracefulShutdown([
    { gameId: "game-1", reason: "deployment" },
    { gameId: "game-fail", reason: "deployment" },
    { gameId: "game-1", reason: "duplicate" },
  ]);
  const reconciliation = await coordinator.reconcileStartup([
    { gameId: "game-2", reason: "previous_process_lost" },
  ]);

  assert.deepEqual(recorded, [
    { gameId: "game-1", reason: "deployment" },
    { gameId: "game-2", reason: "previous_process_lost" },
  ]);
  assert.deepEqual(shutdown, {
    recordedGameIds: ["game-1"],
    failedGameIds: ["game-fail"],
  });
  assert.deepEqual(reconciliation, {
    recordedGameIds: ["game-2"],
    failedGameIds: [],
  });
  assert.equal(
    logs.some((entry) => entry.event === "game_abort_record_failed"),
    true,
  );
});
