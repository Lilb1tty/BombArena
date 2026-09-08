import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  authenticateLoginSession,
  type AuthenticatedAccount,
  type AuthenticationDependencies,
} from "../auth.js";
import {
  GameEngine,
  TICK_MS,
  type GameDelta,
  type GameInput,
  type GameSnapshot,
} from "../game/engine.js";
import { RoomDirectory, RoomError } from "../rooms/index.js";
import { type OperationsMetrics } from "../operations/index.js";
import { GameResultWriter } from "../results/index.js";

export const REALTIME_PROTOCOL_VERSION = 1;

type RealtimeMessage =
  | Readonly<{ type: "input"; input: GameInput }>
  | Readonly<{ type: "resync" }>
  | Readonly<{ type: "ping" }>;

type RealtimeResponse =
  | Readonly<{
      version: typeof REALTIME_PROTOCOL_VERSION;
      type: "snapshot";
      roomCode: string;
      snapshot: GameSnapshot;
    }>
  | Readonly<{
      version: typeof REALTIME_PROTOCOL_VERSION;
      type: "delta";
      roomCode: string;
      delta: GameDelta;
    }>
  | Readonly<{
      version: typeof REALTIME_PROTOCOL_VERSION;
      type: "rejected";
      reason:
        | "invalid_message"
        | "not_a_player"
        | "invalid_identity"
        | "reconnect_window_expired"
        | "game_completed"
        | "input_rate_limited";
    }>
  | Readonly<{
      version: typeof REALTIME_PROTOCOL_VERSION;
      type: "pong";
    }>;

export const RECONNECT_WINDOW_MS = 60_000;
const MAX_INPUTS_PER_SECOND = 20;
const HEARTBEAT_MS = 30_000;

/** The small WebSocket surface the authoritative game needs. */
export type RealtimeSocket = Readonly<{
  readyState: number;
  send(data: string): void;
  close(): void;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): unknown;
  on(event: "close", listener: () => void): unknown;
}>;

export type ReconnectOutcome =
  | Readonly<{ type: "connected"; reconnected: boolean }>
  | Readonly<{ type: "state_version_gap"; reconnected: true }>
  | Readonly<{ type: "invalid_identity" }>
  | Readonly<{ type: "reconnect_window_expired" }>
  | Readonly<{ type: "game_completed" }>;

type ReconnectRejection = Extract<
  ReconnectOutcome,
  { type: "invalid_identity" | "reconnect_window_expired" | "game_completed" }
>;

export type ReconnectOptions = Readonly<{
  /** State version the client last rendered, if it has one. */
  stateVersion?: number;
}>;

export type RealtimeRuntimeOptions = Readonly<{
  authentication: AuthenticationDependencies;
  rooms?: RoomDirectory;
  createSeed?: () => number;
  now?: () => number;
  metrics?: OperationsMetrics;
  results?: GameResultWriter;
}>;

