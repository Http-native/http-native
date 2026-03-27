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
