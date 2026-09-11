import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  authenticationRoutes,
  type AuthenticationDependencies,
} from "./auth.js";
import { log } from "./logger.js";
import { roomRoutes } from "./room-routes.js";
import { resultRoutes } from "./result-routes.js";
import {
  type HealthProbes,
  type OperationsMetrics,
} from "./operations/index.js";
import { type GameResultQueryService } from "./results/index.js";
import { RoomDirectory } from "./rooms/index.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const staticDirectory = path.resolve(moduleDirectory, "../public");

export function createApp(
  options: {
    authentication?: AuthenticationDependencies;
    rooms?: RoomDirectory;
    results?: GameResultQueryService;
    probes?: HealthProbes;
    metrics?: OperationsMetrics;
  } = {},
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));

  app.use((request, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();

    response.on("finish", () => {
      log("info", "http_request", {
        requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/health/live", (_request, response) => {
    void (
      options.probes?.live() ?? Promise.resolve({ ok: true, status: "alive" })
    ).then((probe) =>
      response.status(probe.ok ? 200 : 503).json({ status: probe.status }),
    );
  });

  app.get("/health/ready", (_request, response) => {
    void (
      options.probes?.ready() ?? Promise.resolve({ ok: true, status: "ready" })
    ).then((probe) =>
      response.status(probe.ok ? 200 : 503).json({ status: probe.status }),
    );
  });

  if (options.metrics !== undefined)
    app.get("/metrics", (_request, response) =>
      response.json(options.metrics!.snapshot()),
    );

  if (options.authentication !== undefined) {
    const [register, login, currentSession, logout] = authenticationRoutes(
      options.authentication,
    );
    app.post("/auth/register", register);
    app.post("/auth/login", login);
    app.get("/auth/session", currentSession);
    app.post("/auth/logout", logout);
  }

  if (options.authentication !== undefined && options.rooms !== undefined) {
    const [get, create, join, selectCharacter, ready, unready, leave] =
      roomRoutes(options.authentication, options.rooms);
    app.get("/rooms/:roomCode", get);
    app.post("/rooms", create);
    app.post("/rooms/:roomCode/join", join);
    app.put("/rooms/:roomCode/character", selectCharacter);
    app.post("/rooms/:roomCode/ready", ready);
    app.post("/rooms/:roomCode/unready", unready);
    app.post("/rooms/:roomCode/leave", leave);
  }

  if (options.authentication !== undefined && options.results !== undefined) {
    const [detail, aggregates] = resultRoutes(
      options.authentication,
      options.results,
    );
    app.get("/game-results/:resultId", detail);
    app.get("/public/game-results", aggregates);
  }

  app.use(
    "/assets/vendor",
    express.static(path.resolve(moduleDirectory, "../node_modules/gsap/dist")),
  );
  app.use(express.static(staticDirectory));

  return app;
}
