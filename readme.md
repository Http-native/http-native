<p align="center">
  <img src="https://cf-data.pkg.lat/httpnative-banner.png" alt="Http-native banner" width="720" />
</p>

| http-native | static | 95,366.30 | 2.09 | 61.65 | 14.55 |
| http-native | dynamic | 46,880.14 | 4.26 | 23.99 | 7.19 |
| http-native | opt | 68,364.14 | 2.92 | 19.77 | 11.86 |
| bun | static | 50,728.86 | 3.94 | 10.72 | 7.93 |
| bun | dynamic | 46,020.19 | 4.34 | 10.80 | 7.24 |
| bun | opt | 50,000.29 | 4.00 | 12.41 | 8.87 |
| fiber | static | 91,129.18 | 2.19 | 25.62 | 13.22 |
| fiber | dynamic | 89,940.82 | 2.22 | 22.58 | 13.12 |
| fiber | opt | 88,203.77 | 2.26 | 23.64 | 14.63 |

Http-native

Http native is a express like server framework for Javascript that uses the Node-compatible framework with Rust native module way, where the rust binary is evoked through napi-rs or something faster.

You can also import the default server tuning config and override it before `listen()`:

```js
import httpServerConfig from "http-native/http-server.config";
```

Rust handler (http) <-> (javascript logic) 

The rust server handles all the http, while the core javascript logic is run sperately (EXREMELY fast)

Extrat performance features:

    1) Ahead of time constant data indentification. (If the data in the route's logic isn't manipulated at runtime we directly store it in rust so we don't envoke the javascript logic)

    2) Faster than bun.server() aswell as fastify.

    3) Default async handling (Yes rust handles the async for you.)

So start by just writing 

```js
import { createApp } from "../src/index.js";

const db = {
  async getUser(id) {
    return {
      id,
      name: "Ada Lovelace",
      role: "admin",
    };
  },
};

const app = createApp();

app.use(async (req, res, next) => {
  res.header("x-powered-by", "http-native");
  await next();
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    engine: "rust",
    bridge: "napi-rs",
  });
});

app.get("/users/:id", async (req, res) => {
  const user = await db.getUser(req.params.id);
  res.json(user);
});

const server = await app.listen({
  port: 3001,
  serverConfig: {
    ...httpServerConfig,
    maxHeaderBytes: 32 * 1024,
  },
});
```

Runtime optimization reporting:

```js
console.log(server.optimizations.summary());
console.log(server.optimizations.snapshot());
```

Pass `opt: { notify: true }` to `listen()` if you want runtime logs when a route is already native static or looks stable enough to cache later.


This should outperform the OLD shit code (found in old/), and be 50% faster than bun.server(), write tests in test.js plus add benchmarks so we know its faster than bun.

Remeber nadhi u moron this will be a library so don't go around doing shit.
