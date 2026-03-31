/**
 * 12 — Streaming Responses
 *
 * Demonstrates the res.stream() API for chunked transfer-encoded
 * responses. Useful for server-sent events, large file downloads,
 * or real-time data feeds.
 *
 * Run:
 *   bun examples/12-streaming/server.js
 *
 * Test:
 *   curl http://localhost:3000/stream
 *   curl http://localhost:3000/countdown
 *   curl http://localhost:3000/sse
 */

import { createApp } from "@http-native/core";

const app = createApp();

/**
 * Basic streaming — sends chunks with delays.
 * Uses HTTP/1.1 chunked transfer encoding.
 */
app.get("/stream", async (req, res) => {
    const stream = res.stream({ contentType: "text/plain; charset=utf-8" });
    if (!stream) return;

    for (let i = 1; i <= 5; i++) {
        stream.write(`Chunk ${i} of 5\n`);
        await sleep(500);
    }

    stream.end("Done!\n");
});

/**
 * Countdown timer — streams numbers in real-time.
 */
app.get("/countdown", async (req, res) => {
    const stream = res.stream({ contentType: "text/plain; charset=utf-8" });
    if (!stream) return;

    for (let i = 10; i >= 1; i--) {
        stream.write(`${i}...\n`);
        await sleep(1000);
    }

    stream.end("Liftoff! 🚀\n");
});

/**
 * Server-Sent Events (SSE) — real-time event stream.
 * Connect with EventSource in the browser or curl.
 */
app.get("/sse", async (req, res) => {
    const stream = res
        .set("Cache-Control", "no-cache")
        .set("Connection", "keep-alive")
        .stream({ contentType: "text/event-stream" });
    if (!stream) return;

    for (let i = 0; i < 10; i++) {
        const event = `data: ${JSON.stringify({ time: new Date().toISOString(), count: i })}\n\n`;
        stream.write(event);
        await sleep(1000);
    }

    stream.end("event: close\ndata: stream ended\n\n");
});

/**
 * Helper — async sleep.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = await app.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
