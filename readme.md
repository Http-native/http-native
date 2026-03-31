<p align="center">
  <img src="https://cf-data.pkg.lat/httpnative-banner.png" style="width: 600px; height: 450px; object-fit: cover;" />
</p>

# @http-native/core

A fast, Express-like HTTP framework for JavaScript powered by a Rust native module via napi-rs.

## Install

```sh
bun add @http-native/core
```

Native binaries are downloaded automatically during install for your OS/arch.
If you need to repair/re-download manually:

```sh
http-native setup --force
```

## Usage

```js
import { createApp } from "@http-native/core";

const app = createApp();

app.get("/", async (req, res) => {
  res.json({ ok: true });
});

app.get("/user/:id", async (req, res) => {
  res.json({ id: req.params.id });
});

app.error(async (error, req, res) => {
  res.status(500).json({ error: error.message });
});

const server = await app.listen().port(8190);
console.log(`Listening on ${server.url}`);
```

## Imports

```js
import { createApp } from "@http-native/core";
import cors from "@http-native/core/cors";
import { validate } from "@http-native/core/validate";
import httpServerConfig from "@http-native/core/http-server.config";
```

## Optimizations

```js
const app = createApp({
  dev: {
    logger: true, // default
    devComments: true,
  },
});

const server = await app.listen().port(8190);

console.log(server.optimizations.summary());
console.log(server.optimizations.snapshot());
```

## Dev Reload

```sh
http-native dev ./server.js --port 3000
```

```js
import { createDevServer } from "@http-native/core/dev";

const dev = await createDevServer({
  entry: "./server.js",
  port: 3000,
});

console.log(dev.status());
```

You can define reload behavior on the app itself:

```js
const app = createApp().reload({
  files: ["src", "routes", "rsrc/src"],
  debounceMs: 80,
  clear: true,
});
```

`createDevServer()` and `http-native dev` keep the current runtime. If you launch with Bun, reload stays on Bun. If you launch with Node, reload stays on Node.

For existing self-starting apps, runtime hot reload still works:

```js
await app.listen().hot();
```
