const HOT_HIT_THRESHOLD = 128;
const STABLE_RESPONSE_THRESHOLD = 32;

export function createRuntimeOptimizer(routes, middlewares, options = {}) {
  const notify = options.notify === true || process.env.HTTP_NATIVE_OPT_NOTIFY === "1";
  const routeEntries = routes.map((route) => buildRouteEntry(route, middlewares));
  const routesByHandlerId = new Map(routeEntries.map((entry) => [entry.handlerId, entry]));

  return {
    recordDispatch(route, _request, snapshot) {
      const entry = routesByHandlerId.get(route.handlerId);
      if (!entry) {
        return;
      }

      entry.hits += 1;
      entry.lastHitAt = new Date().toISOString();
      entry.jsBridgeObserved = true;

      if (entry.stage === "cold" && entry.hits >= HOT_HIT_THRESHOLD) {
        entry.stage = "hot";
        maybeNotify(
          notify,
          entry,
          entry.nativeStaticHot
            ? `${entry.label} is serving from native static bytes`
            : `${entry.label} is hot on the JS bridge`,
        );
      }

      if (!entry.cacheCandidate) {
        return;
      }

      const responseKey = buildResponseKey(snapshot);
      if (entry.lastResponseKey === responseKey) {
        entry.stableResponses += 1;
      } else {
        entry.lastResponseKey = responseKey;
        entry.stableResponses = 1;
      }

      if (
        entry.recommendation === null &&
        entry.stableResponses >= STABLE_RESPONSE_THRESHOLD
      ) {
        entry.recommendation = "cache-candidate";
        maybeNotify(
          notify,
          entry,
          `${entry.label} looks stable at runtime; cached values may be safe`,
        );
      }
    },

    snapshot() {
      return {
        generatedAt: new Date().toISOString(),
        routes: routeEntries.map((entry) => ({
          method: entry.method,
          path: entry.path,
          label: entry.label,
          stage: entry.stage,
          hits: entry.hits,
          nativeStaticHot: entry.nativeStaticHot,
          jsBridgeObserved: entry.jsBridgeObserved,
          cacheCandidate: entry.cacheCandidate,
          recommendation: entry.recommendation,
          reasons: [...entry.reasons],
          lastHitAt: entry.lastHitAt,
        })),
      };
    },

    summary() {
      return routeEntries
        .map((entry) => {
          const flags = [];
          if (entry.nativeStaticHot) {
            flags.push("native-static-hot");
          } else {
            flags.push("js-bridge");
          }
          if (entry.jsBridgeObserved) {
            flags.push("bridge-observed");
          }
          if (entry.cacheCandidate) {
            flags.push("cache-candidate");
          }
          if (entry.recommendation) {
            flags.push(entry.recommendation);
          }
          const uniqueFlags = [...new Set(flags)];
          return `${entry.label} [${uniqueFlags.join(", ")}] hits=${entry.hits}`;
        })
        .join("\n");
    },
  };
}

function buildRouteEntry(route, middlewares) {
  const hasParams = route.path.includes(":");
  const hasMiddleware = middlewares.some((middleware) =>
    pathPrefixMatches(middleware.pathPrefix, route.path),
  );
  const source = route.handlerSource ?? "";
  const nativeStaticHot = isNativeStaticHotCandidate(route, hasMiddleware, source);
  const cacheCandidate =
    !nativeStaticHot &&
    route.method === "GET" &&
    !hasParams &&
    !hasMiddleware &&
    !source.includes("await") &&
    !/req\.(params|query|body|headers|url|path|method)\b/.test(source) &&
    !/Date\.now|new Date|Math\.random|crypto\./.test(source);

  const reasons = [];
  if (nativeStaticHot) {
    reasons.push("served by native static hot path");
  } else {
    reasons.push("served through JS bridge");
  }
  if (hasMiddleware) {
    reasons.push("middleware blocks static promotion");
  }
  if (hasParams) {
    reasons.push("route params require dynamic dispatch");
  }
  if (cacheCandidate) {
    reasons.push("runtime-stable responses can be cached later");
  }

  return {
    handlerId: route.handlerId,
    method: route.method,
    path: route.path,
    label: `${route.method} ${route.path}`,
    stage: "cold",
    hits: 0,
    lastHitAt: null,
    nativeStaticHot,
    jsBridgeObserved: false,
    cacheCandidate,
    recommendation: null,
    reasons,
    stableResponses: 0,
    lastResponseKey: null,
  };
}

function isNativeStaticHotCandidate(route, hasMiddleware, source) {
  if (route.method !== "GET" || route.path.includes(":") || hasMiddleware) {
    return false;
  }

  if (source.includes("await")) {
    return false;
  }

  const body = trimReturnAndSemicolon(extractFunctionBody(source));
  if (!body) {
    return false;
  }

  return (
    isDirectLiteralCall(body, "res.json(") ||
    isDirectLiteralCall(body, "res.send(") ||
    isDirectStatusLiteralCall(body, "json") ||
    isDirectStatusLiteralCall(body, "send")
  );
}

function extractFunctionBody(source) {
  const arrowIndex = source.indexOf("=>");
  if (arrowIndex >= 0) {
    const right = source.slice(arrowIndex + 2).trim();
    if (right.startsWith("{") && right.endsWith("}")) {
      return right.slice(1, -1).trim();
    }
    return right;
  }

  const blockStart = source.indexOf("{");
  const blockEnd = source.lastIndexOf("}");
  if (blockStart >= 0 && blockEnd > blockStart) {
    return source.slice(blockStart + 1, blockEnd).trim();
  }

  return source.trim();
}

function trimReturnAndSemicolon(body) {
  let value = body.trim();
  if (value.startsWith("return ")) {
    value = value.slice("return ".length).trim();
  }
  if (value.endsWith(";")) {
    value = value.slice(0, -1).trim();
  }
  return value;
}

function isDirectLiteralCall(body, prefix) {
  if (!body.startsWith(prefix) || !body.endsWith(")")) {
    return false;
  }

  const payload = body.slice(prefix.length, -1).trim();
  return looksLiteralPayload(payload);
}

function isDirectStatusLiteralCall(body, method) {
  if (!body.startsWith("res.status(") || !body.endsWith(")")) {
    return false;
  }

  const separator = `).${method}(`;
  const separatorIndex = body.indexOf(separator);
  if (separatorIndex < 0) {
    return false;
  }

  const payload = body.slice(separatorIndex + separator.length, -1).trim();
  return looksLiteralPayload(payload);
}

function looksLiteralPayload(payload) {
  if (!payload) {
    return false;
  }

  if (
    payload.startsWith("{") ||
    payload.startsWith("[") ||
    payload.startsWith('"') ||
    payload.startsWith("'") ||
    payload.startsWith("`")
  ) {
    return true;
  }

  if (/^-?\d/.test(payload)) {
    return true;
  }

  return payload === "true" || payload === "false" || payload === "null";
}

function buildResponseKey(snapshot) {
  return JSON.stringify({
    status: snapshot.status,
    headers: snapshot.headers,
    bodyBase64: snapshot.bodyBase64,
  });
}

function maybeNotify(notify, entry, message) {
  if (!notify) {
    return;
  }

  console.log(`[http-native][opt] ${message}`);
}

function pathPrefixMatches(pathPrefix, requestPath) {
  if (pathPrefix === "/") {
    return true;
  }

  return requestPath === pathPrefix || requestPath.startsWith(`${pathPrefix}/`);
}
