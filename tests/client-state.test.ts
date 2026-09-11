import assert from "node:assert/strict";
import test from "node:test";

import { mergeGameState } from "../public/game-state.js";

test("a blockDestroyed delta removes the Breakable Block from the rendered map", () => {
  const initial = {
    map: {
      version: "arena-v1",
      width: 13,
      height: 11,
      spawns: [],
      breakableBlocks: [
        { x: 3, y: 3 },
        { x: 5, y: 3 },
      ],
    },
    stateVersion: 14,
    elapsedMs: 700,
    phase: "running",
    players: [],
    bombs: [],
    fire: [],
    pickups: [],
    outcome: null,
  };
  const current = mergeGameState(initial, {
    type: "delta",
    payload: {
      delta: {
        stateVersion: 15,
        elapsedMs: 750,
        events: [{ type: "blockDestroyed", cell: { x: 3, y: 3 } }],
        state: {
          elapsedMs: 750,
          phase: "running",
          players: [],
          bombs: [],
          fire: [{ cell: { x: 3, y: 3 }, expiresAtMs: 1_250 }],
          pickups: [],
          outcome: null,
        },
      },
    },
  });

  assert.deepEqual(current?.map.breakableBlocks, [{ x: 5, y: 3 }]);
});
