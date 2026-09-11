import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("the production start command rebuilds the server before serving the client", () => {
  const packageJson = JSON.parse(
    readFileSync(path.resolve("package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  assert.match(
    packageJson.scripts.start,
    /^npm run build && node dist\/server\.js$/,
  );
});
