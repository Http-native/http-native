# http-native Examples

A collection of examples demonstrating every feature of http-native.

## Running Examples

Each example is a standalone server. Run with Bun:

```bash
bun examples/01-hello-world/server.js
```

## Examples

| # | Example | Features |
|---|---------|----------|
| 01 | [Hello World](./01-hello-world/) | Basic server, `createApp()`, `res.json()` |
| 02 | [Route Params](./02-route-params/) | `:param` syntax, `req.params`, multi-param routes |
| 03 | [HTTP Methods](./03-http-methods/) | GET, POST, PUT, PATCH, DELETE, `req.json()` |
| 04 | [Middleware](./04-middleware/) | `app.use()`, path-scoped middleware, `next()` |
| 05 | [Error Handling](./05-error-handling/) | `app.error()`, `app.404()`, custom error responses |
| 06 | [CORS](./06-cors/) | `cors()` middleware, origins, credentials, preflight |
| 07 | [Route Groups](./07-route-groups/) | `app.group()`, nested prefixes, API versioning |
| 08 | [Query Params](./08-query-params/) | `req.query`, multi-value arrays, URL encoding |
| 09 | [Request Body](./09-request-body/) | `req.json()`, `req.text()`, `req.body`, `req.arrayBuffer()` |
| 10 | [Native Cache](./10-native-cache/) | `res.ncache()`, route-level `cache` option, LRU |
| 11 | [Sessions](./11-sessions/) | `session()` middleware, `req.session`, HMAC cookies |
| 12 | [Streaming](./12-streaming/) | `res.stream()`, chunked transfer, SSE |
| 13 | [Response Types](./13-response-types/) | `res.send()`, `res.type()`, `res.set()`, `res.locals` |
| 14 | [Validation](./14-validation/) | `validate()` middleware, body/params/query schemas |
| 15 | [Optimizations](./15-optimizations/) | Static/dynamic fast-path, `opt`, runtime cache |
