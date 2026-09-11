import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("the result overlay animates only when it first becomes visible", () => {
  const page = readFileSync(path.resolve("public/index.html"), "utf8");

  assert.match(
    page,
    /function showResult\(outcome\) \{[\s\S]*?const wasHidden = ui\.result\.hidden;[\s\S]*?ui\.result\.hidden = false;[\s\S]*?if \(motionEnabled && wasHidden\)/,
  );
});
