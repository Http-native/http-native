/**
 * 01 — Hello World
 *
 * The simplest possible http-native server.
 * Registers a single GET route and starts listening on port 3000.
 *
 * Run:
 *   bun examples/01-hello-world/server.js
 *
 * Test:
 *   curl http://localhost:3000/
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * A basic GET route that returns a JSON response.
 * This route is automatically optimized by the Rust static fast-path
 * analyzer — the response is served directly from Rust without
 * crossing the JS bridge.
 */
app.get("/", (req, res) => {
    res.json({ message: "Hello from http-native!" });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
