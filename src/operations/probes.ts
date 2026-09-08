export type ProbeCheck = () => boolean | Promise<boolean>;

export type ProbeResult = Readonly<{
  ok: boolean;
  status: "alive" | "ready" | "unavailable";
}>;

export type HealthProbes = Readonly<{
  live: () => Promise<ProbeResult>;
  ready: () => Promise<ProbeResult>;
}>;

/** Framework-neutral health checks for an HTTP adapter to expose. */
export function createHealthProbes(options: {
  isLive?: ProbeCheck;
  isReady: ProbeCheck;
}): HealthProbes {
  return {
    live: () => runProbe(options.isLive ?? (() => true), "alive"),
    ready: () => runProbe(options.isReady, "ready"),
  };
}

async function runProbe(
  check: ProbeCheck,
  healthyStatus: "alive" | "ready",
): Promise<ProbeResult> {
  try {
    return (await check())
      ? { ok: true, status: healthyStatus }
      : { ok: false, status: "unavailable" };
  } catch {
    return { ok: false, status: "unavailable" };
  }
}
