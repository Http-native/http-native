import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

import {
  resolveAssetName,
  resolveAssetUrl,
  resolveBinaryDestination,
  resolvePackageVersion,
  resolvePlatform,
  resolveReleaseTag,
  resolveRepositoryPath,
} from "./shared.mjs";

export async function downloadNativeBinary(options = {}) {
  const force = options.force === true;
  const quiet = options.quiet === true;
  const version = resolvePackageVersion(options.version);
  const tag = resolveReleaseTag(version, options.tag);
  const { platform, arch } = resolvePlatform(options.platform, options.arch);
  const repositoryPath = resolveRepositoryPath();
  const assetName = resolveAssetName(platform, arch);
  const downloadUrl = resolveAssetUrl(tag, assetName, repositoryPath);
  const destinationPath = resolveBinaryDestination();

  if (!force && existsSync(destinationPath)) {
    if (!quiet) {
      console.log(`[http-native] native binary already present at ${destinationPath}`);
    }
    return {
      changed: false,
      destinationPath,
      assetName,
      tag,
      downloadUrl,
    };
  }

  const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (!quiet) {
      console.log(`[http-native] downloading native binary: ${downloadUrl}`);
    }

    const response = await fetch(downloadUrl, {
      headers: {
        accept: "application/octet-stream",
        "user-agent": "http-native-installer",
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });

    if (!response.ok) {
      throw new Error(
        `download failed (${response.status} ${response.statusText}) from ${downloadUrl}`,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error(`downloaded empty native binary from ${downloadUrl}`);
    }

    writeFileSync(tempPath, bytes);
    if (platform !== "win32") {
      chmodSync(tempPath, 0o755);
    }
    rmSync(destinationPath, { force: true });
    renameSync(tempPath, destinationPath);

    if (!quiet) {
      console.log(`[http-native] native binary ready: ${destinationPath}`);
    }
    return {
      changed: true,
      destinationPath,
      assetName,
      tag,
      downloadUrl,
    };
  } catch (error) {
    rmSync(tempPath, { force: true });
    const message =
      error instanceof Error ? error.message : "unknown download failure";
    throw new Error(
      `Unable to setup native binary for ${platform}-${arch}. ${message}`,
    );
  }
}
