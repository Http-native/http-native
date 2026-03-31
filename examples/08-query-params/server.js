/**
 * 08 — Query Parameters
 *
 * Demonstrates accessing query string parameters via req.query.
 * Supports single values, multi-value arrays, and URL-encoded strings.
 *
 * Run:
 *   bun examples/08-query-params/server.js
 *
 * Test:
 *   curl "http://localhost:3000/search?q=hello&limit=10"
 *   curl "http://localhost:3000/search?q=hello&q=world"
 *   curl "http://localhost:3000/filter?tags=js&tags=rust&tags=native&sort=name"
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Search endpoint with query parameters.
 * GET /search?q=hello&limit=10
 */
app.get("/search", (req, res) => {
    const query = req.query.q || "";
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    res.json({
        query,
        limit,
        offset,
        results: [
            { id: 1, title: `Result for "${query}"` },
            { id: 2, title: `Another result for "${query}"` },
        ],
    });
});

/**
 * Filter endpoint with multi-value query params.
 * GET /filter?tags=js&tags=rust&sort=name
 *
 * When the same key appears multiple times, req.query returns an array.
 */
app.get("/filter", (req, res) => {
    const tags = req.query.tags;
    const sort = req.query.sort || "id";

    res.json({
        tags: Array.isArray(tags) ? tags : tags ? [tags] : [],
        sort,
        message: "Filtered results",
    });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
