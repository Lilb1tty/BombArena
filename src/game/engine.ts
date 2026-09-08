import {
  BLAST_RANGE,
  BREAKABLE_BLOCKS,
  cellKey,
  Cell,
  isInBounds,
  isWall,
  MAP_HEIGHT,
  MAP_VERSION,
  MAP_WIDTH,
  PICKUP_CANDIDATES,
  SPAWNS,
} from "./map.js";

export type Direction = "up" | "down" | "left" | "right";
export type GameInput =
  | Readonly<{ type: "move"; direction: Direction }>
  | Readonly<{ type: "placeBomb" }>;
export type InputRejection =
  | "game_finished"
  | "player_dead"
  | "action_limit"
  | "blocked"
  | "occupied"
  | "no_available_bomb"
  | "active_bomb_limit";
export type GameOutcome =
  | Readonly<{
      kind: "winner";
      playerId: string;
      reason: "elimination" | "timeout";
    }>
  | Readonly<{ kind: "draw"; reason: "elimination" | "timeout" }>;

export type GameEvent =
  | Readonly<{
      type: "inputRejected";
      playerId: string;
      input: GameInput;
      reason: InputRejection;
    }>
  | Readonly<{ type: "moved"; playerId: string; from: Cell; to: Cell }>
  | Readonly<{
      type: "bombPlaced";
      bombId: string;
      playerId: string;
      cell: Cell;
    }>
  | Readonly<{ type: "bombDetonated"; bombId: string; cells: readonly Cell[] }>
  | Readonly<{ type: "blockDestroyed"; cell: Cell }>
  | Readonly<{ type: "playerEliminated"; playerId: string }>
  | Readonly<{ type: "pickupAttempt"; cell: Cell | null; placed: boolean }>
  | Readonly<{ type: "pickupCollected"; playerId: string; cell: Cell }>
  | Readonly<{ type: "gameFinished"; outcome: GameOutcome }>;

export type PlayerState = Readonly<{
  id: string;
  cell: Cell;
  alive: boolean;
  availableBombs: number;
  activeBombs: number;
}>;
export type BombState = Readonly<{
  id: string;
  playerId: string;
  cell: Cell;
  detonatesAtMs: number;
}>;
export type FireState = Readonly<{ cell: Cell; expiresAtMs: number }>;
export type GameSnapshot = Readonly<{
  map: Readonly<{
    version: typeof MAP_VERSION;
    width: typeof MAP_WIDTH;
    height: typeof MAP_HEIGHT;
    spawns: readonly Cell[];
    breakableBlocks: readonly Cell[];
  }>;
  stateVersion: number;
  elapsedMs: number;
  phase: "running" | "finished";
  players: readonly PlayerState[];
  bombs: readonly BombState[];
  fire: readonly FireState[];
  pickups: readonly Cell[];
  outcome: GameOutcome | null;
}>;
export type GameDelta = Readonly<{
  stateVersion: number;
  elapsedMs: number;
  events: readonly GameEvent[];
  state: Omit<GameSnapshot, "map" | "stateVersion">;
}>;
export type GameEngineOptions = Readonly<{
  players: readonly string[];
  seed: number;
}>;

type MutablePlayer = {
  id: string;
  cell: Cell;
  alive: boolean;
  availableBombs: number;
  nextRechargeAtMs: number;
};
type MutableBomb = {
  id: string;
  playerId: string;
  cell: Cell;
  detonatesAtMs: number;
};
type MutableFire = { cell: Cell; expiresAtMs: number };
type QueuedInput = { playerId: string; input: GameInput };

export const TICK_MS = 50;
export const BOMB_FUSE_MS = 2_000;
export const FIRE_MS = 500;
export const BOMB_RECHARGE_MS = 10_000;
export const PICKUP_ATTEMPT_MS = 10_000;
export const GAME_TIMEOUT_MS = 180_000;
const directions: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const copyCell = (cell: Cell): Cell => ({ x: cell.x, y: cell.y });

