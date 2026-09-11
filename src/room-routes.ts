import type { RequestHandler } from "express";

import {
  requireAuthentication,
  type AuthenticationDependencies,
} from "./auth.js";
import {
  CHARACTER_IDS,
  RoomDirectory,
  RoomError,
  type CharacterId,
} from "./rooms/index.js";

export function roomRoutes(
  authentication: AuthenticationDependencies,
  rooms: RoomDirectory,
): RequestHandler[] {
  return [
    requireAuthentication(authentication, (request, response) => {
      respondWithRoom(response, () =>
        requireRoomMember(
          rooms,
          roomCode(request.params.roomCode),
          request.authenticatedAccount.id,
        ),
      );
    }),
    requireAuthentication(authentication, (request, response) => {
      const room = rooms.create(request.authenticatedAccount.id);
      response.status(201).json({ room: room.snapshot() });
    }),
    requireAuthentication(authentication, (request, response) => {
      respondWithRoom(response, () =>
        rooms.join(
          roomCode(request.params.roomCode),
          request.authenticatedAccount.id,
        ),
      );
    }),
    requireAuthentication(authentication, (request, response) => {
      respondWithRoom(response, () => {
        const room = requireRoomMember(
          rooms,
          roomCode(request.params.roomCode),
          request.authenticatedAccount.id,
        );
        room.selectCharacter(
          request.authenticatedAccount.id,
          characterId(request.body?.character),
        );
        return room;
      });
    }),
    requireAuthentication(authentication, (request, response) => {
      respondWithRoom(response, () => {
        const room = requireRoomMember(
          rooms,
          roomCode(request.params.roomCode),
          request.authenticatedAccount.id,
        );
        room.setReady(request.authenticatedAccount.id, true);
        return room;
      });
    }),
    requireAuthentication(authentication, (request, response) => {
      respondWithRoom(response, () => {
        const room = requireRoomMember(
          rooms,
          roomCode(request.params.roomCode),
          request.authenticatedAccount.id,
        );
        room.setReady(request.authenticatedAccount.id, false);
        return room;
      });
    }),
    requireAuthentication(authentication, (request, response) => {
      respondWithRoom(response, () => {
        const room = rooms.find(roomCode(request.params.roomCode));
        if (room === undefined) throw new RoomError("room_not_found");
        room.leave(request.authenticatedAccount.id);
        return room;
      });
    }),
  ];
}

function characterId(value: unknown): CharacterId {
  if (typeof value === "string" && CHARACTER_IDS.includes(value as CharacterId))
    return value as CharacterId;
  throw new RoomError("invalid_character");
}

function roomCode(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function requireRoomMember(
  rooms: RoomDirectory,
  roomCode: string,
  playerId: string,
) {
  const room = rooms.find(roomCode);
  if (room === undefined) throw new RoomError("room_not_found");
  if (!room.snapshot().players.some((player) => player.id === playerId))
    throw new RoomError("not_a_player");
  return room;
}

function respondWithRoom(
  response: Parameters<RequestHandler>[1],
  operation: () => { snapshot(): unknown },
): void {
  try {
    response.json({ room: operation().snapshot() });
  } catch (error) {
    if (error instanceof RoomError) {
      response.status(roomErrorStatus(error)).json({ error: error.code });
      return;
    }
    throw error;
  }
}

function roomErrorStatus(error: RoomError): number {
  switch (error.code) {
    case "room_not_found":
      return 404;
    case "duplicate_player":
    case "room_full":
    case "room_started":
    case "character_taken":
      return 409;
    default:
      return 400;
  }
}
