import { downloadNativeBinary } from "./native/download.mjs";

function parseArgs(argv) {
  let force = false;
  let version;
  let tag;
  let platform;
  let arch;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--version" && argv[index + 1]) {
      version = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--tag" && argv[index + 1]) {
      tag = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--platform" && argv[index + 1]) {
      platform = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--arch" && argv[index + 1]) {
      arch = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return {
    force,
    version,
    tag,
    platform,
    arch,
  };
}

export async function runNativeSetupCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const result = await downloadNativeBinary({
    force: parsed.force,
    version: parsed.version,
    tag: parsed.tag,
    platform: parsed.platform,
    arch: parsed.arch,
  });

  if (result.changed) {
    console.log(`[http-native] setup complete (${result.assetName})`);
    return 0;
  }

  console.log("[http-native] setup skipped (binary already present)");
  return 0;
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/setup-native.mjs") ||
    process.argv[1].endsWith("\\setup-native.mjs"));

if (isMain) {
  try {
    const exitCode = await runNativeSetupCli();
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[http-native] setup failed: ${message}`);
    process.exit(1);
  }
}
