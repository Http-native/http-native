/**
 * 13 — Response Types
 *
 * Demonstrates the various response methods: res.json(),
 * res.send(), res.status(), res.type(), res.set(),
 * res.sendStatus(), and res.locals for middleware data passing.
 *
 * Run:
 *   bun examples/13-response-types/server.js
 *
 * Test:
 *   curl http://localhost:3000/json
 *   curl http://localhost:3000/text
 *   curl http://localhost:3000/html
 *   curl http://localhost:3000/custom-headers
 *   curl http://localhost:3000/status-only
 *   curl http://localhost:3000/locals
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Middleware that sets res.locals for downstream handlers.
 */
app.use((req, res) => {
    res.locals.requestTime = Date.now();
    res.locals.version = "1.0.0";
});

/**
 * JSON response — sets Content-Type: application/json automatically.
 */
app.get("/json", (req, res) => {
    res.json({ format: "json", ok: true });
});

/**
 * Plain text response via res.send().
 */
app.get("/text", (req, res) => {
    res.send("Hello, plain text!");
});

/**
 * HTML response — use res.type() to set Content-Type.
 */
app.get("/html", (req, res) => {
    res.type("html").send("<h1>Hello, HTML!</h1><p>Served by http-native</p>");
});

/**
 * Custom response headers via res.set() / res.header().
 */
app.get("/custom-headers", (req, res) => {
    res
        .set("X-Request-Id", "abc-123")
        .set("X-Custom-Header", "custom-value")
        .header("Cache-Control", "no-store")
        .json({ headers: "custom" });
});

/**
 * Status-only response via res.sendStatus().
 * Sends the status code as the response body text.
 */
app.get("/status-only", (req, res) => {
    res.sendStatus(204);
});

/**
 * Accessing res.locals set by middleware.
 */
app.get("/locals", (req, res) => {
    res.json({
        requestTime: res.locals.requestTime,
        version: res.locals.version,
    });
});

/**
 * Custom status code with JSON body.
 */
app.post("/items", (req, res) => {
    res.status(201).json({ id: 1, created: true });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
