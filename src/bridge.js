import { Buffer } from "node:buffer";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PLAIN_OBJECT_PROTOTYPE = Object.prototype;
const EMPTY_ARRAY = Object.freeze([]);

export const BRIDGE_VERSION = 1;
export const REQUEST_FLAG_QUERY_PRESENT = 1 << 0;

export const METHOD_CODES = Object.freeze({
  GET: 1,
  POST: 2,
  PUT: 3,
  DELETE: 4,
  PATCH: 5,
  OPTIONS: 6,
  HEAD: 7,
});

export const ROUTE_KIND = Object.freeze({
  EXACT: 1,
  PARAM: 2,
});

const EMPTY_OBJECT = Object.freeze({});

const PARAM_DOT_RE = /\breq\.params\.([A-Za-z_$][\w$]*)\b/g;
const PARAM_BRACKET_RE = /\breq\.params\[(["'])([^"'\\]+)\1\]/g;
const QUERY_DOT_RE = /\breq\.query\.([A-Za-z_$][\w$]*)\b/g;
const QUERY_BRACKET_RE = /\breq\.query\[(["'])([^"'\\]+)\1\]/g;
const HEADER_DOT_RE = /\breq\.headers\.([A-Za-z_$][\w$]*)\b/g;
const HEADER_BRACKET_RE = /\breq\.headers\[(["'])([^"'\\]+)\1\]/g;
const HEADER_CALL_RE = /\breq\.header\((["'])([^"'\\]+)\1\)/g;

export function compileRouteShape(method, path) {
  const methodCode = METHOD_CODES[method];
  if (!methodCode) {
    throw new TypeError(`Unsupported method code for ${method}`);
  }

  const segments =
    path === "/"
      ? []
      : path
          .slice(1)
          .split("/")
          .filter(Boolean);
  const paramNames = [];

  for (const segment of segments) {
    if (segment.startsWith(":")) {
      paramNames.push(segment.slice(1));
    }
  }

  return {
    methodCode,
    routeKind: paramNames.length === 0 ? ROUTE_KIND.EXACT : ROUTE_KIND.PARAM,
    paramNames,
    segmentCount: segments.length,
  };
}

export function analyzeRequestAccess(source) {
  const plan = createEmptyAccessPlan();
  const normalizedSource = String(source ?? "");

  plan.method = /\breq\.method\b/.test(normalizedSource);
  plan.path = /\breq\.path\b/.test(normalizedSource);
  plan.url = /\breq\.url\b/.test(normalizedSource);

  if (/\{[^}]*\}\s*=\s*req\b/.test(normalizedSource)) {
    plan.method = true;
    plan.path = true;
    plan.url = true;
    plan.fullParams = true;
    plan.fullQuery = true;
    plan.fullHeaders = true;
    plan.dispatchKind = "generic_fallback";
  }

  collectMatches(normalizedSource, PARAM_DOT_RE, plan.paramKeys, identity);
  collectMatches(normalizedSource, PARAM_BRACKET_RE, plan.paramKeys, identity, 2);
  collectMatches(normalizedSource, QUERY_DOT_RE, plan.queryKeys, identity);
  collectMatches(normalizedSource, QUERY_BRACKET_RE, plan.queryKeys, identity, 2);
  collectMatches(normalizedSource, HEADER_DOT_RE, plan.headerKeys, normalizeHeaderLookup);
  collectMatches(normalizedSource, HEADER_BRACKET_RE, plan.headerKeys, normalizeHeaderLookup, 2);
  collectMatches(normalizedSource, HEADER_CALL_RE, plan.headerKeys, normalizeHeaderLookup, 2);

  if (/\breq\.params\b(?!\s*(?:\.|\[))/.test(normalizedSource) || /\breq\.params\[(?!["'])/.test(normalizedSource)) {
    plan.fullParams = true;
    plan.dispatchKind = "generic_fallback";
  }

  if (/\breq\.query\b(?!\s*(?:\.|\[))/.test(normalizedSource) || /\breq\.query\[(?!["'])/.test(normalizedSource)) {
    plan.fullQuery = true;
    plan.dispatchKind = "generic_fallback";
  }

  if (/\breq\.headers\b(?!\s*(?:\.|\[))/.test(normalizedSource) || /\breq\.headers\[(?!["'])/.test(normalizedSource)) {
    plan.fullHeaders = true;
    plan.dispatchKind = "generic_fallback";
  }

  if (/\breq\s*\[(["'])[^"'\\]+\1\]/.test(normalizedSource) || /\breq\s*\[(?!["'])/.test(normalizedSource)) {
    plan.method = true;
    plan.path = true;
    plan.url = true;
    plan.fullParams = true;
    plan.fullQuery = true;
    plan.fullHeaders = true;
    plan.dispatchKind = "generic_fallback";
  }

  if (/\breq\.header\((?!["'])/.test(normalizedSource)) {
    plan.fullHeaders = true;
    plan.dispatchKind = "generic_fallback";
  }

  plan.jsonFastPath = detectJsonFastPath(normalizedSource);
  return freezeAccessPlan(plan);
}

export function mergeRequestAccessPlans(plans) {
  const merged = createEmptyAccessPlan();

  for (const plan of plans) {
    if (!plan) {
      continue;
    }

    merged.method ||= plan.method === true;
    merged.path ||= plan.path === true;
    merged.url ||= plan.url === true;
    merged.fullParams ||= plan.fullParams === true;
    merged.fullQuery ||= plan.fullQuery === true;
    merged.fullHeaders ||= plan.fullHeaders === true;
    if (plan.dispatchKind === "generic_fallback") {
      merged.dispatchKind = "generic_fallback";
    }
    if (plan.jsonFastPath === "specialized") {
      merged.jsonFastPath = "specialized";
    } else if (plan.jsonFastPath === "generic" && merged.jsonFastPath === "fallback") {
      merged.jsonFastPath = "generic";
    }
    addSetEntries(merged.paramKeys, plan.paramKeys);
    addSetEntries(merged.queryKeys, plan.queryKeys);
    addSetEntries(merged.headerKeys, plan.headerKeys);
  }

  return freezeAccessPlan(merged);
}

export function createRequestFactory(
  plan,
  routeParamNames = EMPTY_ARRAY,
  routeMethod = "GET",
) {
  return function buildRequest(decoded) {
    const needsParams = plan.fullParams || plan.paramKeys.size > 0;
    const needsQuery = plan.fullQuery || plan.queryKeys.size > 0;
    const needsHeaders = plan.fullHeaders || plan.headerKeys.size > 0;

    let path;
    let url;
    let params;
    let query;
    let headers;

    function decodePath() {
      if (path === undefined) {
        path = textDecoder.decode(decoded.pathBytes);
      }
      return path;
    }

    function decodeUrl() {
      if (url === undefined) {
        url = textDecoder.decode(decoded.urlBytes);
      }
      return url;
    }

    const request = {
      method: routeMethod,

      get path() {
        return decodePath();
      },

      get url() {
        return decodeUrl();
      },

      get params() {
        if (params === undefined) {
          params = needsParams
            ? materializeParamObject(decoded.paramValues, routeParamNames, plan)
            : EMPTY_OBJECT;
        }
        return params;
      },

      get query() {
        if (query === undefined) {
          query = needsQuery
            ? materializeQueryObject(decodeUrl(), decoded.flags, plan)
            : EMPTY_OBJECT;
        }
        return query;
      },

      get headers() {
        if (headers === undefined) {
          headers = needsHeaders
            ? materializeHeaderObject(decoded.rawHeaders, plan)
            : EMPTY_OBJECT;
        }
        return headers;
      },

      header(name) {
        const lookup = normalizeHeaderLookup(name);
        if (headers && lookup in headers) {
          return headers[lookup];
        }
        if (decoded.rawHeaders.length === 0) {
          return undefined;
        }
        return lookupHeaderValue(decoded.rawHeaders, lookup);
      },
    };

    return request;
  };
}

export function createJsonSerializer(mode = "fallback") {
  if (mode === "fallback") {
    const serializer = (value) => {
      const serialized = JSON.stringify(value);
      return Buffer.from(serialized, "utf8");
    };
    serializer.kind = "fallback";
    return serializer;
  }

  const serializer = (value) => {
    const fastValue = trySerializeJsonFast(value);
    if (fastValue !== null) {
      return Buffer.from(fastValue, "utf8");
    }

    const serialized = JSON.stringify(value);
    return Buffer.from(serialized, "utf8");
  };
  serializer.kind = mode;
  return serializer;
}

export function decodeRequestEnvelope(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const version = readU8(view, offset);
  offset += 1;
  if (version !== BRIDGE_VERSION) {
    throw new Error(`Unsupported request envelope version ${version}`);
  }

  const methodCode = readU8(view, offset);
  offset += 1;
  const flags = readU16(view, offset);
  offset += 2;
  const handlerId = readU32(view, offset);
  offset += 4;
  const urlLength = readU32(view, offset);
  offset += 4;
  const pathLength = readU16(view, offset);
  offset += 2;
  const paramCount = readU16(view, offset);
  offset += 2;
  const headerCount = readU16(view, offset);
  offset += 2;

  const urlBytes = readBytes(bytes, offset, urlLength);
  offset += urlLength;
  const pathBytes = readBytes(bytes, offset, pathLength);
  offset += pathLength;

  const paramValues = new Array(paramCount);
  for (let index = 0; index < paramCount; index += 1) {
    const valueLength = readU16(view, offset);
    offset += 2;
    const valueBytes = readBytes(bytes, offset, valueLength);
    offset += valueLength;
    paramValues[index] = valueBytes;
  }

  const rawHeaders = new Array(headerCount);
  for (let index = 0; index < headerCount; index += 1) {
    const nameLength = readU8(view, offset);
    offset += 1;
    const valueLength = readU16(view, offset);
    offset += 2;
    const nameBytes = readBytes(bytes, offset, nameLength);
    offset += nameLength;
    const valueBytes = readBytes(bytes, offset, valueLength);
    offset += valueLength;
    rawHeaders[index] = [nameBytes, valueBytes];
  }

  switch (methodCode) {
    case METHOD_CODES.GET:
    case METHOD_CODES.POST:
    case METHOD_CODES.PUT:
    case METHOD_CODES.DELETE:
    case METHOD_CODES.PATCH:
    case METHOD_CODES.OPTIONS:
    case METHOD_CODES.HEAD:
      break;
    default:
      throw new Error(`Unknown method code ${methodCode}`);
  }

  return {
    handlerId,
    flags,
    methodCode,
    urlBytes,
    pathBytes,
    paramValues,
    rawHeaders,
  };
}

export function encodeResponseEnvelope(snapshot) {
  const headers = Object.entries(snapshot.headers ?? {}).map(([name, value]) => [
    encodeUtf8(name),
    encodeUtf8(String(value)),
  ]);
  const body = Buffer.isBuffer(snapshot.body)
    ? snapshot.body
    : snapshot.body instanceof Uint8Array
      ? Buffer.from(snapshot.body)
      : Buffer.alloc(0);

  let totalLength = 2 + 2 + 4 + body.length;
  for (const [nameBytes, valueBytes] of headers) {
    if (nameBytes.length > 0xff) {
      throw new Error(`Response header name too long: ${nameBytes.length}`);
    }
    if (valueBytes.length > 0xffff) {
      throw new Error(`Response header value too long: ${valueBytes.length}`);
    }
    totalLength += 1 + 2 + nameBytes.length + valueBytes.length;
  }

  const output = Buffer.allocUnsafe(totalLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  let offset = 0;

  writeU16(view, offset, Number(snapshot.status ?? 200));
  offset += 2;
  writeU16(view, offset, headers.length);
  offset += 2;
  writeU32(view, offset, body.length);
  offset += 4;

  for (const [nameBytes, valueBytes] of headers) {
    writeU8(view, offset, nameBytes.length);
    offset += 1;
    writeU16(view, offset, valueBytes.length);
    offset += 2;
    output.set(nameBytes, offset);
    offset += nameBytes.length;
    output.set(valueBytes, offset);
    offset += valueBytes.length;
  }

  output.set(body, offset);
  return output;
}

function materializeParamObject(entries, paramNames, plan) {
  if (plan.fullParams) {
    return materializeParamPairs(entries, paramNames);
  }

  return materializeSelectedParamPairs(entries, paramNames, plan.paramKeys);
}

function materializeHeaderObject(entries, plan) {
  if (plan.fullHeaders) {
    return materializePairs(entries, true);
  }

  return materializeSelectedPairs(entries, plan.headerKeys, true);
}

function materializeQueryObject(url, flags, plan) {
  if (!(flags & REQUEST_FLAG_QUERY_PRESENT)) {
    return {};
  }

  if (plan.fullQuery) {
    return parseQuery(url);
  }

  return parseSelectedQuery(url, plan.queryKeys);
}

function materializePairs(entries, lowerCaseKeys = false) {
  const result = {};

  for (const [rawName, rawValue] of entries) {
    const name = textDecoder.decode(rawName);
    const key = lowerCaseKeys ? name.toLowerCase() : name;
    result[key] = textDecoder.decode(rawValue);
  }

  return result;
}

function materializeParamPairs(entries, paramNames) {
  const result = {};

  for (let index = 0; index < entries.length; index += 1) {
    result[paramNames[index]] = textDecoder.decode(entries[index]);
  }

  return result;
}

function materializeSelectedParamPairs(entries, paramNames, selectedKeys) {
  if (selectedKeys.size === 0) {
    return {};
  }

  const result = {};
  for (let index = 0; index < entries.length; index += 1) {
    const key = paramNames[index];
    if (selectedKeys.has(key)) {
      result[key] = textDecoder.decode(entries[index]);
    }
  }

  return result;
}

function materializeSelectedPairs(entries, selectedKeys, lowerCaseKeys = false) {
  if (selectedKeys.size === 0) {
    return {};
  }

  const result = {};
  for (const [rawName, rawValue] of entries) {
    const name = textDecoder.decode(rawName);
    const key = lowerCaseKeys ? name.toLowerCase() : name;
    if (selectedKeys.has(key)) {
      result[key] = textDecoder.decode(rawValue);
    }
  }

  return result;
}

function parseQuery(url) {
  const queryStart = url.indexOf("?");
  if (queryStart < 0 || queryStart === url.length - 1) {
    return {};
  }

  const params = new URLSearchParams(url.slice(queryStart + 1));
  const result = {};

  for (const [key, value] of params) {
    pushQueryEntry(result, key, value);
  }

  return result;
}

function parseSelectedQuery(url, selectedKeys) {
  if (selectedKeys.size === 0) {
    return {};
  }

  const queryStart = url.indexOf("?");
  if (queryStart < 0 || queryStart === url.length - 1) {
    return {};
  }

  const params = new URLSearchParams(url.slice(queryStart + 1));
  const result = {};

  for (const [key, value] of params) {
    if (selectedKeys.has(key)) {
      pushQueryEntry(result, key, value);
    }
  }

  return result;
}

function pushQueryEntry(result, key, value) {
  if (key in result) {
    const current = result[key];
    if (Array.isArray(current)) {
      current.push(value);
    } else {
      result[key] = [current, value];
    }
    return;
  }

  result[key] = value;
}

function lookupHeaderValue(entries, targetName) {
  for (const [rawName, rawValue] of entries) {
    const name = textDecoder.decode(rawName).toLowerCase();
    if (name === targetName) {
      return textDecoder.decode(rawValue);
    }
  }

  return undefined;
}

function createEmptyAccessPlan() {
  return {
    method: false,
    path: false,
    url: false,
    fullParams: false,
    fullQuery: false,
    fullHeaders: false,
    paramKeys: new Set(),
    queryKeys: new Set(),
    headerKeys: new Set(),
    dispatchKind: "specialized",
    jsonFastPath: "fallback",
  };
}

function freezeAccessPlan(plan) {
  return Object.freeze({
    ...plan,
    paramKeys: new Set(plan.paramKeys),
    queryKeys: new Set(plan.queryKeys),
    headerKeys: new Set(plan.headerKeys),
  });
}

function collectMatches(source, expression, target, transform, groupIndex = 1) {
  for (const match of source.matchAll(expression)) {
    const value = match[groupIndex];
    if (value) {
      target.add(transform(value));
    }
  }
}

function normalizeHeaderLookup(value) {
  return String(value).toLowerCase();
}

function detectJsonFastPath(source) {
  if (!source.includes("res.json(")) {
    return "fallback";
  }

  if (/res\.json\(\s*[{[]/.test(source)) {
    return "specialized";
  }

  return "generic";
}

function addSetEntries(target, source) {
  if (!source) {
    return;
  }

  for (const value of source) {
    target.add(value);
  }
}

function trySerializeJsonFast(value) {
  const stack = new WeakSet();
  return serializeJsonValue(value, stack);
}

function serializeJsonValue(value, stack) {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? (Object.is(value, -0) ? "0" : String(value)) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
    case "function":
    case "symbol":
      return null;
    case "bigint":
      return null;
    case "object":
      break;
    default:
      return null;
  }

  if (typeof value.toJSON === "function") {
    return null;
  }

  if (Array.isArray(value)) {
    if (stack.has(value)) {
      return null;
    }

    stack.add(value);
    const items = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor && (descriptor.get || descriptor.set)) {
        stack.delete(value);
        return null;
      }

      const serialized = serializeJsonValue(value[index], stack);
      items[index] = serialized === null ? "null" : serialized;
    }
    stack.delete(value);
    return `[${items.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== PLAIN_OBJECT_PROTOTYPE && prototype !== null) {
    return null;
  }

  if (stack.has(value)) {
    return null;
  }

  stack.add(value);
  const entries = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && (descriptor.get || descriptor.set)) {
      stack.delete(value);
      return null;
    }

    const serializedValue = serializeJsonValue(value[key], stack);
    if (serializedValue !== null) {
      entries.push(`${JSON.stringify(key)}:${serializedValue}`);
    }
  }
  stack.delete(value);
  return `{${entries.join(",")}}`;
}

function identity(value) {
  return value;
}

function encodeUtf8(value) {
  return textEncoder.encode(String(value));
}

function readBytes(bytes, offset, length) {
  if (offset + length > bytes.byteLength) {
    throw new Error("Request envelope truncated");
  }

  return bytes.subarray(offset, offset + length);
}

function readU8(view, offset) {
  if (offset + 1 > view.byteLength) {
    throw new Error("Request envelope truncated");
  }
  return view.getUint8(offset);
}

function readU16(view, offset) {
  if (offset + 2 > view.byteLength) {
    throw new Error("Request envelope truncated");
  }
  return view.getUint16(offset, true);
}

function readU32(view, offset) {
  if (offset + 4 > view.byteLength) {
    throw new Error("Request envelope truncated");
  }
  return view.getUint32(offset, true);
}

function writeU8(view, offset, value) {
  view.setUint8(offset, value);
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value, true);
}
