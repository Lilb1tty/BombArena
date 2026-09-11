import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { RoomDirectory, RoomError } from "../src/rooms/index.js";

test("the Room Code generator contract matches the six-character join field", () => {
  const page = readFileSync(path.resolve("public/index.html"), "utf8");
  assert.match(page, /id="room-code"[\s\S]*?maxlength="6"/);

  const rooms = new RoomDirectory({ createRoomCode: () => "29DD2103" });
  assert.throws(
    () => rooms.create("creator"),
    (error: unknown) =>
      error instanceof RoomError && error.code === "invalid_room_code",
  );
});
