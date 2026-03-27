import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeModulePath = resolve(rootDir, "http-native.node");

export function loadNativeModule() {
  if (!existsSync(nativeModulePath)) {
    throw new Error(
      `Native module not found at ${nativeModulePath}. Build it first with "bun run build".`,
    );
  }

  return require(nativeModulePath);
}
