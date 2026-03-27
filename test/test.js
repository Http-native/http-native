import assert from "node:assert/strict";

import httpServerConfig from "../src/http-server.config.js";
import { createApp } from "../src/index.js";

const stablePayload = {
  ok: true,
  mode: "js-cache-candidate",
};

async function main() {
  assert.equal(httpServerConfig.defaultHost, "127.0.0.1");
  assert.equal(httpServerConfig.defaultBacklog, 2048);
  assert.equal(httpServerConfig.maxHeaderBytes, 16 * 1024);

  const db = {
    async getUser(id) {
      return {
        id,
        name: "Ada Lovelace",
      };
    },
  };

  const app = createApp();

  app.get("/", (req, res) => {
    res.json({
      ok: true,
      engine: "rust",
    });
  });

  app.get("/stable", (req, res) => {
    res.json(stablePayload);
  });

  app.get("/users/:id", async (req, res) => {
    const user = await db.getUser(req.params.id);
    res.json(user);
  });

  const server = await app.listen({
    port: 0,
    serverConfig: {
      ...httpServerConfig,
      maxHeaderBytes: httpServerConfig.maxHeaderBytes,
    },
  });

  try {
    const rootResponse = await fetch(new URL("/", server.url));
    assert.equal(rootResponse.status, 200);
    assert.deepEqual(await rootResponse.json(), {
      ok: true,
      engine: "rust",
    });

    const userResponse = await fetch(new URL("/users/42", server.url));
    assert.equal(userResponse.status, 200);
    assert.deepEqual(await userResponse.json(), {
      id: "42",
      name: "Ada Lovelace",
    });

    for (let index = 0; index < 32; index += 1) {
      const stableResponse = await fetch(new URL("/stable", server.url));
      assert.equal(stableResponse.status, 200);
      assert.deepEqual(await stableResponse.json(), stablePayload);
    }

    const snapshot = server.optimizations.snapshot();
    const rootRoute = snapshot.routes.find(
      (route) => route.method === "GET" && route.path === "/",
    );
    const stableRoute = snapshot.routes.find(
      (route) => route.method === "GET" && route.path === "/stable",
    );
    const userRoute = snapshot.routes.find(
      (route) => route.method === "GET" && route.path === "/users/:id",
    );

    assert.ok(rootRoute);
    assert.ok(stableRoute);
    assert.ok(userRoute);

    assert.equal(rootRoute.nativeStaticHot, true);
    assert.equal(rootRoute.hits, 1);
    assert.equal(rootRoute.jsBridgeObserved, true);

    assert.equal(stableRoute.nativeStaticHot, false);
    assert.equal(stableRoute.jsBridgeObserved, true);
    assert.equal(stableRoute.cacheCandidate, true);
    assert.equal(stableRoute.hits, 32);
    assert.equal(stableRoute.recommendation, "cache-candidate");

    assert.equal(userRoute.nativeStaticHot, false);
    assert.equal(userRoute.jsBridgeObserved, true);
    assert.equal(userRoute.cacheCandidate, false);
    assert.equal(userRoute.hits, 1);

    const summary = server.optimizations.summary();
    assert.match(summary, /GET \/ \[native-static-hot, bridge-observed\]/);
    assert.match(summary, /GET \/stable \[js-bridge, bridge-observed, cache-candidate\]/);
    assert.match(summary, /GET \/users\/:id \[js-bridge, bridge-observed\]/);
  } finally {
    await Promise.resolve(server.close());
  }

  console.log("[http-native] test suite passed");
}

await main();