/** A pure, clock-driven owner for one authoritative Game. */
export class GameEngine {
  private readonly players = new Map<string, MutablePlayer>();
  private readonly blocks = new Set(BREAKABLE_BLOCKS.map(cellKey));
  private readonly bombs = new Map<string, MutableBomb>();
  private readonly fire = new Map<string, MutableFire>();
  private readonly pickups = new Set<string>();
  private readonly queue: QueuedInput[] = [];
  private readonly random: () => number;
  private elapsedMs = 0;
  private stateVersion = 0;
  private nextPickupAttemptAtMs = PICKUP_ATTEMPT_MS;
  private bombNumber = 0;
  private phase: "running" | "finished" = "running";
  private outcome: GameOutcome | null = null;

  public constructor(options: GameEngineOptions) {
    if (
      options.players.length < 2 ||
      options.players.length > 4 ||
      new Set(options.players).size !== options.players.length
    ) {
      throw new Error("A Game needs two to four distinct Players");
    }
    options.players.forEach((id, index) =>
      this.players.set(id, {
        id,
        cell: copyCell(SPAWNS[index]),
        alive: true,
        availableBombs: 1,
        nextRechargeAtMs: BOMB_RECHARGE_MS,
      }),
    );
    this.random = seededRandom(options.seed);
  }

  /** Queues a validated Game Input. Inputs are resolved in this call order on the next Tick. */
  public submit(playerId: string, input: GameInput): boolean {
    if (!this.players.has(playerId)) return false;
    this.queue.push({ playerId, input });
    return true;
  }

  /** Advances the fixed simulation; production callers use the default 50 ms (20 TPS). */
  public tick(elapsedMs = TICK_MS): GameDelta {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
      throw new Error("Tick duration must be a non-negative finite number");
    const events: GameEvent[] = [];
    this.resolveInputs(events);
    this.eliminatePlayersInFire(events);
    this.advanceTo(this.elapsedMs + elapsedMs, events);
    this.stateVersion += 1;
    const snapshot = this.snapshot();
    const { map: _map, stateVersion: _stateVersion, ...state } = snapshot;
    return {
      stateVersion: this.stateVersion,
      elapsedMs: this.elapsedMs,
      events,
      state,
    };
  }

