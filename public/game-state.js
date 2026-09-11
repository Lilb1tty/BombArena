/**
 * Merges the versioned snapshots and deltas received by the browser.
 * The server deliberately omits immutable map metadata from every delta.
 */
export function mergeGameState(previous, message) {
  if (message.type === "snapshot") return message.payload.snapshot;
  if (message.type !== "delta" || !previous) return previous;

  const destroyedBlocks = new Set(
    message.payload.delta.events
      .filter((event) => event.type === "blockDestroyed")
      .map((event) => `${event.cell.x},${event.cell.y}`),
  );

  return {
    ...message.payload.delta.state,
    map: {
      ...previous.map,
      breakableBlocks: previous.map.breakableBlocks.filter(
        (cell) => !destroyedBlocks.has(`${cell.x},${cell.y}`),
      ),
    },
    stateVersion: message.payload.delta.stateVersion,
  };
}
