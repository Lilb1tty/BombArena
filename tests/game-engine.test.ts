import assert from "node:assert/strict";
import test from "node:test";

import { GameEngine } from "../src/game/index.js";

const player = (engine: GameEngine, id: string) => {
  const found = engine.snapshot().players.find((entry) => entry.id === id);
  assert.ok(found, `expected Player ${id}`);
  return found;
};

test("publishes the versioned 13x11 map and four clear corner spawns", () => {
  const engine = new GameEngine({ players: ["a", "b", "c", "d"], seed: 4 });
  const state = engine.snapshot();

  assert.deepEqual(state.map, {
    version: "arena-v1",
    width: 13,
    height: 11,
    spawns: [
      { x: 1, y: 1 },
      { x: 11, y: 1 },
      { x: 1, y: 9 },
      { x: 11, y: 9 },
    ],
    breakableBlocks: state.map.breakableBlocks,
  });
  assert.equal(
    new Set(state.map.breakableBlocks.map(({ x, y }) => `${x},${y}`)).size,
    state.map.breakableBlocks.length,
  );
  assert.deepEqual(
    state.players.map((entry) => entry.cell),
    state.map.spawns,
  );
});

test("resolves queued inputs in order and limits each Player to one movement and bomb per Tick", () => {
  const engine = new GameEngine({ players: ["a", "b"], seed: 8 });
  engine.submit("a", { type: "move", direction: "right" });
  engine.submit("a", { type: "move", direction: "left" });
  engine.submit("a", { type: "placeBomb" });
  engine.submit("a", { type: "placeBomb" });

  const delta = engine.tick();

  assert.deepEqual(player(engine, "a").cell, { x: 2, y: 1 });
  assert.equal(player(engine, "a").availableBombs, 0);
  assert.equal(delta.stateVersion, 1);
  assert.deepEqual(
    delta.events
      .filter((event) => event.type === "inputRejected")
      .map((event) => event.reason),
    ["action_limit", "action_limit"],
  );
  assert.equal(engine.snapshot().bombs.length, 1);
});

test("bomb fire includes its origin and lasts 500 ms", () => {
  const engine = new GameEngine({ players: ["a", "b"], seed: 1 });
  for (let index = 0; index < 3; index += 1) {
    engine.submit("a", { type: "move", direction: "right" });
    engine.tick();
  }
  engine.submit("a", { type: "placeBomb" });
  engine.tick();
  for (let index = 0; index < 3; index += 1) {
    engine.submit("a", { type: "move", direction: "left" });
    engine.tick();
  }
  const detonation = engine.tick(1_800);

  assert.ok(
    detonation.events.some(
      (event) =>
        event.type === "bombDetonated" &&
        event.cells.some((cell) => cell.x === 4 && cell.y === 1),
    ),
  );
  assert.ok(
    engine
      .snapshot()
      .fire.some((flame) => flame.cell.x === 4 && flame.cell.y === 1),
  );
  assert.equal(player(engine, "a").alive, true);
  engine.tick(500);
  assert.equal(engine.snapshot().fire.length, 0);
});

test("a blast stops at a Breakable Block and removes it", () => {
  const engine = new GameEngine({ players: ["a", "b"], seed: 1 });
  engine.submit("a", { type: "move", direction: "right" });
  engine.tick();
  engine.submit("a", { type: "move", direction: "right" });
  engine.tick();
  engine.submit("a", { type: "move", direction: "down" });
  engine.tick();
  engine.submit("a", { type: "placeBomb" });
  const delta = engine.tick(2_000);

  const blast = delta.events.find((event) => event.type === "bombDetonated");
  assert.ok(blast && blast.type === "bombDetonated");
  assert.ok(blast.cells.some((cell) => cell.x === 3 && cell.y === 3));
  assert.ok(!blast.cells.some((cell) => cell.x === 3 && cell.y === 4));
  assert.ok(
    delta.events.some(
      (event) =>
        event.type === "blockDestroyed" &&
        event.cell.x === 3 &&
        event.cell.y === 3,
    ),
  );
});

test("fuses chain active bombs and pickup attempts are reproducible from the Game Seed", () => {
  const run = () => {
    const engine = new GameEngine({ players: ["a", "b"], seed: 42 });
    for (let index = 0; index < 3; index += 1) {
      engine.submit("a", { type: "move", direction: "right" });
      engine.submit("b", { type: "move", direction: "left" });
      engine.tick();
    }
    engine.submit("b", { type: "move", direction: "left" });
    engine.tick();
    engine.submit("a", { type: "placeBomb" });
    engine.tick();
    engine.submit("b", { type: "move", direction: "left" });
    engine.tick();
    engine.submit("b", { type: "placeBomb" });
    engine.tick();
    for (let index = 0; index < 3; index += 1) {
      engine.submit("a", { type: "move", direction: "left" });
      engine.submit("b", { type: "move", direction: "right" });
      engine.tick();
    }
    const chain = engine.tick(1_800);
    const pickup = engine.tick(7_800);
    return { chain, pickup, state: engine.snapshot() };
  };
  const first = run();
  const second = run();

  assert.deepEqual(first, second);
  assert.equal(
    first.chain.events.filter((event) => event.type === "bombDetonated").length,
    2,
  );
  assert.ok(
    first.pickup.events.some((event) => event.type === "pickupAttempt"),
  );
  assert.ok(first.state.pickups.length <= 2);
});

test("a sole survivor wins and the clock ends unresolved Games as a timeout draw", () => {
  const winner = new GameEngine({ players: ["a", "b"], seed: 3 });
  winner.submit("a", { type: "move", direction: "right" });
  winner.tick();
  winner.submit("a", { type: "placeBomb" });
  winner.tick(2_000);
  assert.deepEqual(winner.snapshot().outcome, {
    kind: "winner",
    playerId: "b",
    reason: "elimination",
  });

  const timeout = new GameEngine({ players: ["a", "b"], seed: 3 });
  timeout.tick(180_000);
  assert.deepEqual(timeout.snapshot().outcome, {
    kind: "draw",
    reason: "timeout",
  });
});
