/**
 * @typedef {Object} HttpServerConfig
 * @property {string}  defaultHost                   - Bind address (default "127.0.0.1")
 * @property {number}  defaultBacklog                - TCP listen backlog (default 2048)
 * @property {number}  maxHeaderBytes                - Maximum header block size in bytes
 * @property {string}  hotGetRootHttp11              - Hot-path prefix for GET / HTTP/1.1
 * @property {string}  hotGetRootHttp10              - Hot-path prefix for GET / HTTP/1.0
 * @property {string}  headerConnectionPrefix        - Lowercase "connection:" for matching
 * @property {string}  headerContentLengthPrefix     - Lowercase "content-length:" for matching
 * @property {string}  headerTransferEncodingPrefix  - Lowercase "transfer-encoding:" for matching
 */

/** @type {HttpServerConfig} */
const httpServerConfig = {
  defaultHost: "127.0.0.1",
  defaultBacklog: 2048,
  maxHeaderBytes: 16 * 1024,
  hotGetRootHttp11: "GET / HTTP/1.1\r\n",
  hotGetRootHttp10: "GET / HTTP/1.0\r\n",
  headerConnectionPrefix: "connection:",
  headerContentLengthPrefix: "content-length:",
  headerTransferEncodingPrefix: "transfer-encoding:",
};

/**
 * Merge caller-provided overrides with built-in defaults, coercing
 * every field to the expected primitive type.
 *
 * @param {Partial<HttpServerConfig>} [overrides={}]
 * @returns {HttpServerConfig} Fully-populated, type-coerced config
 */
export function normalizeHttpServerConfig(overrides = {}) {
  return {
    defaultHost: String(overrides.defaultHost ?? httpServerConfig.defaultHost),
    defaultBacklog: Number(overrides.defaultBacklog ?? httpServerConfig.defaultBacklog),
    maxHeaderBytes: Number(overrides.maxHeaderBytes ?? httpServerConfig.maxHeaderBytes),
    hotGetRootHttp11: String(overrides.hotGetRootHttp11 ?? httpServerConfig.hotGetRootHttp11),
    hotGetRootHttp10: String(overrides.hotGetRootHttp10 ?? httpServerConfig.hotGetRootHttp10),
    headerConnectionPrefix: String(
      overrides.headerConnectionPrefix ?? httpServerConfig.headerConnectionPrefix,
    ),
    headerContentLengthPrefix: String(
      overrides.headerContentLengthPrefix ?? httpServerConfig.headerContentLengthPrefix,
    ),
    headerTransferEncodingPrefix: String(
      overrides.headerTransferEncodingPrefix ??
        httpServerConfig.headerTransferEncodingPrefix,
    ),
  };
}

export default httpServerConfig;
