/**
 * 10 — Native Cache (ncache)
 *
 * Demonstrates the res.ncache() API for caching JSON responses
 * directly in the Rust native layer. After the first request,
 * subsequent requests are served from Rust's LRU cache without
 * crossing the JS bridge — achieving near-static-route performance.
 *
 * Run:
 *   bun examples/10-native-cache/server.js
 *
 * Test:
 *   curl http://localhost:3000/users/42
 *   curl http://localhost:3000/users/42   # served from Rust cache
 *   curl http://localhost:3000/users/99   # different param = different cache entry
 *
 * Benchmark:
 *   bombardier -c 200 -d 5s http://localhost:3000/users/42
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Simulated database lookup.
 */
function getUser(id) {
    return {
        id,
        name: "Ada Lovelace",
        role: "engineer",
        createdAt: "2024-01-01T00:00:00Z",
    };
}

/**
 * Dynamic route with native caching.
 *
 * res.ncache(data, ttl, options) sends a JSON response AND caches it
 * in Rust's native LRU cache. Subsequent requests to the same URL
 * are served directly from Rust without calling this JS handler.
 *
 * Parameters:
 *   data       — JSON-serializable response data
 *   ttl        — Cache TTL in seconds
 *   maxEntries — Max LRU entries per route (default 256)
 */
app.get("/users/:id", (req, res) => {
    const user = getUser(req.params.id);

    res.ncache(user, 30, { maxEntries: 512 });
});

/**
 * Route-level cache configuration via options.
 *
 * The { cache } option configures Rust-side caching with vary-by
 * fields. The cache key is computed from the specified fields,
 * so different query/param combinations get separate cache entries.
 */
app.get(
    "/search",
    {
        cache: {
            ttl: 60,
            varyBy: ["query.q", "query.page"],
            maxEntries: 256,
        },
    },
    (req, res) => {
        const q = req.query.q || "";
        const page = parseInt(req.query.page) || 1;

        res.json({
            query: q,
            page,
            results: [{ id: 1, title: `Result for "${q}"` }],
        });
    },
);

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
