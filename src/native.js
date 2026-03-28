import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load the compiled Rust NAPI native module (.node binary).
 * Resolves the binary path via HTTP_NATIVE_NATIVE_PATH or
 * HTTP_NATIVE_NODE_PATH env vars, falling back to <root>/http-native.node.
 *
 * @returns {Object} The NAPI module exposing startServer() and native APIs
 * @throws {Error} If the compiled .node binary is missing from disk
 */
export function loadNativeModule() {
  const configuredPath =
    process.env.HTTP_NATIVE_NATIVE_PATH ?? process.env.HTTP_NATIVE_NODE_PATH;
  const nativeModulePath = configuredPath
    ? resolve(rootDir, configuredPath)
    : resolve(rootDir, "http-native.node");

  if (!existsSync(nativeModulePath)) {
    throw new Error(
      `Native module not found at ${nativeModulePath}. Build it first with "bun run build".`,
    );
  }

  return require(nativeModulePath);
}