  public snapshot(): GameSnapshot {
    const activeBombs = new Map<string, number>();
    for (const bomb of this.bombs.values())
      activeBombs.set(bomb.playerId, (activeBombs.get(bomb.playerId) ?? 0) + 1);
    return {
      map: {
        version: MAP_VERSION,
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        spawns: SPAWNS.map(copyCell),
        breakableBlocks: [...this.blocks].map(parseCell).sort(compareCells),
      },
      stateVersion: this.stateVersion,
      elapsedMs: this.elapsedMs,
      phase: this.phase,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        cell: copyCell(player.cell),
        alive: player.alive,
        availableBombs: player.availableBombs,
        activeBombs: activeBombs.get(player.id) ?? 0,
      })),
      bombs: [...this.bombs.values()]
        .map((bomb) => ({ ...bomb, cell: copyCell(bomb.cell) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      fire: [...this.fire.values()]
        .map((flame) => ({
          cell: copyCell(flame.cell),
          expiresAtMs: flame.expiresAtMs,
        }))
        .sort((a, b) => compareCells(a.cell, b.cell)),
      pickups: [...this.pickups].map(parseCell).sort(compareCells),
      outcome: this.outcome,
    };
  }

  private resolveInputs(events: GameEvent[]): void {
    const moved = new Set<string>();
    const placed = new Set<string>();
    while (this.queue.length > 0) {
      const { playerId, input } = this.queue.shift()!;
      const player = this.players.get(playerId)!;
      if (this.phase === "finished") {
        events.push({
          type: "inputRejected",
          playerId,
          input,
          reason: "game_finished",
        });
        continue;
      }
      if (!player.alive) {
        events.push({
          type: "inputRejected",
          playerId,
          input,
          reason: "player_dead",
        });
        continue;
      }
      if (input.type === "move") {
        if (moved.has(playerId)) {
          events.push({
            type: "inputRejected",
            playerId,
            input,
            reason: "action_limit",
          });
          continue;
        }
        const to = {
          x: player.cell.x + directions[input.direction].x,
          y: player.cell.y + directions[input.direction].y,
        };
        if (!isInBounds(to) || isWall(to) || this.blocks.has(cellKey(to))) {
          events.push({
            type: "inputRejected",
            playerId,
            input,
            reason: "blocked",
          });
          continue;
        }
        if (
          [...this.players.values()].some(
            (other) =>
              other.alive &&
              other.id !== playerId &&
              cellKey(other.cell) === cellKey(to),
          )
        ) {
          events.push({
            type: "inputRejected",
            playerId,
            input,
            reason: "occupied",
          });
          continue;
        }
        const from = player.cell;
        player.cell = to;
        moved.add(playerId);
        events.push({
          type: "moved",
          playerId,
          from: copyCell(from),
          to: copyCell(to),
        });
        this.collectPickup(player, events);
      } else {
        if (placed.has(playerId)) {
          events.push({
            type: "inputRejected",
            playerId,
            input,
            reason: "action_limit",
          });
          continue;
        }
        if (player.availableBombs === 0) {
          events.push({
            type: "inputRejected",
            playerId,
            input,
            reason: "no_available_bomb",
          });
          continue;
        }
        if (this.activeBombCount(playerId) >= 2) {
          events.push({
            type: "inputRejected",
            playerId,
            input,
            reason: "active_bomb_limit",
          });
          continue;
        }
        player.availableBombs -= 1;
        placed.add(playerId);
        const bomb = {
          id: `bomb-${++this.bombNumber}`,
          playerId,
          cell: copyCell(player.cell),
          detonatesAtMs: this.elapsedMs + BOMB_FUSE_MS,
        };
        this.bombs.set(bomb.id, bomb);
        events.push({
          type: "bombPlaced",
          bombId: bomb.id,
          playerId,
          cell: copyCell(bomb.cell),
        });
      }
    }
  }

  private advanceTo(targetMs: number, events: GameEvent[]): void {
    while (this.phase === "running" && this.elapsedMs < targetMs) {
      const nextBomb = Math.min(
        ...[...this.bombs.values()].map((bomb) => bomb.detonatesAtMs),
        Infinity,
      );
      const nextFire = Math.min(
        ...[...this.fire.values()].map((flame) => flame.expiresAtMs),
        Infinity,
      );
      const nextRecharge = Math.min(
        ...[...this.players.values()]
          .filter((player) => player.alive)
          .map((player) => player.nextRechargeAtMs),
        Infinity,
      );
      const next = Math.min(
        targetMs,
        nextBomb,
        nextFire,
        nextRecharge,
        this.nextPickupAttemptAtMs,
        GAME_TIMEOUT_MS,
      );
      this.elapsedMs = next;
      this.expireFire();
      this.rechargeBombs();
      if (this.elapsedMs === this.nextPickupAttemptAtMs)
        this.attemptPickup(events);
      this.detonateDueBombs(events);
      this.eliminatePlayersInFire(events);
      if (this.elapsedMs === GAME_TIMEOUT_MS && this.phase === "running")
        this.finishAtTimeout(events);
    }
  }

  private detonateDueBombs(events: GameEvent[]): void {
    const initial = [...this.bombs.values()]
      .filter((bomb) => bomb.detonatesAtMs <= this.elapsedMs)
      .map((bomb) => bomb.id);
    if (initial.length === 0) return;
    const blocksBeforeExplosion = new Set(this.blocks);
    const pending = initial.sort();
    const detonated = new Set<string>();
    const destroyed = new Set<string>();
    while (pending.length > 0) {
      const id = pending.shift()!;
      if (detonated.has(id)) continue;
      const bomb = this.bombs.get(id);
      if (!bomb) continue;
      detonated.add(id);
      this.bombs.delete(id);
      const cells = this.blastCells(
        bomb.cell,
        blocksBeforeExplosion,
        destroyed,
      );
      events.push({
        type: "bombDetonated",
        bombId: id,
        cells: cells.map(copyCell),
      });
      for (const cell of cells) {
        const key = cellKey(cell);
        this.fire.set(key, {
          cell: copyCell(cell),
          expiresAtMs: this.elapsedMs + FIRE_MS,
        });
        if (blocksBeforeExplosion.has(key)) destroyed.add(key);
        for (const other of this.bombs.values())
          if (!detonated.has(other.id) && cellKey(other.cell) === key)
            pending.push(other.id);
      }
    }
    for (const key of [...destroyed].sort())
      if (this.blocks.delete(key))
        events.push({ type: "blockDestroyed", cell: parseCell(key) });
  }

  private blastCells(
    origin: Cell,
    blocksBeforeExplosion: Set<string>,
    destroyed: Set<string>,
  ): Cell[] {
    const result = [copyCell(origin)];
    for (const direction of Object.values(directions)) {
      for (let distance = 1; distance <= BLAST_RANGE; distance += 1) {
        const cell = {
          x: origin.x + direction.x * distance,
          y: origin.y + direction.y * distance,
        };
        if (!isInBounds(cell) || isWall(cell)) break;
        result.push(cell);
        if (blocksBeforeExplosion.has(cellKey(cell))) {
          destroyed.add(cellKey(cell));
          break;
        }
      }
    }
    return result;
  }

  private expireFire(): void {
    for (const [key, flame] of this.fire)
      if (flame.expiresAtMs <= this.elapsedMs) this.fire.delete(key);
  }

  private rechargeBombs(): void {
    for (const player of this.players.values())
      while (player.alive && player.nextRechargeAtMs <= this.elapsedMs) {
        player.availableBombs = Math.min(2, player.availableBombs + 1);
        player.nextRechargeAtMs += BOMB_RECHARGE_MS;
      }
  }

  private attemptPickup(events: GameEvent[]): void {
    this.nextPickupAttemptAtMs += PICKUP_ATTEMPT_MS;
    const candidate =
      PICKUP_CANDIDATES[Math.floor(this.random() * PICKUP_CANDIDATES.length)];
    const key = cellKey(candidate);
    const blocked =
      this.pickups.size >= 2 ||
      this.blocks.has(key) ||
      this.bombsAt(key) ||
      this.fire.has(key) ||
      [...this.players.values()].some(
        (player) => player.alive && cellKey(player.cell) === key,
      );
    if (!blocked) this.pickups.add(key);
    events.push({
      type: "pickupAttempt",
      cell: copyCell(candidate),
      placed: !blocked,
    });
  }

  private collectPickup(player: MutablePlayer, events: GameEvent[]): void {
    const key = cellKey(player.cell);
    if (!this.pickups.delete(key)) return;
    player.availableBombs = Math.min(2, player.availableBombs + 1);
    events.push({
      type: "pickupCollected",
      playerId: player.id,
      cell: copyCell(player.cell),
    });
  }

  private eliminatePlayersInFire(events: GameEvent[]): void {
    for (const player of this.players.values()) {
      if (!player.alive || !this.fire.has(cellKey(player.cell))) continue;
      player.alive = false;
      events.push({ type: "playerEliminated", playerId: player.id });
    }
    const survivors = [...this.players.values()].filter(
      (player) => player.alive,
    );
    if (this.phase === "running" && survivors.length <= 1)
      this.finish(
        events,
        survivors.length === 1
          ? { kind: "winner", playerId: survivors[0].id, reason: "elimination" }
          : { kind: "draw", reason: "elimination" },
      );
  }

  private finishAtTimeout(events: GameEvent[]): void {
    const survivors = [...this.players.values()].filter(
      (player) => player.alive,
    );
    this.finish(
      events,
      survivors.length === 1
        ? { kind: "winner", playerId: survivors[0].id, reason: "timeout" }
        : { kind: "draw", reason: "timeout" },
    );
  }

  private finish(events: GameEvent[], outcome: GameOutcome): void {
    this.phase = "finished";
    this.outcome = outcome;
    events.push({ type: "gameFinished", outcome });
  }

  private activeBombCount(playerId: string): number {
    return [...this.bombs.values()].filter((bomb) => bomb.playerId === playerId)
      .length;
  }
  private bombsAt(key: string): boolean {
    return [...this.bombs.values()].some((bomb) => cellKey(bomb.cell) === key);
  }
}

function parseCell(key: string): Cell {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}
function compareCells(left: Cell, right: Cell): number {
  return left.y - right.y || left.x - right.x;
}
function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}
