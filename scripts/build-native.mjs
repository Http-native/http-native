import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";

const cargoArgs = ["build"];
if (release) {
  cargoArgs.push("--release");
}
cargoArgs.push("--manifest-path", "rust-native/Cargo.toml");

const result = Bun.spawnSync({
  cmd: ["cargo", ...cargoArgs],
  cwd: process.cwd(),
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}

const platformArtifact =
  process.platform === "darwin"
    ? "libhttp_native_napi.dylib"
    : process.platform === "win32"
      ? "http_native_napi.dll"
      : "libhttp_native_napi.so";

const source = resolve(`rust-native/target/${profile}/${platformArtifact}`);
const target = resolve("http-native.node");

if (!existsSync(source)) {
  throw new Error(`Native artifact not found at ${source}`);
}

copyFileSync(source, target);
console.log(`[http-native] wrote ${target}`);