/** The sole real-time owner for Room countdowns and authoritative Games. */
export class RealtimeRuntime {
  public readonly rooms: RoomDirectory;
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 10 * 1024,
  });
  private readonly games = new Map<string, AuthoritativeRoom>();
  private readonly createSeed: () => number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private nextTickAtMs: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly heartbeatAlive = new Map<WebSocket, boolean>();
  private attached = false;

  public constructor(private readonly options: RealtimeRuntimeOptions) {
    this.rooms = options.rooms ?? new RoomDirectory();
    this.createSeed = options.createSeed ?? defaultSeed;
    this.now = options.now ?? Date.now;
  }

  /** Binds the WebSocket endpoint to the existing HTTP server. */
  public attach(server: Server): void {
    if (this.attached) throw new Error("RealtimeRuntime is already attached");
    this.attached = true;
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    server.once("close", () => this.close());
    this.start();
  }

  /** Advances countdowns and Games exactly once. Useful for deterministic tests. */
  public tick(): void {
    const startedAtMs = this.now();
    if (this.nextTickAtMs !== undefined)
      this.options.metrics?.observeTickDelay(
        Math.max(0, startedAtMs - this.nextTickAtMs),
      );
    this.nextTickAtMs = startedAtMs + TICK_MS;
    for (const room of this.rooms.advance()) {
      const pending = room.pendingGameStart;
      if (pending !== undefined && !this.games.has(room.code)) {
        this.games.set(
          room.code,
          new AuthoritativeRoom(
            room.code,
            pending.playerIds,
            this.createSeed(),
            this.now,
            this.options.results,
          ),
        );
      }
    }
    for (const game of this.games.values()) game.tick();
  }

  public async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.nextTickAtMs = undefined;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatAlive.clear();
    await Promise.all([...this.games.values()].map((game) => game.close()));
    this.games.clear();
    this.webSocketServer.close();
  }

  private start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/realtime") {
        socket.destroy();
        return;
      }
      const account = await authenticateLoginSession(
        this.options.authentication,
        request.headers.cookie,
      );
      if (account === undefined) {
        rejectUpgrade(socket, 401, "authentication_required");
        return;
      }
      const roomCode = url.searchParams.get("roomCode");
      const stateVersion = parseStateVersion(
        url.searchParams.get("stateVersion"),
      );
      if (url.searchParams.has("stateVersion") && stateVersion === undefined) {
        rejectUpgrade(socket, 400, "invalid_state_version");
        return;
      }
      const game = this.findAuthorizedGame(roomCode, account);
      if (game === undefined) {
        rejectUpgrade(socket, 403, "room_access_denied");
        return;
      }
      this.webSocketServer.handleUpgrade(
        request,
        socket,
        head,
        (connection) => {
          this.options.metrics?.connectionOpened();
          connection.once("close", () =>
            this.options.metrics?.connectionClosed(),
          );
          this.monitorHeartbeat(connection);
          game.connect(connection, account.id, { stateVersion });
        },
      );
    } catch {
      rejectUpgrade(socket, 400, "invalid_upgrade");
    }
  }

  private monitorHeartbeat(connection: WebSocket): void {
    this.heartbeatAlive.set(connection, true);
    connection.on("pong", () => this.heartbeatAlive.set(connection, true));
    connection.once("close", () => this.heartbeatAlive.delete(connection));
    connection.once("error", () => this.heartbeatAlive.delete(connection));
  }

  private heartbeat(): void {
    for (const [connection, alive] of this.heartbeatAlive) {
      if (!alive) {
        connection.terminate();
        continue;
      }
      this.heartbeatAlive.set(connection, false);
      connection.ping();
    }
  }

  private findAuthorizedGame(
    roomCode: string | null,
    account: AuthenticatedAccount,
  ): AuthoritativeRoom | undefined {
    if (roomCode === null) return undefined;
    try {
      const room = this.rooms.find(roomCode);
      if (
        room === undefined ||
        !room.snapshot().players.some((player) => player.id === account.id)
      )
        return undefined;
      return this.games.get(room.code);
    } catch (error) {
      if (error instanceof RoomError) return undefined;
      throw error;
    }
  }
}

/** Owns one running Game plus the sockets currently observing it. */
export class AuthoritativeRoom {
  private readonly connections = new Map<RealtimeSocket, string>();
  private readonly disconnectedAtMs = new Map<string, number>();
  private readonly inputTimes = new Map<string, number[]>();
  private readonly engine: GameEngine;
  private resultRecorded = false;

  public constructor(
    private readonly roomCode: string,
    playerIds: readonly string[],
    private readonly seed: number,
    private readonly now: () => number = Date.now,
    private readonly results?: GameResultWriter,
  ) {
    this.engine = new GameEngine({ players: playerIds, seed });
  }

  public tick(): void {
    const delta = this.engine.tick(TICK_MS);
    if (delta.state.outcome !== null)
      this.recordCompletedResult(delta.state.outcome);
    this.broadcast({
      version: REALTIME_PROTOCOL_VERSION,
      type: "delta",
      roomCode: this.roomCode,
      delta,
    });
  }

  /**
   * Attaches an authenticated player's socket. A state-version mismatch still
   * succeeds: the first message is an authoritative snapshot, not a replay.
   */
  public connect(
    connection: RealtimeSocket,
    playerId: string,
    options: ReconnectOptions = {},
  ): ReconnectOutcome {
    if (
      !this.engine.snapshot().players.some((player) => player.id === playerId)
    )
      return this.rejectConnection(connection, "invalid_identity");
    if (this.engine.snapshot().phase === "finished")
      return this.rejectConnection(connection, "game_completed");

    const disconnectedAtMs = this.disconnectedAtMs.get(playerId);
    if (
      disconnectedAtMs !== undefined &&
      this.now() - disconnectedAtMs > RECONNECT_WINDOW_MS
    )
      return this.rejectConnection(connection, "reconnect_window_expired");

    const reconnected = disconnectedAtMs !== undefined;
    this.connections.set(connection, playerId);
    this.disconnectedAtMs.delete(playerId);
    this.sendSnapshot(connection);
    connection.on("message", (data, isBinary) => {
      this.handleMessage(connection, playerId, data, isBinary);
    });
    connection.on("close", () => {
      this.connections.delete(connection);
      this.disconnectedAtMs.set(playerId, this.now());
    });
    if (
      reconnected &&
      options.stateVersion !== this.engine.snapshot().stateVersion
    )
      return { type: "state_version_gap", reconnected: true };
    return { type: "connected", reconnected };
  }

  public async close(): Promise<void> {
    for (const connection of this.connections.keys()) connection.close();
    this.connections.clear();
    if (this.engine.snapshot().phase === "running")
      await this.recordAbortedResult();
  }

