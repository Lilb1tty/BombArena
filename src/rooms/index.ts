import { randomBytes } from "node:crypto";

export const ROOM_CAPACITY = 4;
export const ROOM_COUNTDOWN_MS = 3_000;
export const CHARACTER_IDS = ["spark", "volt", "moss", "rose"] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

export type RoomPhase = "waiting" | "countdown" | "started";
export type Clock = () => number;
export type RoomPlayer = Readonly<{
  id: string;
  ready: boolean;
  character?: CharacterId;
}>;
export type PendingGameStart = Readonly<{
  roomCode: string;
  playerIds: readonly string[];
}>;
export type RoomSnapshot = Readonly<{
  code: string;
  creatorId: string;
  phase: RoomPhase;
  players: readonly RoomPlayer[];
  countdownEndsAtMs?: number;
  pendingGameStart?: PendingGameStart;
}>;

export type RoomErrorCode =
  | "invalid_player"
  | "invalid_room_code"
  | "room_not_found"
  | "duplicate_player"
  | "room_full"
  | "room_started"
  | "not_a_player"
  | "invalid_character"
  | "character_taken"
  | "character_required";

export class RoomError extends Error {
  public constructor(public readonly code: RoomErrorCode) {
    super(code);
    this.name = "RoomError";
  }
}

export class Room {
  private readonly players = new Map<
    string,
    { ready: boolean; character?: CharacterId }
  >();
  private phase: RoomPhase = "waiting";
  private countdownEndsAtMs: number | undefined;
  private pendingGameStart: PendingGameStart | undefined;

  public constructor(
    public readonly code: string,
    public readonly creatorId: string,
    private readonly clock: Clock,
  ) {
    assertPlayerId(creatorId);
    this.players.set(creatorId, { ready: false });
  }

  public join(playerId: string): RoomSnapshot {
    this.reconcile();
    this.assertNotStarted();
    assertPlayerId(playerId);
    if (this.players.has(playerId)) throw new RoomError("duplicate_player");
    if (this.players.size === ROOM_CAPACITY) throw new RoomError("room_full");
    this.players.set(playerId, { ready: false });
    this.reconcile(true);
    return this.snapshot();
  }

  public setReady(playerId: string, ready: boolean): RoomSnapshot {
    this.reconcile();
    this.assertNotStarted();
    if (!this.players.has(playerId)) throw new RoomError("not_a_player");
    const player = this.players.get(playerId)!;
    if (ready && player.character === undefined)
      throw new RoomError("character_required");
    if (player.ready === ready) return this.snapshot();
    player.ready = ready;
    this.reconcile(true);
    return this.snapshot();
  }

  public selectCharacter(
    playerId: string,
    character: CharacterId,
  ): RoomSnapshot {
    this.reconcile();
    this.assertNotStarted();
    if (!this.players.has(playerId)) throw new RoomError("not_a_player");
    if (!CHARACTER_IDS.includes(character))
      throw new RoomError("invalid_character");
    if (
      [...this.players.entries()].some(
        ([id, player]) => id !== playerId && player.character === character,
      )
    )
      throw new RoomError("character_taken");
    const player = this.players.get(playerId)!;
    player.character = character;
    player.ready = false;
    this.reconcile(true);
    return this.snapshot();
  }

  public leave(playerId: string): RoomSnapshot {
    this.reconcile();
    this.assertNotStarted();
    if (!this.players.delete(playerId)) throw new RoomError("not_a_player");
    this.reconcile(true);
    return this.snapshot();
  }

  public advance(): RoomSnapshot {
    return this.snapshot();
  }

  public snapshot(): RoomSnapshot {
    this.reconcile();
    return {
      code: this.code,
      creatorId: this.creatorId,
      phase: this.phase,
      players: [...this.players].map(([id, player]) => ({
        id,
        ready: player.ready,
        ...(player.character === undefined
          ? {}
          : { character: player.character }),
      })),
      ...(this.countdownEndsAtMs === undefined
        ? {}
        : { countdownEndsAtMs: this.countdownEndsAtMs }),
      ...(this.pendingGameStart === undefined
        ? {}
        : { pendingGameStart: this.pendingGameStart }),
    };
  }

  private reconcile(restartCountdown = false): void {
    if (this.phase === "started") return;
    const eligible =
      this.players.size >= 2 &&
      [...this.players.values()].every((player) => player.ready);
    if (!eligible) {
      this.phase = "waiting";
      this.countdownEndsAtMs = undefined;
      return;
    }
    if (this.phase === "waiting" || restartCountdown) {
      this.phase = "countdown";
      this.countdownEndsAtMs = this.clock() + ROOM_COUNTDOWN_MS;
      return;
    }
    if (this.clock() >= this.countdownEndsAtMs!) {
      this.phase = "started";
      this.pendingGameStart = {
        roomCode: this.code,
        playerIds: [...this.players.keys()],
      };
      this.countdownEndsAtMs = undefined;
    }
  }

  private assertNotStarted(): void {
    if (this.phase === "started") throw new RoomError("room_started");
  }
}

export type RoomDirectoryOptions = Readonly<{
  clock?: Clock;
  createRoomCode?: () => string;
}>;

export class RoomDirectory {
  private readonly rooms = new Map<string, Room>();
  private readonly clock: Clock;
  private readonly createRoomCode: () => string;

  public constructor(options: RoomDirectoryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.createRoomCode = options.createRoomCode ?? defaultRoomCode;
  }

  public create(creatorId: string): Room {
    assertPlayerId(creatorId);
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const code = normalizeRoomCode(this.createRoomCode());
      if (this.rooms.has(code)) continue;
      const room = new Room(code, creatorId, this.clock);
      this.rooms.set(code, room);
      return room;
    }
    throw new Error("Could not allocate a Room Code");
  }

  public find(code: string): Room | undefined {
    return this.rooms.get(normalizeRoomCode(code));
  }

  public join(code: string, playerId: string): Room {
    const room = this.find(code);
    if (room === undefined) throw new RoomError("room_not_found");
    room.join(playerId);
    return room;
  }

  public advance(): readonly RoomSnapshot[] {
    return [...this.rooms.values()].map((room) => room.advance());
  }
}

function assertPlayerId(playerId: string): void {
  if (typeof playerId !== "string" || playerId.trim() === "")
    throw new RoomError("invalid_player");
}

function normalizeRoomCode(code: string): string {
  if (typeof code !== "string") throw new RoomError("invalid_room_code");
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(normalized))
    throw new RoomError("invalid_room_code");
  return normalized;
}

function defaultRoomCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}
