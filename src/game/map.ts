export type Cell = Readonly<{ x: number; y: number }>;

export const MAP_VERSION = "arena-v1";
export const MAP_WIDTH = 13;
export const MAP_HEIGHT = 11;
export const BLAST_RANGE = 2;

export const SPAWNS: readonly Cell[] = [
  { x: 1, y: 1 },
  { x: 11, y: 1 },
  { x: 1, y: 9 },
  { x: 11, y: 9 },
];

const cells = (
  coordinates: readonly (readonly [number, number])[],
): readonly Cell[] => coordinates.map(([x, y]) => ({ x, y }));

export const BREAKABLE_BLOCKS = cells([
  [3, 3],
  [5, 3],
  [7, 3],
  [9, 3],
  [3, 5],
  [5, 5],
  [7, 5],
  [9, 5],
  [3, 7],
  [5, 7],
  [7, 7],
  [9, 7],
  [5, 9],
  [7, 9],
]);

// These open cells are the only locations where seeded pickup attempts land.
export const PICKUP_CANDIDATES = cells([
  [1, 4],
  [11, 4],
  [1, 5],
  [11, 5],
  [1, 6],
  [11, 6],
]);

export function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

export function isWall(cell: Cell): boolean {
  if (
    cell.x === 0 ||
    cell.y === 0 ||
    cell.x === MAP_WIDTH - 1 ||
    cell.y === MAP_HEIGHT - 1
  ) {
    return true;
  }
  return cell.x % 2 === 0 && cell.y % 2 === 0;
}

export function isInBounds(cell: Cell): boolean {
  return (
    cell.x >= 0 && cell.x < MAP_WIDTH && cell.y >= 0 && cell.y < MAP_HEIGHT
  );
}
