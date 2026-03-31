/**
 * 11 — Sessions
 *
 * Demonstrates the built-in session middleware backed by
 * Rust's native in-memory store. Sessions are signed with
 * HMAC and stored in a sharded RwLock for thread safety.
 *
 * Run:
 *   bun examples/11-sessions/server.js
 *
 * Test:
 *   # Login and capture the session cookie
 *   curl -c cookies.txt -X POST http://localhost:3000/login -H "Content-Type: application/json" -d '{"username":"alice"}'
 *
 *   # Access protected route with session cookie
 *   curl -b cookies.txt http://localhost:3000/profile
 *
 *   # Increment a counter
 *   curl -b cookies.txt -X POST http://localhost:3000/counter
 *   curl -b cookies.txt http://localhost:3000/counter
 *
 *   # Logout (destroys session)
 *   curl -b cookies.txt -X POST http://localhost:3000/logout
 */

import { createApp } from "@http-native/core";
import { session } from "@http-native/core/session";

const app = createApp();

/**
 * Session middleware — stores session data in Rust's native memory.
 * The secret is used for HMAC signing of session cookies.
 */
app.use(
    session({
        secret: "my-super-secret-key-change-in-production",
        maxAge: 3600,
        cookieName: "sid",
        httpOnly: true,
        sameSite: "lax",
    }),
);

/**
 * Login — stores the username in the session.
 */
app.post("/login", (req, res) => {
    const body = req.json();
    if (!body || !body.username) {
        return res.status(400).json({ error: "username is required" });
    }

    req.session.set("username", body.username);
    req.session.set("loginAt", new Date().toISOString());

    res.json({ message: `Welcome, ${body.username}!` });
});

/**
 * Profile — reads session data.
 */
app.get("/profile", (req, res) => {
    const username = req.session.get("username");
    if (!username) {
        return res.status(401).json({ error: "Not logged in" });
    }

    const loginAt = req.session.get("loginAt");
    res.json({ username, loginAt });
});

/**
 * Counter — demonstrates session mutation.
 */
app.post("/counter", (req, res) => {
    const current = req.session.get("count") || 0;
    req.session.set("count", current + 1);
    res.json({ count: current + 1 });
});

app.get("/counter", (req, res) => {
    const count = req.session.get("count") || 0;
    res.json({ count });
});

/**
 * Logout — destroys the session entirely.
 */
app.post("/logout", (req, res) => {
    req.session.destroy();
    res.json({ message: "Logged out" });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
