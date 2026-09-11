import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createApp } from "../src/app.js";

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not receive a TCP address");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("health endpoint reports the service is ready", async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("liveness endpoint reports the process is alive", async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/live`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "alive" });
  });
});

test("readiness endpoint reports the service can accept requests", async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready" });
  });
});

test("root serves the BombArena demonstration page", async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const page = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page, /BombArena/);
    assert.match(page, /assets\/vendor\/gsap\.min\.js/);
    assert.match(page, /assets\/arena-hero-pixel\.png/);
  });
});

test("the production interface serves its pixel arena artwork", async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/assets/arena-hero-pixel.png`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /image\/png/);
  });
});

test("the production interface serves its motion runtime locally", async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/assets/vendor/gsap.min.js`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
  });
});
