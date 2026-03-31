import { createApp } from "http-native";

const startedAt = Date.now();
const app = createApp().reload({
  files: ["src", "routes", "rsrc/src"],
  debounceMs: 80,
  clear: true,
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    runtime: process.release?.name ?? "unknown",
    pid: process.pid,
    startedAt,
    now: Date.now(),
  });
});

app.get("/health", (req, res) => {
  res.send("ok");
});

const server = await app.listen({ port: 3000 }).hot();
console.log(`[reload-example] listening at ${server.url}`);
console.log("[reload-example] edit files under src/routes/rsrc/src to trigger reload");
