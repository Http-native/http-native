/**
 * 03 — HTTP Methods
 *
 * Demonstrates all supported HTTP methods: GET, POST, PUT,
 * DELETE, PATCH, OPTIONS, and the catch-all `all()`.
 *
 * Run:
 *   bun examples/03-http-methods/server.js
 *
 * Test:
 *   curl http://localhost:3000/items
 *   curl -X POST -H "Content-Type: application/json" -d '{"name":"Widget"}' http://localhost:3000/items
 *   curl -X PUT -H "Content-Type: application/json" -d '{"name":"Gadget"}' http://localhost:3000/items/1
 *   curl -X DELETE http://localhost:3000/items/1
 *   curl -X PATCH -H "Content-Type: application/json" -d '{"name":"Updated"}' http://localhost:3000/items/1
 */

import { createApp } from "@http-native/core";

const app = createApp();

/** In-memory store for demonstration */
const items = new Map();
let nextId = 1;

/**
 * GET /items — List all items
 */
app.get("/items", (req, res) => {
    res.json({ items: [...items.values()] });
});

/**
 * POST /items — Create a new item
 * Reads the JSON body via req.json()
 */
app.post("/items", (req, res) => {
    const body = req.json();
    if (!body || !body.name) {
        return res.status(400).json({ error: "name is required" });
    }

    const id = String(nextId++);
    const item = { id, name: body.name };
    items.set(id, item);

    res.status(201).json(item);
});

/**
 * PUT /items/:id — Replace an item
 */
app.put("/items/:id", (req, res) => {
    const body = req.json();
    if (!body || !body.name) {
        return res.status(400).json({ error: "name is required" });
    }

    const item = { id: req.params.id, name: body.name };
    items.set(req.params.id, item);

    res.json(item);
});

/**
 * PATCH /items/:id — Partially update an item
 */
app.patch("/items/:id", (req, res) => {
    const existing = items.get(req.params.id);
    if (!existing) {
        return res.status(404).json({ error: "Item not found" });
    }

    const body = req.json();
    const updated = { ...existing, ...body };
    items.set(req.params.id, updated);

    res.json(updated);
});

/**
 * DELETE /items/:id — Delete an item
 */
app.delete("/items/:id", (req, res) => {
    const existed = items.delete(req.params.id);
    if (!existed) {
        return res.status(404).json({ error: "Item not found" });
    }

    res.json({ deleted: true });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
