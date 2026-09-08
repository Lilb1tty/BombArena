import assert from "node:assert/strict";
import test from "node:test";

import { WebSocket, type RawData } from "ws";

import {
  AuthoritativeRoom,
  RECONNECT_WINDOW_MS,
  type RealtimeSocket,
} from "../src/realtime/index.js";

test("a same-account reconnect receives a fresh snapshot before later deltas", () => {
  let now = 1_000;
  const room = new AuthoritativeRoom(
    "ABCDE",
    ["first", "second"],
    7,
    () => now,
  );
  const first = new FakeSocket();

  assert.deepEqual(room.connect(first, "first"), {
    type: "connected",
    reconnected: false,
  });
  const initial = first.message(0);
  assert.equal(initial.type, "snapshot");

  first.disconnect();
  first.clientMessage({
    version: 1,
    type: "input",
    requestId: "move-after-close",
    payload: { type: "move", direction: "right" },
  });
  room.tick();

  const reconnected = new FakeSocket();
  assert.deepEqual(
    room.connect(reconnected, "first", {
      stateVersion: initial.payload.snapshot.stateVersion,
    }),
    { type: "state_version_gap", reconnected: true },
  );
  const snapshot = reconnected.message(0);
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.payload.snapshot.stateVersion, 1);
  assert.deepEqual(
    player(snapshot, "first").cell,
    player(initial, "first").cell,
    "a disconnected socket cannot queue an input",
  );

  room.tick();
  assert.equal(reconnected.message(1).type, "delta");
});

test("reconnect exposes identity, expiry, and completed-game outcomes", () => {
  let now = 2_000;
  const room = new AuthoritativeRoom(
    "ABCDE",
    ["first", "second"],
    8,
    () => now,
  );

  const unknown = new FakeSocket();
  assert.deepEqual(room.connect(unknown, "other"), {
    type: "invalid_identity",
  });
  assert.equal(unknown.message(0).type, "rejected");
  assert.equal(typeof unknown.message(0).requestId, "string");
  assert.deepEqual(unknown.message(0).payload, { reason: "invalid_identity" });

  const first = new FakeSocket();
  room.connect(first, "first");
  first.disconnect();
  now += RECONNECT_WINDOW_MS + 1;
  const expired = new FakeSocket();
  assert.deepEqual(room.connect(expired, "first"), {
    type: "reconnect_window_expired",
  });

  const completed = new AuthoritativeRoom("FGHIJ", ["first", "second"], 9);
  const player = new FakeSocket();
  completed.connect(player, "first");
  player.clientMessage({
    version: 1,
    type: "input",
    requestId: "place-bomb",
    payload: { type: "placeBomb" },
  });
  for (let tick = 0; tick < 40; tick += 1) completed.tick();

  const afterGame = new FakeSocket();
  assert.deepEqual(completed.connect(afterGame, "second"), {
    type: "game_completed",
  });
  assert.equal(afterGame.message(0).type, "rejected");
  assert.equal(typeof afterGame.message(0).requestId, "string");
  assert.deepEqual(afterGame.message(0).payload, { reason: "game_completed" });
});

test("application ping and accepted Game Inputs renew the Login Session", () => {
  const room = new AuthoritativeRoom("LIMIT", ["first", "second"], 10, () => 0);
  const socket = new FakeSocket();
  let renewed = 0;
  room.connect(socket, "first", {}, () => {
    renewed += 1;
  });

  socket.clientMessage({
    version: 1,
    type: "ping",
    requestId: "ping-1",
    payload: {},
  });
  assert.deepEqual(socket.message(1), {
    version: 1,
    type: "pong",
    requestId: "ping-1",
    payload: {},
  });

  socket.clientMessage({
    version: 1,
    type: "input",
    requestId: "move-1",
    payload: { type: "move", direction: "right" },
  });
  assert.equal(renewed, 2);
});

test("excessive Game Inputs are rejected with their request ID", () => {
  const room = new AuthoritativeRoom("LIMIT", ["first", "second"], 10, () => 0);
  const socket = new FakeSocket();
  room.connect(socket, "first");

  for (let index = 0; index < 21; index += 1)
    socket.clientMessage({
      version: 1,
      type: "input",
      requestId: `move-${index}`,
      payload: { type: "move", direction: "right" },
    });

  assert.deepEqual(socket.message(1), {
    version: 1,
    type: "rejected",
    requestId: "move-20",
    payload: { reason: "input_rate_limited" },
  });
});

test("a failed completed Result remains pending until it is recorded", async () => {
  let attempts = 0;
  const room = new AuthoritativeRoom(
    "RESULT",
    ["first", "second"],
    9,
    Date.now,
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database unavailable");
    },
  );
  const player = new FakeSocket();
  room.connect(player, "first");
  player.clientMessage({
    version: 1,
    type: "input",
    requestId: "place-bomb",
    payload: { type: "placeBomb" },
  });
  for (let tick = 0; tick < 40; tick += 1) room.tick();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  await room.close();
  assert.equal(attempts, 2);
});

test("a completed Game Result is recorded only once after later Ticks", async () => {
  let writes = 0;
  const room = new AuthoritativeRoom(
    "ONCE",
    ["first", "second"],
    10,
    Date.now,
    async () => {
      writes += 1;
    },
  );
  const player = new FakeSocket();
  room.connect(player, "first");
  player.clientMessage({
    version: 1,
    type: "input",
    requestId: "place-bomb",
    payload: { type: "placeBomb" },
  });
  for (let tick = 0; tick < 42; tick += 1) room.tick();
  await new Promise((resolve) => setImmediate(resolve));
  room.tick();
  room.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes, 1);
});

class FakeSocket implements RealtimeSocket {
  public readyState = WebSocket.OPEN;
  private readonly messages: unknown[] = [];
  private messageListener:
    ((data: RawData, isBinary: boolean) => void) | undefined;
  private closeListener: (() => void) | undefined;

  public on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): this;
  public on(event: "close", listener: () => void): this;
  public on(
    event: "message" | "close",
    listener: ((data: RawData, isBinary: boolean) => void) | (() => void),
  ): this {
    if (event === "message")
      this.messageListener = listener as (
        data: RawData,
        isBinary: boolean,
      ) => void;
    else this.closeListener = listener as () => void;
    return this;
  }

  public send(data: string): void {
    this.messages.push(JSON.parse(data));
  }

  public close(): void {
    this.readyState = WebSocket.CLOSED;
    this.disconnect();
  }

  public disconnect(): void {
    this.closeListener?.();
  }

  public clientMessage(value: unknown): void {
    this.messageListener?.(Buffer.from(JSON.stringify(value)), false);
  }

  public message(index: number): any {
    return this.messages[index];
  }
}

function player(snapshotMessage: any, playerId: string): any {
  return snapshotMessage.payload.snapshot.players.find(
    (player: any) => player.id === playerId,
  );
}
