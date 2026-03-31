/**
 * 07 — Route Groups
 *
 * Demonstrates the group() API for organizing routes under
 * shared path prefixes. Groups can be nested and middleware
 * scoped to a group applies only to routes within it.
 *
 * Run:
 *   bun examples/07-route-groups/server.js
 *
 * Test:
 *   curl http://localhost:3000/api/v1/users
 *   curl http://localhost:3000/api/v1/users/42
 *   curl http://localhost:3000/api/v1/posts
 *   curl http://localhost:3000/api/v2/users
 *   curl http://localhost:3000/health
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Health check — outside any group.
 */
app.get("/health", (req, res) => {
    res.json({ status: "healthy" });
});

/**
 * API v1 group — all routes prefixed with /api/v1
 */
app.group("/api/v1", (api) => {
    /**
     * GET /api/v1/users
     */
    api.get("/users", (req, res) => {
        res.json({
            version: "v1",
            users: [
                { id: 1, name: "Alice" },
                { id: 2, name: "Bob" },
            ],
        });
    });

    /**
     * GET /api/v1/users/:id
     */
    api.get("/users/:id", (req, res) => {
        res.json({
            version: "v1",
            user: { id: req.params.id, name: "Alice" },
        });
    });

    /**
     * GET /api/v1/posts
     */
    api.get("/posts", (req, res) => {
        res.json({
            version: "v1",
            posts: [{ id: 1, title: "Hello World" }],
        });
    });
});

/**
 * API v2 group — demonstrates versioned APIs.
 */
app.group("/api/v2", (api) => {
    /**
     * GET /api/v2/users — different response shape than v1
     */
    api.get("/users", (req, res) => {
        res.json({
            version: "v2",
            data: {
                users: [
                    { id: 1, name: "Alice", email: "alice@example.com" },
                    { id: 2, name: "Bob", email: "bob@example.com" },
                ],
                total: 2,
            },
        });
    });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
