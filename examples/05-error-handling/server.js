/**
 * 05 — Error Handling
 *
 * Demonstrates global error handlers, custom 404 pages,
 * and throwing errors from route handlers.
 *
 * Run:
 *   bun examples/05-error-handling/server.js
 *
 * Test:
 *   curl http://localhost:3000/
 *   curl http://localhost:3000/fail
 *   curl http://localhost:3000/not-a-real-route
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * A route that works normally.
 */
app.get("/", (req, res) => {
    res.json({ status: "ok" });
});

/**
 * A route that deliberately throws an error.
 * The error handler below will catch it.
 */
app.get("/fail", (req, res) => {
    throw new Error("Something went wrong!");
});

/**
 * A route that throws a custom HTTP error with a status code.
 */
app.get("/forbidden", (req, res) => {
    const error = new Error("Access denied");
    error.status = 403;
    throw error;
});

/**
 * Custom 404 handler — catches all unmatched routes.
 * Uses the app.404() shorthand.
 */
app["404"]((req, res) => {
    res.status(404).json({
        error: "Not Found",
        path: req.path,
        hint: "Try GET / or GET /fail",
    });
});

/**
 * Global error handler — catches all thrown errors.
 * Receives (error, req, res) instead of (req, res).
 */
app.error((error, req, res) => {
    const status = error.status || 500;
    res.status(status).json({
        error: error.message || "Internal Server Error",
        path: req.path,
    });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
