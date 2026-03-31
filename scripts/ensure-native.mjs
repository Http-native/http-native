import { downloadNativeBinary } from "./native/download.mjs";

const skipDownload =
  process.env.HTTP_NATIVE_SKIP_DOWNLOAD === "1" ||
  process.env.HTTP_NATIVE_SKIP_DOWNLOAD === "true";

if (skipDownload) {
  console.log("[http-native] skipping native binary setup (HTTP_NATIVE_SKIP_DOWNLOAD=1)");
  process.exit(0);
}

try {
  await downloadNativeBinary({
    force: false,
    quiet: false,
  });
} catch (error) {
  const message =
    error instanceof Error ? error.message : "unknown setup failure";
  console.error(`[http-native] native setup failed: ${message}`);
  console.error("[http-native] run \"http-native setup --force\" to retry.");
  process.exit(1);
}
