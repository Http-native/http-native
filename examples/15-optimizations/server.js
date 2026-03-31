/**
 * 15 — Runtime Optimizations
 *
 * Demonstrates http-native's runtime optimization system:
 * - Static fast-path: pure-static responses served from Rust
 * - Dynamic fast-path: parameterized responses served from Rust
 * - Runtime cache promotion: deterministic routes auto-cached
 * - Optimization snapshots and summaries
 *
 * Run:
 *   bun examples/15-optimizations/server.js
 *
 * Test:
 *   curl http://localhost:3000/static
 *   curl http://localhost:3000/dynamic/42
 *   curl http://localhost:3000/cached/hello
 *   curl http://localhost:3000/optimizations
 *
 * Benchmark:
 *   bombardier -c 200 -d 5s http://localhost:3000/static
 *   bombardier -c 200 -d 5s http://localhost:3000/dynamic/42
 *   bombardier -c 200 -d 5s http://localhost:3000/cached/hello
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Static fast-path route.
 *
 * The Rust analyzer detects that this handler returns a constant
 * JSON response with no request data dependencies. The response
 * bytes are pre-computed at startup and served directly from Rust
 * without ever calling into JavaScript.
 *
 * Expected: ~1M+ req/s
 */
app.get("/static", (req, res) => {
    res.json({
        ok: true,
        engine: "http-native",
        mode: "static-fast-path",
    });
});

/**
 * Dynamic fast-path route.
 *
 * The Rust analyzer detects that this handler returns a JSON
 * response with req.params interpolation. The JSON template is
 * compiled at startup, and responses are rendered entirely in
 * Rust by substituting param values into the template.
 *
 * Expected: ~500K+ req/s (no JS bridge crossing)
 */
app.get("/dynamic/:id", (req, res) => {
    res.json({
        id: req.params.id,
        mode: "dynamic-fast-path",
    });
});

/**
 * Native-cached route.
 *
 * Uses res.ncache() to cache the response in Rust's LRU cache.
 * The first request runs through JavaScript, but all subsequent
 * requests to the same URL are served from Rust cache.
 *
 * Expected: ~1M+ req/s after first request
 */
app.get("/cached/:key", (req, res) => {
    const data = {
        key: req.params.key,
        mode: "native-cached",
        timestamp: Date.now(),
    };

    res.ncache(data, 60, { maxEntries: 1024 });
});

/**
 * Optimization introspection endpoint.
 *
 * Returns the current optimization state for all routes,
 * including which fast-paths are active and hit counts.
 */
app.get("/optimizations", (req, res) => {
    res.json({
        hint: "Start the server with opt options to see optimization data",
        usage: 'app.listen({ opt: { notify: true, cache: true } })',
    });
});

/**
 * Start with runtime optimizations enabled.
 *
 * opt.notify: logs optimization events to console
 * opt.cache: enables runtime response cache promotion
 */
const server = await app.listen({
    port: 3000,
    opt: {
        notify: true,
        cache: true,
    },
});

console.log(`Server running at ${server.url}`);
console.log("Optimization summary:", server.optimizations.summary());
