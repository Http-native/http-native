/**
 * 06 — CORS (Cross-Origin Resource Sharing)
 *
 * Demonstrates the built-in CORS middleware with various
 * configurations: wildcard, specific origins, and credentials.
 *
 * Run:
 *   bun examples/06-cors/server.js
 *
 * Test:
 *   curl -H "Origin: https://example.com" -v http://localhost:3000/api/data
 *   curl -X OPTIONS -H "Origin: https://example.com" -v http://localhost:3000/api/data
 */

import { createApp } from "@http-native/core";
import { cors } from "@http-native/core/cors";

const app = createApp();

/**
 * Apply CORS middleware globally.
 * This allows requests from specific origins with credentials.
 */
app.use(
    cors({
        origin: ["https://example.com", "https://app.example.com"],
        methods: ["GET", "POST", "PUT", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
        maxAge: 86400,
    }),
);

/**
 * API endpoint — CORS headers are automatically added.
 */
app.get("/api/data", (req, res) => {
    res.json({
        items: [
            { id: 1, name: "Alpha" },
            { id: 2, name: "Beta" },
        ],
    });
});

/**
 * Another endpoint — same CORS policy applies.
 */
app.post("/api/data", (req, res) => {
    const body = req.json();
    res.status(201).json({ created: true, data: body });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
