/**
 * 04 — Middleware
 *
 * Demonstrates global middleware, path-scoped middleware,
 * and the next() function for chaining.
 *
 * Run:
 *   bun examples/04-middleware/server.js
 *
 * Test:
 *   curl http://localhost:3000/
 *   curl http://localhost:3000/admin/dashboard
 *   curl -H "Authorization: Bearer secret-token" http://localhost:3000/admin/dashboard
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Global middleware — runs on every request.
 * Logs the method and path, then calls next() to continue.
 */
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    return next();
});

/**
 * Global middleware — adds a custom response header.
 * Middleware without next() auto-advances to the next middleware.
 */
app.use((req, res) => {
    res.set("X-Powered-By", "http-native");
});

/**
 * Path-scoped middleware — only runs for /admin/* routes.
 * Checks for an Authorization header before allowing access.
 */
app.use("/admin", (req, res, next) => {
    const auth = req.header("authorization");
    if (!auth || auth !== "Bearer secret-token") {
        return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
});

/**
 * Public route — accessible without authentication.
 */
app.get("/", (req, res) => {
    res.json({ message: "Public endpoint" });
});

/**
 * Protected route — requires the /admin middleware to pass.
 */
app.get("/admin/dashboard", (req, res) => {
    res.json({ message: "Admin dashboard", secret: "classified data" });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
