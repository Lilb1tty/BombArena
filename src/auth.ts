import { createHash, randomBytes } from "node:crypto";

import argon2 from "argon2";
import { Prisma, PrismaClient } from "@prisma/client";
import type { Request, RequestHandler, Response } from "express";
import { createClient } from "redis";

import {
  AUTH_RATE_LIMIT_WINDOW_SECONDS,
  isAuthenticationAttemptAllowed,
} from "./auth/rate-limit.js";
import { isAcceptablePassword, normalizeUsername } from "./auth/validation.js";

export const LOGIN_SESSION_COOKIE = "pixel_arena_login_session";
const LOGIN_SESSION_TTL_SECONDS = 20 * 60;
const AUTH_KEY_PREFIX = "pixel-arena:auth";
type Redis = ReturnType<typeof createClient>;
// This is not an Account credential. It keeps unknown-Account and incorrect
// Password Credential failures on the same Argon2id verification path.
const unknownAccountPasswordCredentialHash =
  "$argon2id$v=19$m=65536,t=3,p=4$Sxf13jBQAs+h0mv86s+vFA$6hWNkNfB/i052t2nYiUKvdF3IQS4HQEtUYc3LRkF54E";

const passwordHashOptions = {
  type: argon2.argon2id,
  hashLength: 32,
  timeCost: 3,
  memoryCost: 65_536,
  parallelism: 4,
} as const;

export interface AuthenticationDependencies {
  prisma: PrismaClient;
  redis: Redis;
}

export interface AuthenticatedAccount {
  id: string;
  username: string;
}

export interface AuthenticationRuntime extends AuthenticationDependencies {
  close(): Promise<void>;
}

export async function createAuthenticationRuntime(): Promise<AuthenticationRuntime> {
  const prisma = new PrismaClient();
  const redis = createClient({
    url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  });

  try {
    await Promise.all([prisma.$connect(), redis.connect()]);
  } catch (error) {
    await Promise.allSettled([prisma.$disconnect(), closeRedis(redis)]);
    throw error;
  }

  return {
    prisma,
    redis,
    async close() {
      await Promise.allSettled([prisma.$disconnect(), closeRedis(redis)]);
    },
  };
}

async function closeRedis(redis: Redis): Promise<void> {
  if (redis.isOpen) await redis.close();
  else redis.destroy();
}

export function authenticationRoutes(
  dependencies: AuthenticationDependencies,
): RequestHandler[] {
  return [
    register(dependencies),
    login(dependencies),
    currentSession(dependencies),
    logout(dependencies),
  ];
}

function register(dependencies: AuthenticationDependencies): RequestHandler {
  return async (request, response) => {
    const suppliedUsername = request.body?.username;
    const username = normalizeUsername(suppliedUsername);
    const password = request.body?.password;
    const rateLimitUsername = username ?? String(suppliedUsername ?? "");

    if (
      !(await allowAttempt(
        dependencies.redis,
        "registration",
        requestIp(request),
        rateLimitUsername,
      ))
    ) {
      response.status(429).json({ error: "too_many_attempts" });
      return;
    }

    if (username === undefined || !isAcceptablePassword(password)) {
      response.status(400).json({ error: "invalid_registration" });
      return;
    }
    const registrationUsername = username;

    try {
      const passwordCredentialHash = await argon2.hash(
        password,
        passwordHashOptions,
      );
      const account = await dependencies.prisma.account.create({
        data: { username: registrationUsername, passwordCredentialHash },
        select: { id: true, username: true },
      });
      const sessionId = await createLoginSession(
        dependencies.redis,
        account.id,
      );

      setLoginSessionCookie(response, sessionId);
      response.status(201).json({ account });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        response.status(409).json({ error: "username_unavailable" });
        return;
      }

      throw error;
    }
  };
}

function login(dependencies: AuthenticationDependencies): RequestHandler {
  return async (request, response) => {
    const suppliedUsername = request.body?.username;
    const username = normalizeUsername(suppliedUsername);
    const password = request.body?.password;
    const rateLimitUsername = username ?? String(suppliedUsername ?? "");

    if (
      !(await allowAttempt(
        dependencies.redis,
        "login",
        requestIp(request),
        rateLimitUsername,
      ))
    ) {
      response.status(429).json({ error: "too_many_attempts" });
      return;
    }

    if (username === undefined || !isAcceptablePassword(password)) {
      invalidCredentials(response);
      return;
    }
    const loginUsername = username;

    const account = await dependencies.prisma.account.findUnique({
      where: { username: loginUsername },
      select: { id: true, username: true, passwordCredentialHash: true },
    });
    const passwordMatches = await argon2.verify(
      account?.passwordCredentialHash ?? unknownAccountPasswordCredentialHash,
      password,
    );

    if (!passwordMatches || account === null) {
      invalidCredentials(response);
      return;
    }

    const sessionId = await createLoginSession(dependencies.redis, account.id);
    setLoginSessionCookie(response, sessionId);
    response.json({ account: { id: account.id, username: account.username } });
  };
}

