import { createServer } from "node:http";

import { createApp } from "./app.js";
import { createAuthenticationRuntime } from "./auth.js";
import { log } from "./logger.js";
import { createHealthProbes, OperationsMetrics } from "./operations/index.js";
import { RealtimeRuntime } from "./realtime/index.js";
import { GameResultQueryService, GameResultWriter } from "./results/index.js";

const configuredPort = Number.parseInt(process.env.PORT ?? "3000", 10);
const port =
  Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : 3000;

const authentication = await createAuthenticationRuntime();
const metrics = new OperationsMetrics((entry) =>
  log(entry.level, entry.event, { ...entry.fields }),
);
const probes = createHealthProbes({
  isReady: async () => {
    await Promise.all([
      authentication.prisma.$queryRaw`SELECT 1`,
      authentication.redis.ping(),
    ]);
    return true;
  },
});
const realtime = new RealtimeRuntime({
  authentication,
  metrics,
  results: new GameResultWriter(authentication.prisma),
});
const results = new GameResultQueryService(authentication.prisma);
const server = createServer(
  createApp({
    authentication,
    rooms: realtime.rooms,
    results,
    probes,
    metrics,
  }),
);
realtime.attach(server);
server.listen(port, () => {
  log("info", "service_started", { port });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void realtime
        .close()
        .finally(() => authentication.close().finally(() => process.exit(0)));
    });
  });
}
