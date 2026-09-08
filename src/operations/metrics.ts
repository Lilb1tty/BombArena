export type OperationalLogEntry = Readonly<{
  level: "info" | "error";
  event: string;
  fields: Readonly<Record<string, unknown>>;
}>;

export type OperationalLogSink = (entry: OperationalLogEntry) => void;

export function operationalLog(
  sink: OperationalLogSink | undefined,
  level: OperationalLogEntry["level"],
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  sink?.({ level, event, fields });
}

export type TickDelayBucket = Readonly<{
  upperBoundMs: number | null;
  count: number;
}>;

export type OperationsMetricsSnapshot = Readonly<{
  activeConnections: number;
  tickDelay: Readonly<{
    count: number;
    delayedCount: number;
    totalMs: number;
    maxMs: number;
    buckets: readonly TickDelayBucket[];
  }>;
}>;

const tickDelayBucketBounds = [10, 50, 100, 250, 500, 1_000] as const;

/** In-process operational counters; export snapshots to the monitoring adapter. */
export class OperationsMetrics {
  private activeConnections = 0;
  private tickCount = 0;
  private delayedTickCount = 0;
  private totalTickDelayMs = 0;
  private maxTickDelayMs = 0;
  private readonly tickDelayBuckets = Array<number>(
    tickDelayBucketBounds.length + 1,
  ).fill(0);

  public constructor(private readonly logSink?: OperationalLogSink) {}

  public connectionOpened(): number {
    this.activeConnections += 1;
    operationalLog(this.logSink, "info", "connection_opened", {
      activeConnections: this.activeConnections,
    });
    return this.activeConnections;
  }

  public connectionClosed(): number {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    operationalLog(this.logSink, "info", "connection_closed", {
      activeConnections: this.activeConnections,
    });
    return this.activeConnections;
  }

  /** Records scheduler lateness in milliseconds, rather than a WebSocket detail. */
  public observeTickDelay(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new Error("Tick delay must be a non-negative finite number");
    this.tickCount += 1;
    this.delayedTickCount += delayMs > 0 ? 1 : 0;
    this.totalTickDelayMs += delayMs;
    this.maxTickDelayMs = Math.max(this.maxTickDelayMs, delayMs);
    const index = tickDelayBucketBounds.findIndex((bound) => delayMs <= bound);
    this.tickDelayBuckets[
      index === -1 ? this.tickDelayBuckets.length - 1 : index
    ] += 1;
  }

  public snapshot(): OperationsMetricsSnapshot {
    return {
      activeConnections: this.activeConnections,
      tickDelay: {
        count: this.tickCount,
        delayedCount: this.delayedTickCount,
        totalMs: this.totalTickDelayMs,
        maxMs: this.maxTickDelayMs,
        buckets: this.tickDelayBuckets.map((count, index) => ({
          upperBoundMs: tickDelayBucketBounds[index] ?? null,
          count,
        })),
      },
    };
  }
}
