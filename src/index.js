import { loadNativeModule } from "./native.js";
import defaultHttpServerConfig, {
  normalizeHttpServerConfig,
} from "./http-server.config.js";
import { createRuntimeOptimizer } from "../opt/runtime.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
const ACTIVE_NATIVE_SERVERS = new Set();

function normalizePathPrefix(path) {
  if (path === "/") {
    return "/";
  }

  const trimmed = String(path).replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeRoutePath(method, path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError(`Route path for ${method} must start with "/"`);
  }

  return normalizePathPrefix(path);
}

function pathPrefixMatches(pathPrefix, requestPath) {
  if (pathPrefix === "/") {
    return true;
  }

  return requestPath === pathPrefix || requestPath.startsWith(`${pathPrefix}/`);
}

function headerAccessor(headers, name) {
  const key = String(name).toLowerCase();
  return headers[key];
}

function normalizeContentType(type) {
  if (type.includes("/")) {
    return type;
  }

  if (type === "json") {
    return "application/json; charset=utf-8";
  }

  if (type === "html") {
    return "text/html; charset=utf-8";
  }

  if (type === "text") {
    return "text/plain; charset=utf-8";
  }

  return type;
}

function createResponseEnvelope() {
  const state = {
    status: 200,
    headers: {},
    body: Buffer.alloc(0),
    finished: false,
    locals: {},
  };

  const response = {
    locals: state.locals,

    get finished() {
      return state.finished;
    },

    status(code) {
      state.status = Number(code);
      return response;
    },

    set(name, value) {
      state.headers[String(name).toLowerCase()] = String(value);
      return response;
    },

    header(name, value) {
      return response.set(name, value);
    },

    get(name) {
      return state.headers[String(name).toLowerCase()];
    },

    type(value) {
      return response.set("content-type", normalizeContentType(String(value)));
    },

    json(data) {
      if (state.finished) {
        return response;
      }

      if (!state.headers["content-type"]) {
        state.headers["content-type"] = "application/json; charset=utf-8";
      }

      state.body = Buffer.from(JSON.stringify(data), "utf8");
      state.finished = true;
      return response;
    },

    send(data) {
      if (state.finished) {
        return response;
      }

      if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
        if (!state.headers["content-type"]) {
          state.headers["content-type"] = "application/octet-stream";
        }
        state.body = Buffer.from(data);
      } else if (typeof data === "string") {
        if (!state.headers["content-type"]) {
          state.headers["content-type"] = "text/plain; charset=utf-8";
        }
        state.body = Buffer.from(data, "utf8");
      } else if (data === undefined || data === null) {
        state.body = Buffer.alloc(0);
      } else {
        return response.json(data);
      }

      state.finished = true;
      return response;
    },

    sendStatus(code) {
      response.status(code);
      if (!state.headers["content-type"]) {
        state.headers["content-type"] = "text/plain; charset=utf-8";
      }
      return response.send(String(code));
    },
  };

  return {
    response,
    snapshot() {
      return {
        status: state.status,
        headers: state.headers,
        bodyBase64: state.body.toString("base64"),
      };
    },
  };
}

async function runMiddlewares(middlewares, req, res) {
  const matchedMiddlewares = middlewares.filter((middleware) =>
    pathPrefixMatches(middleware.pathPrefix, req.path),
  );

  let index = -1;

  async function dispatch(position) {
    if (position <= index) {
      throw new Error("Middleware next() called multiple times");
    }

    index = position;
    const middleware = matchedMiddlewares[position];
    if (!middleware || res.finished) {
      return;
    }

    if (middleware.handler.length >= 3) {
      await middleware.handler(req, res, () => dispatch(position + 1));
      return;
    }

    await middleware.handler(req, res);
    if (!res.finished) {
      await dispatch(position + 1);
    }
  }

  await dispatch(0);
}

function buildRequest(request) {
  return {
    method: request.method,
    path: request.path,
    url: request.url,
    params: request.params ?? {},
    query: request.query ?? {},
    headers: request.headers ?? {},
    header(name) {
      return headerAccessor(request.headers ?? {}, name);
    },
  };
}

function serializeErrorResponse(error) {
  return JSON.stringify({
    status: 500,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    bodyBase64: Buffer.from(
      JSON.stringify({
        error: "Internal Server Error",
        detail: error instanceof Error ? error.message : String(error),
      }),
      "utf8",
    ).toString("base64"),
  });
}

