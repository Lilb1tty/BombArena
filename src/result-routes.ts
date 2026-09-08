import type { RequestHandler } from "express";

import {
  requireAuthentication,
  type AuthenticationDependencies,
} from "./auth.js";
import { GameResultQueryService } from "./results/index.js";

/** HTTP adapters for participant-scoped Game Results and public evidence. */
export function resultRoutes(
  authentication: AuthenticationDependencies,
  results: GameResultQueryService,
): readonly [RequestHandler, RequestHandler] {
  return [
    requireAuthentication(authentication, async (request, response) => {
      const result = await results.getDetailedForAccount(
        request.authenticatedAccount.id,
        typeof request.params.resultId === "string"
          ? request.params.resultId
          : "",
      );
      if (result === null) {
        response.status(404).json({ error: "game_result_not_found" });
        return;
      }
      response.json({ gameResult: result });
    }),
    async (_request, response, next) => {
      try {
        response.json({ aggregates: await results.getPublicAggregates() });
      } catch (error) {
        next(error);
      }
    },
  ];
}