  private handleMessage(
    connection: RealtimeSocket,
    playerId: string,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (this.connections.get(connection) !== playerId) return;
    const message = parseRealtimeMessage(data, isBinary);
    if (message === undefined) {
      this.send(connection, {
        version: REALTIME_PROTOCOL_VERSION,
        type: "rejected",
        reason: "invalid_message",
      });
      return;
    }
    if (message.type === "resync") {
      this.sendSnapshot(connection);
      return;
    }
    if (message.type === "ping") {
      this.send(connection, {
        version: REALTIME_PROTOCOL_VERSION,
        type: "pong",
      });
      return;
    }
    if (!this.allowInput(playerId)) {
      this.send(connection, {
        version: REALTIME_PROTOCOL_VERSION,
        type: "rejected",
        reason: "input_rate_limited",
      });
      return;
    }
    if (!this.engine.submit(playerId, message.input)) {
      this.send(connection, {
        version: REALTIME_PROTOCOL_VERSION,
        type: "rejected",
        reason: "not_a_player",
      });
    }
  }

  private sendSnapshot(connection: RealtimeSocket): void {
    this.send(connection, {
      version: REALTIME_PROTOCOL_VERSION,
      type: "snapshot",
      roomCode: this.roomCode,
      snapshot: this.engine.snapshot(),
    });
  }

  private broadcast(message: RealtimeResponse): void {
    for (const connection of this.connections.keys())
      this.send(connection, message);
  }

  private send(connection: RealtimeSocket, message: RealtimeResponse): void {
    if (connection.readyState === WebSocket.OPEN)
      connection.send(JSON.stringify(message));
  }

  private rejectConnection(
    connection: RealtimeSocket,
    reason: ReconnectRejection["type"],
  ): ReconnectRejection {
    this.send(connection, {
      version: REALTIME_PROTOCOL_VERSION,
      type: "rejected",
      reason,
    });
    connection.close();
    return { type: reason };
  }

  private allowInput(playerId: string): boolean {
    const cutoff = this.now() - 1_000;
    const recent = (this.inputTimes.get(playerId) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= MAX_INPUTS_PER_SECOND) return false;
    recent.push(this.now());
    this.inputTimes.set(playerId, recent);
    return true;
  }

  private recordCompletedResult(
    outcome: NonNullable<GameSnapshot["outcome"]>,
  ): void {
    if (this.resultRecorded || this.results === undefined) return;
    this.resultRecorded = true;
    const snapshot = this.engine.snapshot();
    void this.results
      .record({
        status: "completed",
        roomCode: this.roomCode,
        gameSeed: this.seed,
        mapVersion: `arena-v${snapshot.map.version}`,
        durationMs: snapshot.elapsedMs,
        outcome,
        participants: snapshot.players.map((player) => ({
          accountId: player.id,
          kills: 0,
          outcome:
            outcome.kind === "draw"
              ? "draw"
              : player.id === outcome.playerId
                ? "won"
                : "lost",
        })),
      })
      .catch(() => undefined);
  }

  private async recordAbortedResult(): Promise<void> {
    if (this.resultRecorded || this.results === undefined) return;
    this.resultRecorded = true;
    const snapshot = this.engine.snapshot();
    await this.results.record({
      status: "aborted",
      roomCode: this.roomCode,
      gameSeed: this.seed,
      mapVersion: `arena-v${snapshot.map.version}`,
      durationMs: snapshot.elapsedMs,
      participants: snapshot.players.map((player) => ({
        accountId: player.id,
        kills: 0,
        outcome: "aborted",
      })),
    });
  }
}

function parseRealtimeMessage(
  data: RawData,
  isBinary: boolean,
): RealtimeMessage | undefined {
  if (isBinary) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(rawDataToString(data));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== REALTIME_PROTOCOL_VERSION)
    return undefined;
  if (value.type === "resync" && hasOnlyKeys(value, ["version", "type"]))
    return { type: "resync" };
  if (value.type === "ping" && hasOnlyKeys(value, ["version", "type"]))
    return { type: "ping" };
  if (
    value.type !== "input" ||
    !hasOnlyKeys(value, ["version", "type", "input"])
  )
    return undefined;
  const input = parseGameInput(value.input);
  return input === undefined ? undefined : { type: "input", input };
}

function parseGameInput(value: unknown): GameInput | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "move" &&
    hasOnlyKeys(value, ["type", "direction"]) &&
    (value.direction === "up" ||
      value.direction === "down" ||
      value.direction === "left" ||
      value.direction === "right")
  )
    return { type: "move", direction: value.direction };
  if (value.type === "placeBomb" && hasOnlyKeys(value, ["type"]))
    return { type: "placeBomb" };
  return undefined;
}

function parseStateVersion(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : undefined;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const supplied = Object.keys(value);
  return (
    supplied.length === keys.length &&
    supplied.every((key) => keys.includes(key))
  );
}

function rejectUpgrade(socket: Duplex, status: number, error: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${error}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error })}`,
  );
}

function defaultSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}
