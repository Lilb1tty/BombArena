import { operationalLog, type OperationalLogSink } from "./metrics.js";

export type ActiveGameAbort = Readonly<{
  gameId: string;
  reason: string;
}>;

export type AbortResultRecorder = (game: ActiveGameAbort) => Promise<void>;

export type AbortReconciliation = Readonly<{
  recordedGameIds: readonly string[];
  failedGameIds: readonly string[];
}>;

/** Records unfinished Games before exit or when recovering an earlier process. */
export class GameAbortCoordinator {
  public constructor(
    private readonly recordAbortedResult: AbortResultRecorder,
    private readonly logSink?: OperationalLogSink,
  ) {}

  public recordGracefulShutdown(
    activeGames: Iterable<ActiveGameAbort>,
  ): Promise<AbortReconciliation> {
    return this.record(activeGames, "graceful_shutdown");
  }

  public reconcileStartup(
    activeGames: Iterable<ActiveGameAbort>,
  ): Promise<AbortReconciliation> {
    return this.record(activeGames, "startup_reconciliation");
  }

  private async record(
    activeGames: Iterable<ActiveGameAbort>,
    event: "graceful_shutdown" | "startup_reconciliation",
  ): Promise<AbortReconciliation> {
    const recordedGameIds: string[] = [];
    const failedGameIds: string[] = [];
    const seen = new Set<string>();
    for (const game of activeGames) {
      if (!game.gameId) throw new Error("Active Game id is required");
      if (!game.reason) throw new Error("Active Game abort reason is required");
      if (seen.has(game.gameId)) continue;
      seen.add(game.gameId);
      try {
        await this.recordAbortedResult(game);
        recordedGameIds.push(game.gameId);
        operationalLog(this.logSink, "info", "game_aborted", {
          event,
          gameId: game.gameId,
          reason: game.reason,
        });
      } catch (error) {
        failedGameIds.push(game.gameId);
        operationalLog(this.logSink, "error", "game_abort_record_failed", {
          event,
          gameId: game.gameId,
          reason: game.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { recordedGameIds, failedGameIds };
  }
}
