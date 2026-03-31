#!/usr/bin/env node

import { createDevServer } from "./dev/index.js";

function printUsage() {
  console.log("Usage:");
  console.log("  http-native dev <entry> [--host 127.0.0.1] [--port 3000] [--watch path] [--debounce 120] [--no-clear]");
  console.log("  http-native setup");
}

function parseDevArgs(argv) {
  let entry = null;
  let host;
  let port;
  let debounceMs;
  let clear = true;
  const watch = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--host" && argv[index + 1]) {
      host = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--port" && argv[index + 1]) {
      port = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--watch" && argv[index + 1]) {
      watch.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--debounce" && argv[index + 1]) {
      debounceMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--no-clear") {
      clear = false;
      continue;
    }

    if (!arg.startsWith("-") && !entry) {
      entry = arg;
    }
  }

  return {
    entry,
    host,
    port,
    debounceMs,
    clear,
    watch,
  };
}

const [, , command, ...args] = process.argv;

if (command === "setup") {
  console.log("http-native: setting up native binary...");
  console.log("http-native: done.");
} else if (command === "dev") {
  const parsed = parseDevArgs(args);

  if (!parsed.entry) {
    printUsage();
    process.exit(1);
  }

  const server = await createDevServer({
    entry: parsed.entry,
    host: parsed.host,
    port: parsed.port,
    debounceMs: parsed.debounceMs,
    clear: parsed.clear,
    watch: parsed.watch.length > 0 ? parsed.watch : undefined,
    onReload(status) {
      const changed = status.changedFile ? ` (${status.changedFile})` : "";
      console.log(`[http-native][dev] reloaded${changed}`);
    },
    onError(error, status) {
      const changed = status.changedFile ? ` (${status.changedFile})` : "";
      console.error(`[http-native][dev] reload failed${changed}: ${error.message}`);
    },
  });

  console.log(`[http-native][dev] listening on ${server.url}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else {
  printUsage();
}
