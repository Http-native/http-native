import { createDevServer } from "./dev/index.js";

export async function hot(appModulePath, options = {}) {
  return createDevServer({
    entry: appModulePath,
    host: options.host,
    port: options.port,
    backlog: options.backlog,
    serverConfig: options.serverConfig ?? options.httpServerConfig,
    watch: options.watch,
    debounceMs: options.debounceMs,
    clear: options.clear,
    onReload: options.onReload,
    onError: options.onError,
  });
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/hot.js") || process.argv[1].endsWith("\\hot.js"));

if (isMain) {
  const args = process.argv.slice(2);
  let appPath = null;
  let port;
  let host;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--port" && args[index + 1]) {
      port = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (args[index] === "--host" && args[index + 1]) {
      host = args[index + 1];
      index += 1;
      continue;
    }
    if (!args[index].startsWith("-")) {
      appPath = args[index];
    }
  }

  if (!appPath) {
    console.error("Usage: bun src/hot.js <app-module> [--port 3000] [--host 127.0.0.1]");
    process.exit(1);
  }

  await hot(appPath, { port, host });
}
