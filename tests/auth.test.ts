import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { createApp } from "../src/app.js";
import { createAuthenticationRuntime } from "../src/auth.js";
import {
  AUTH_RATE_LIMIT,
  isAuthenticationAttemptAllowed,
} from "../src/auth/rate-limit.js";
import {
  isAcceptablePassword,
  normalizeUsername,
} from "../src/auth/validation.js";

test("Account name and Password Credential validation are deterministic", () => {
  assert.equal(normalizeUsername("Player_42"), "player_42");
  assert.equal(normalizeUsername("not valid"), undefined);
  assert.equal(normalizeUsername("ab"), undefined);
  assert.equal(isAcceptablePassword("password"), true);
  assert.equal(isAcceptablePassword("short"), false);
  assert.equal(isAcceptablePassword("x".repeat(129)), false);
});

test("authentication attempts are allowed only while both fixed windows remain in budget", () => {
  assert.equal(
    isAuthenticationAttemptAllowed(AUTH_RATE_LIMIT, AUTH_RATE_LIMIT),
    true,
  );
  assert.equal(isAuthenticationAttemptAllowed(AUTH_RATE_LIMIT + 1, 1), false);
  assert.equal(isAuthenticationAttemptAllowed(1, AUTH_RATE_LIMIT + 1), false);
});

test("authentication startup rejects when Redis is unavailable", async () => {
  const originalRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:1";

  try {
    const result = await Promise.race([
      createAuthenticationRuntime().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(resolve, 250, "timed_out")),
    ]);
    assert.equal(result, "rejected");
  } finally {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  }
});

test("Account HTTP flow uses real MySQL and Redis when available", async (context) => {
  let authentication;
  try {
    authentication = await createAuthenticationRuntime();
    await authentication.prisma.$queryRaw`SELECT 1`;
    await authentication.redis.ping();
  } catch {
    await authentication?.close();
    context.skip(
      "requires reachable MySQL and Redis (for example, Docker Compose or CI services)",
    );
    return;
  }

  const server = createApp({ authentication }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const username = `acct${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "correct-horse-battery-staple";

  try {
    const registration = await jsonRequest(baseUrl, "/auth/register", {
      username,
      password,
    });
    assert.equal(registration.response.status, 201);
    assert.deepEqual(registration.body, {
      account: {
        id: registration.body.account.id,
        username,
      },
    });
    const firstCookie = loginCookie(registration.response);
    assert.match(firstCookie, /HttpOnly/);
    assert.match(firstCookie, /Secure/);
    assert.match(firstCookie, /SameSite=Strict/);
    assert.match(firstCookie, /Max-Age=1200/);

    const duplicate = await jsonRequest(baseUrl, "/auth/register", {
      username: username.toUpperCase(),
      password,
    });
    assert.equal(duplicate.response.status, 409);

    const unknown = await jsonRequest(baseUrl, "/auth/login", {
      username: `other${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      password,
    });
    const incorrect = await jsonRequest(baseUrl, "/auth/login", {
      username,
      password: "not-the-correct-password",
    });
    assert.equal(unknown.response.status, 401);
    assert.equal(incorrect.response.status, 401);
    assert.deepEqual(unknown.body, incorrect.body);

    const secondLogin = await jsonRequest(baseUrl, "/auth/login", {
      username,
      password,
    });
    assert.equal(secondLogin.response.status, 200);
    const secondCookie = loginCookie(secondLogin.response);
    assert.notEqual(cookieValue(firstCookie), cookieValue(secondCookie));

    const activeSession = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: cookieValue(firstCookie) },
    });
    assert.equal(activeSession.status, 200);
    assert.match(loginCookie(activeSession), /Max-Age=1200/);

    const signedOut = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieValue(firstCookie) },
    });
    assert.equal(signedOut.status, 204);
    assert.match(loginCookie(signedOut), /Max-Age=0/);

    const revokedSession = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: cookieValue(firstCookie) },
    });
    assert.equal(revokedSession.status, 401);

    const concurrentSession = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: cookieValue(secondCookie) },
    });
    assert.equal(concurrentSession.status, 200);
  } finally {
    server.close();
    await once(server, "close");
    await authentication.close();
  }
});

async function jsonRequest(
  baseUrl: string,
  path: string,
  body: Record<string, string>,
): Promise<{
  response: Response;
  body: { account?: { id: string; username: string }; error?: string };
}> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function loginCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  assert.notEqual(cookie, null, "response should set the Login Session cookie");
  return cookie;
}

function cookieValue(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}
