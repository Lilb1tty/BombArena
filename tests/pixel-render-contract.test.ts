import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("the real-time board does not periodically replay a full-token fade", () => {
  const page = readFileSync(path.resolve("public/index.html"), "utf8");

  assert.doesNotMatch(page, /gameState\.stateVersion % 8 === 0/);
});
