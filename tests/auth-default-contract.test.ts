import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("the unauthenticated home page defaults to sign in", () => {
  const page = readFileSync(path.resolve("public/index.html"), "utf8");

  assert.match(page, /let authMode = "login";/);
  assert.match(page, /<h2 id="auth-title">Sign in to play<\/h2>/);
  assert.match(page, /autocomplete="current-password"/);
});
