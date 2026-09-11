import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("the desktop arena gives the board only the space left below the top bar", () => {
  const page = readFileSync(path.resolve("public/index.html"), "utf8");

  assert.match(
    page,
    /@media \(min-width: 52\.01rem\) \{[\s\S]*?\.game-screen \{[\s\S]*?height: calc\(100dvh - 64px\);[\s\S]*?\.arena-panel \{[\s\S]*?min-height: 0;[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) auto;[\s\S]*?#arena \{[\s\S]*?min-height: 0;[\s\S]*?height: 100%;[\s\S]*?width: auto;/,
  );
});
