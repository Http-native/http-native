/**
 * 09 — Request Body Parsing
 *
 * Demonstrates the built-in body parsing APIs: req.json(),
 * req.text(), req.body (raw Buffer), and req.arrayBuffer().
 * No external body-parser middleware needed.
 *
 * Run:
 *   bun examples/09-request-body/server.js
 *
 * Test:
 *   curl -X POST -H "Content-Type: application/json" -d '{"name":"Alice","age":30}' http://localhost:3000/json
 *   curl -X POST -H "Content-Type: text/plain" -d "Hello, World!" http://localhost:3000/text
 *   curl -X POST -H "Content-Type: application/octet-stream" --data-binary @package.json http://localhost:3000/raw
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * JSON body parsing via req.json().
 * Automatically parses the request body as JSON.
 */
app.post("/json", (req, res) => {
    const data = req.json();
    if (!data) {
        return res.status(400).json({ error: "Invalid or missing JSON body" });
    }

    res.json({
        received: data,
        type: "json",
        keys: Object.keys(data),
    });
});

/**
 * Text body parsing via req.text().
 * Returns the body as a UTF-8 string.
 */
app.post("/text", (req, res) => {
    const text = req.text();

    res.json({
        received: text,
        type: "text",
        length: text.length,
    });
});

/**
 * Raw body access via req.body (Buffer).
 * Useful for binary data like file uploads.
 */
app.post("/raw", (req, res) => {
    const body = req.body;

    res.json({
        type: "raw",
        size: body ? body.length : 0,
        isBuffer: Buffer.isBuffer(body),
    });
});

/**
 * ArrayBuffer access via req.arrayBuffer().
 * Useful for WebAssembly or typed array processing.
 */
app.post("/arraybuffer", (req, res) => {
    const ab = req.arrayBuffer();

    res.json({
        type: "arraybuffer",
        byteLength: ab.byteLength,
    });
});

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
