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
    input: { type: "move", direction: "right" },
  });
  room.tick();

  const reconnected = new FakeSocket();
  assert.deepEqual(
    room.connect(reconnected, "first", {
      stateVersion: initial.snapshot.stateVersion,
    }),
    { type: "state_version_gap", reconnected: true },
  );
  const snapshot = reconnected.message(0);
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.snapshot.stateVersion, 1);
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
  assert.deepEqual(unknown.message(0), {
    version: 1,
    type: "rejected",
    reason: "invalid_identity",
  });

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
    input: { type: "placeBomb" },
  });
  for (let tick = 0; tick < 40; tick += 1) completed.tick();

  const afterGame = new FakeSocket();
  assert.deepEqual(completed.connect(afterGame, "second"), {
    type: "game_completed",
  });
  assert.deepEqual(afterGame.message(0), {
    version: 1,
    type: "rejected",
    reason: "game_completed",
  });
});

test("application ping is explicit and excessive Game Inputs are rejected", () => {
  const room = new AuthoritativeRoom("LIMIT", ["first", "second"], 10, () => 0);
  const socket = new FakeSocket();
  room.connect(socket, "first");

  socket.clientMessage({ version: 1, type: "ping" });
  assert.deepEqual(socket.message(1), { version: 1, type: "pong" });

  for (let index = 0; index < 21; index += 1)
    socket.clientMessage({
      version: 1,
      type: "input",
      input: { type: "move", direction: "right" },
    });

  assert.deepEqual(socket.message(2), {
    version: 1,
    type: "rejected",
    reason: "input_rate_limited",
  });
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
  return snapshotMessage.snapshot.players.find(
    (player: any) => player.id === playerId,
  );
}