function createDispatcher(routes, middlewares, runtimeOptimizer) {
  const routesById = new Map(routes.map((route) => [route.handlerId, route]));

  return async function dispatch(requestJson) {
    let parsed;

    try {
      parsed = JSON.parse(requestJson);
    } catch (error) {
      return serializeErrorResponse(error);
    }

    const route = routesById.get(parsed.handlerId);
    if (!route) {
      return serializeErrorResponse(new Error(`Unknown handler id ${parsed.handlerId}`));
    }

    const req = buildRequest(parsed);
    const { response: res, snapshot } = createResponseEnvelope();

    try {
      await runMiddlewares(middlewares, req, res);
      if (!res.finished) {
        await route.handler(req, res);
      }
    } catch (error) {
      if (!res.finished) {
        return serializeErrorResponse(error);
      }
    }

    const responseSnapshot = snapshot();
    runtimeOptimizer?.recordDispatch(route, req, responseSnapshot);
    return JSON.stringify(responseSnapshot);
  };
}

function normalizeRouteRegistration(method, path, handler) {
  if (typeof handler !== "function") {
    throw new TypeError(`Handler for ${method} ${path} must be a function`);
  }

  return {
    method,
    path: normalizeRoutePath(method, path),
    handler,
  };
}

function createMethodRegistrar(app, method) {
  return (path, handler) => {
    if (method === "ALL") {
      for (const concreteMethod of HTTP_METHODS) {
        app._routes.push(normalizeRouteRegistration(concreteMethod, path, handler));
      }
      return app;
    }

    app._routes.push(normalizeRouteRegistration(method, path, handler));
    return app;
  };
}

function normalizeListenOptions(options = {}) {
  const serverConfig = normalizeHttpServerConfig(
    options.serverConfig ?? options.httpServerConfig ?? defaultHttpServerConfig,
  );

  return {
    host: options.host ?? serverConfig.defaultHost,
    port: Number(options.port ?? 3000),
    backlog:
      options.backlog === undefined || options.backlog === null
        ? serverConfig.defaultBacklog
        : Number(options.backlog),
    opt: options.opt ?? {},
    serverConfig,
  };
}

export function createApp() {
  const native = loadNativeModule();
  let nextHandlerId = 1;

  const app = {
    _routes: [],
    _middlewares: [],

    use(pathOrMiddleware, maybeMiddleware) {
      let pathPrefix = "/";
      let handler = pathOrMiddleware;

      if (typeof pathOrMiddleware === "string") {
        pathPrefix = normalizePathPrefix(pathOrMiddleware);
        handler = maybeMiddleware;
      }

      if (typeof handler !== "function") {
        throw new TypeError("Middleware must be a function");
      }

      this._middlewares.push({ pathPrefix, handler });
      return this;
    },

    get: undefined,
    post: undefined,
    put: undefined,
    delete: undefined,
    patch: undefined,
    options: undefined,
    all: undefined,

    async listen(options = {}) {
      const normalizedOptions = normalizeListenOptions(options);

      const routes = this._routes.map((route) => ({
        ...route,
        handlerId: nextHandlerId++,
        handlerSource: Function.prototype.toString.call(route.handler),
      }));

      const manifest = {
        version: 1,
        serverConfig: normalizedOptions.serverConfig,
        middlewares: this._middlewares.map((middleware) => ({
          pathPrefix: middleware.pathPrefix,
        })),
        routes: routes.map((route) => ({
          method: route.method,
          path: route.path,
          handlerId: route.handlerId,
          handlerSource: route.handlerSource,
        })),
      };

      const runtimeOptimizer = createRuntimeOptimizer(
        routes,
        this._middlewares,
        normalizedOptions.opt,
      );
      const dispatcher = createDispatcher(routes, this._middlewares, runtimeOptimizer);
      const handle = native.startServer(JSON.stringify(manifest), dispatcher, {
        host: normalizedOptions.host,
        port: normalizedOptions.port,
        backlog: normalizedOptions.backlog,
      });
      ACTIVE_NATIVE_SERVERS.add(handle);

      return {
        host: handle.host,
        port: handle.port,
        url: handle.url,
        _handle: handle,
        optimizations: {
          snapshot() {
            return runtimeOptimizer.snapshot();
          },
          summary() {
            return runtimeOptimizer.summary();
          },
        },
        close() {
          ACTIVE_NATIVE_SERVERS.delete(handle);
          return handle.close();
        },
      };
    },
  };

  app.get = createMethodRegistrar(app, "GET");
  app.post = createMethodRegistrar(app, "POST");
  app.put = createMethodRegistrar(app, "PUT");
  app.delete = createMethodRegistrar(app, "DELETE");
  app.patch = createMethodRegistrar(app, "PATCH");
  app.options = createMethodRegistrar(app, "OPTIONS");
  app.all = createMethodRegistrar(app, "ALL");

  return app;
}
