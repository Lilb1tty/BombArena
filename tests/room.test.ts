import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOM_COUNTDOWN_MS,
  RoomDirectory,
  RoomError,
} from "../src/rooms/index.js";

const clock = () => {
  let now = 0;
  return {
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

test("a creator automatically joins a Room with a shareable Room Code", () => {
  const rooms = new RoomDirectory({ createRoomCode: () => "ARENA1" });
  const room = rooms.create("creator");

  assert.deepEqual(room.snapshot(), {
    code: "ARENA1",
    creatorId: "creator",
    phase: "waiting",
    players: [{ id: "creator", ready: false }],
  });
  assert.equal(rooms.find("arena1"), room);
});

test("rejects invalid, duplicate, full, and started Room joins", () => {
  const rooms = new RoomDirectory({ createRoomCode: () => "ARENA2" });
  const room = rooms.create("one");

  assert.throws(
    () => rooms.join("bad", "two"),
    (error: unknown) =>
      error instanceof RoomError && error.code === "invalid_room_code",
  );
  assert.throws(
    () => rooms.join("MISSNG", "two"),
    (error: unknown) =>
      error instanceof RoomError && error.code === "room_not_found",
  );
  assert.throws(
    () => room.join("one"),
    (error: unknown) =>
      error instanceof RoomError && error.code === "duplicate_player",
  );
  room.join("two");
  room.join("three");
  room.join("four");
  assert.throws(
    () => room.join("five"),
    (error: unknown) =>
      error instanceof RoomError && error.code === "room_full",
  );
});

test("ready, unready, and leaving recompute the countdown", () => {
  const time = clock();
  const room = new RoomDirectory({
    clock: time.now,
    createRoomCode: () => "ARENA3",
  }).create("one");
  room.join("two");
  room.selectCharacter("one", "spark");
  room.selectCharacter("two", "volt");
  room.setReady("one", true);
  room.setReady("two", true);
  const countdown = room.snapshot();
  assert.equal(countdown.phase, "countdown");
  assert.equal(countdown.countdownEndsAtMs, ROOM_COUNTDOWN_MS);

  room.setReady("two", false);
  assert.equal(room.snapshot().phase, "waiting");
  room.setReady("two", true);
  room.leave("two");
  assert.equal(room.snapshot().phase, "waiting");

  room.join("two");
  room.join("three");
  room.selectCharacter("two", "volt");
  room.selectCharacter("three", "moss");
  room.setReady("two", true);
  room.setReady("three", true);
  time.advance(1_000);
  room.leave("three");
  assert.equal(
    room.snapshot().countdownEndsAtMs,
    time.now() + ROOM_COUNTDOWN_MS,
  );
});

test("the eligible countdown locks the Room and exposes a pending Game start", () => {
  const time = clock();
  const room = new RoomDirectory({
    clock: time.now,
    createRoomCode: () => "ARENA4",
  }).create("one");
  room.join("two");
  room.selectCharacter("one", "spark");
  room.selectCharacter("two", "volt");
  room.setReady("one", true);
  room.setReady("two", true);
  time.advance(ROOM_COUNTDOWN_MS - 1);
  assert.equal(room.advance().phase, "countdown");
  time.advance(1);

  assert.deepEqual(room.advance(), {
    code: "ARENA4",
    creatorId: "one",
    phase: "started",
    players: [
      { id: "one", ready: true, character: "spark" },
      { id: "two", ready: true, character: "volt" },
    ],
    pendingGameStart: { roomCode: "ARENA4", playerIds: ["one", "two"] },
  });
  assert.throws(
    () => room.setReady("one", false),
    (error: unknown) =>
      error instanceof RoomError && error.code === "room_started",
  );
  assert.throws(
    () => room.leave("two"),
    (error: unknown) =>
      error instanceof RoomError && error.code === "room_started",
  );
});

test("each Player must claim an available character before readying", () => {
  const room = new RoomDirectory({ createRoomCode: () => "ARENA5" }).create(
    "one",
  );
  room.join("two");
  assert.throws(
    () => room.setReady("one", true),
    (error: unknown) =>
      error instanceof RoomError && error.code === "character_required",
  );
  room.selectCharacter("one", "spark");
  assert.throws(
    () => room.selectCharacter("two", "spark"),
    (error: unknown) =>
      error instanceof RoomError && error.code === "character_taken",
  );
  room.selectCharacter("two", "volt");
  assert.equal(room.snapshot().players[1].character, "volt");
});
