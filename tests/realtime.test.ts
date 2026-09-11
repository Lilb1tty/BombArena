import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import WebSocket from "ws";

import { createApp } from "../src/app.js";
import { createAuthenticationRuntime } from "../src/auth.js";
import { RealtimeRuntime } from "../src/realtime/index.js";

test("Room HTTP actions and real-time Game snapshots use an authenticated boundary", async (context) => {
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

  const realtime = new RealtimeRuntime({ authentication });
  const server = createServer(
    createApp({ authentication, rooms: realtime.rooms }),
  );
  realtime.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const first = await register(baseUrl);
    const second = await register(baseUrl);

    const unauthenticated = await fetch(`${baseUrl}/rooms`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);

    const created = await post(baseUrl, "/rooms", first.cookie);
    assert.equal(created.response.status, 201);
    const roomCode = created.body.room.code;

    const roomRead = await fetch(`${baseUrl}/rooms/${roomCode}`, {
      headers: { Cookie: first.cookie },
    });
    assert.equal(roomRead.status, 200);
    assert.equal((await roomRead.json()).room.code, roomCode);

    assert.equal(
      (await post(baseUrl, `/rooms/${roomCode}/join`, second.cookie)).response
        .status,
      200,
    );
    assert.equal(
      (await selectCharacter(baseUrl, roomCode, first.cookie, "spark")).status,
      200,
    );
    assert.equal(
      (await selectCharacter(baseUrl, roomCode, second.cookie, "volt")).status,
      200,
    );
    assert.equal(
      (await post(baseUrl, `/rooms/${roomCode}/ready`, first.cookie)).response
        .status,
      200,
    );
    assert.equal(
      (await post(baseUrl, `/rooms/${roomCode}/ready`, second.cookie)).response
        .status,
      200,
    );

    await waitFor(() => realtime.tick(), 3_100);

    const [socket, initialMessage] = await openSocket(
      `ws://127.0.0.1:${address.port}/realtime?roomCode=${roomCode}`,
      first.cookie,
    );
    try {
      const snapshot = await initialMessage;
      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshot.version, 1);
      assert.equal(typeof snapshot.requestId, "string");
      assert.equal(snapshot.payload.snapshot.map.version, 1);

      socket.send(
        JSON.stringify({
          version: 1,
          type: "input",
          requestId: "invalid-input",
          payload: { type: "move", direction: "right", x: 99 },
        }),
      );
      assert.deepEqual(await nextMessage(socket), {
        version: 1,
        type: "rejected",
        requestId: "invalid-input",
        payload: { reason: "invalid_message" },
      });

      socket.send(
        JSON.stringify({
          version: 1,
          type: "resync",
          requestId: "resync-1",
          payload: {},
        }),
      );
      const resync = await nextMessage(socket);
      assert.equal(resync.type, "snapshot");
      assert.equal(resync.requestId, "resync-1");
      assert.equal(
        resync.payload.snapshot.stateVersion >=
          snapshot.payload.snapshot.stateVersion,
        true,
      );
    } finally {
      socket.close();
      await once(socket, "close");
    }
  } finally {
    server.close();
    await once(server, "close");
    await authentication.close();
  }
});

async function register(baseUrl: string): Promise<{ cookie: string }> {
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: `p${randomUUID().replaceAll("-", "").slice(0, 14)}`,
      password: "correct-horse-battery-staple",
    }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie");
  assert.notEqual(cookie, null);
  return { cookie: cookie.split(";", 1)[0] };
}

async function post(
  baseUrl: string,
  path: string,
  cookie: string,
): Promise<{ response: Response; body: { room: { code: string } } }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  return { response, body: await response.json() };
}

async function selectCharacter(
  baseUrl: string,
  roomCode: string,
  cookie: string,
  character: string,
): Promise<Response> {
  return fetch(`${baseUrl}/rooms/${roomCode}/character`, {
    method: "PUT",
    headers: { Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify({ character }),
  });
}

async function openSocket(
  url: string,
  cookie: string,
): Promise<[WebSocket, Promise<any>]> {
  const socket = new WebSocket(url, { headers: { Cookie: cookie } });
  const initialMessage = nextMessage(socket);
  await once(socket, "open");
  return [socket, initialMessage];
}

async function nextMessage(socket: WebSocket): Promise<any> {
  const [data] = await once(socket, "message");
  return JSON.parse(Buffer.from(data).toString("utf8"));
}

async function waitFor(
  action: () => void,
  milliseconds: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  action();
}