function currentSession(
  dependencies: AuthenticationDependencies,
): RequestHandler {
  return requireAuthentication(dependencies, (request, response) => {
    response.json({ account: request.authenticatedAccount });
  });
}

function logout(dependencies: AuthenticationDependencies): RequestHandler {
  return async (request, response) => {
    const sessionId = readLoginSessionId(request);
    if (sessionId !== undefined) {
      await dependencies.redis.del(loginSessionKey(sessionId));
    }

    clearLoginSessionCookie(response);
    response.status(204).end();
  };
}

export function requireAuthentication(
  dependencies: AuthenticationDependencies,
  handler: (
    request: Request & { authenticatedAccount: AuthenticatedAccount },
    response: Response,
  ) => void | Promise<void>,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const account = await authenticateLoginSession(
        dependencies,
        request.get("cookie"),
      );
      if (account === undefined) {
        response.status(401).json({ error: "authentication_required" });
        return;
      }

      const sessionId = readLoginSessionIdFromCookie(request.get("cookie"));
      if (sessionId !== undefined) setLoginSessionCookie(response, sessionId);
      const authenticatedRequest = request as Request & {
        authenticatedAccount: AuthenticatedAccount;
      };
      authenticatedRequest.authenticatedAccount = account;
      await handler(authenticatedRequest, response);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validates and renews a Login Session supplied by an HTTP or WebSocket
 * handshake. WebSocket upgrades share exactly the same session store as HTTP.
 */
export async function authenticateLoginSession(
  dependencies: AuthenticationDependencies,
  cookieHeader: string | undefined,
): Promise<AuthenticatedAccount | undefined> {
  const sessionId = readLoginSessionIdFromCookie(cookieHeader);
  if (sessionId === undefined) return undefined;

  const key = loginSessionKey(sessionId);
  const accountId = await dependencies.redis.get(key);
  if (accountId === null) return undefined;

  const account = await dependencies.prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, username: true },
  });
  if (account === null) {
    await dependencies.redis.del(key);
    return undefined;
  }

  // EXPIRE refreshes only a key that still exists, so a concurrent logout
  // cannot be undone by the sliding-session renewal.
  const renewed = await dependencies.redis.expire(
    key,
    LOGIN_SESSION_TTL_SECONDS,
  );
  return renewed ? account : undefined;
}

function invalidCredentials(response: Response): void {
  response.status(401).json({ error: "invalid_credentials" });
}

async function allowAttempt(
  redis: Redis,
  operation: "registration" | "login",
  ip: string,
  username: string,
): Promise<boolean> {
  const [ipAttempts, usernameAttempts] = await Promise.all([
    incrementWithWindow(redis, rateLimitKey(operation, "ip", ip)),
    incrementWithWindow(redis, rateLimitKey(operation, "username", username)),
  ]);
  return isAuthenticationAttemptAllowed(ipAttempts, usernameAttempts);
}

async function incrementWithWindow(redis: Redis, key: string): Promise<number> {
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, AUTH_RATE_LIMIT_WINDOW_SECONDS);
  }
  return attempts;
}

async function createLoginSession(
  redis: Redis,
  accountId: string,
): Promise<string> {
  const sessionId = randomBytes(32).toString("base64url");
  await redis.set(loginSessionKey(sessionId), accountId, {
    EX: LOGIN_SESSION_TTL_SECONDS,
  });
  return sessionId;
}

function loginSessionKey(sessionId: string): string {
  return `${AUTH_KEY_PREFIX}:session:${sessionId}`;
}

function rateLimitKey(
  operation: "registration" | "login",
  dimension: "ip" | "username",
  value: string,
): string {
  const fingerprint = createHash("sha256").update(value).digest("base64url");
  return `${AUTH_KEY_PREFIX}:rate-limit:${operation}:${dimension}:${fingerprint}`;
}

function requestIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}

function readLoginSessionId(request: Request): string | undefined {
  return readLoginSessionIdFromCookie(request.get("cookie"));
}

function readLoginSessionIdFromCookie(
  cookieHeader: string | undefined,
): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (
      name === LOGIN_SESSION_COOKIE &&
      value.length === 1 &&
      /^[A-Za-z0-9_-]{43}$/.test(value[0])
    ) {
      return value[0];
    }
  }

  return undefined;
}

function setLoginSessionCookie(response: Response, sessionId: string): void {
  response.append(
    "Set-Cookie",
    `${LOGIN_SESSION_COOKIE}=${sessionId}; Max-Age=${LOGIN_SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
}

function clearLoginSessionCookie(response: Response): void {
  response.append(
    "Set-Cookie",
    `${LOGIN_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
}
