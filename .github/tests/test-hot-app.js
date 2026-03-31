import { createApp } from "../../src/index.js";

const app = createApp({
  dev: {
    devComments: false,
  },
});

app.get("/", (req, res) => {
  res.json({ hello: "world", time: Date.now() });
});

const server = await app.listen().port(3000);
console.log("Server running at " + server.url);
