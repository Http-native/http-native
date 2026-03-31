import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createDevServer } from "../../src/dev/index.js";

const REPO_INDEX_PATH = path.resolve(process.cwd(), "src/index.js").replaceAll("\\", "\\\\");

function writeFixture(filePath, contents) {
  writeFileSync(filePath, contents, "utf8");
}

async function waitFor(check, timeoutMs = 8000, intervalMs = 60) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError ?? new Error("Timed out waiting for condition");
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function main() {
  const tempRoot = path.resolve(process.cwd(), ".github/tests/tmp");
  mkdirSync(tempRoot, { recursive: true });
  const fixtureRoot = mkdtempSync(path.join(tempRoot, "http-native-dev-"));
  const exportedDir = path.join(fixtureRoot, "exported");
  const selfStartDir = path.join(fixtureRoot, "self-start");
  mkdirSync(exportedDir, { recursive: true });
  mkdirSync(selfStartDir, { recursive: true });

  const exportedEntryPath = path.join(exportedDir, "app.js");
  const helperPath = path.join(exportedDir, "helper.js");

  writeFixture(
    helperPath,
    `export const helperMessage = "first";\n`,
  );

  const writeExportedEntry = (cacheVersion) => {
    writeFixture(
      exportedEntryPath,
      `
import { createApp } from "${REPO_INDEX_PATH}";
import { helperMessage } from "./helper.js";

globalThis.__HTTP_NATIVE_DEV_EXECUTIONS__ ??= 0;

const app = createApp();

app.get("/", (_req, res) => {
  res.json({ helper: helperMessage });
});

app.get("/cached", (_req, res) => {
  globalThis.__HTTP_NATIVE_DEV_EXECUTIONS__ += 1;
  res.ncache(
    {
      version: "${cacheVersion}",
      executions: globalThis.__HTTP_NATIVE_DEV_EXECUTIONS__,
    },
    60,
  );
});

export default app;
`.trimStart(),
    );
  };
  writeExportedEntry("v1");

  const reloadEvents = [];
  const exportedServer = await createDevServer({
    entry: exportedEntryPath,
    port: 0,
    watch: [exportedDir],
    clear: false,
    onReload(status) {
      reloadEvents.push(status);
    },
  });

  const firstRoot = await fetchJson(`${exportedServer.url}/`);
  assert.equal(firstRoot.helper, "first");

  const firstCached = await fetchJson(`${exportedServer.url}/cached`);
  assert.deepEqual(firstCached, {
    version: "v1",
    executions: 1,
  });

  writeFixture(
    helperPath,
    `export const helperMessage = "second";\n`,
  );

  await waitFor(async () => {
    const nextRoot = await fetchJson(`${exportedServer.url}/`);
    assert.equal(nextRoot.helper, "second");
    return nextRoot;
  });

  const statusAfterUnrelatedReload = exportedServer.status();
  assert.equal(statusAfterUnrelatedReload.state, "ready");
  assert.equal(statusAfterUnrelatedReload.reloadCount, 1);
  assert.equal(statusAfterUnrelatedReload.revision, 2);

  const cachedAfterUnrelatedReload = await fetchJson(`${exportedServer.url}/cached`);
  assert.deepEqual(cachedAfterUnrelatedReload, {
    version: "v1",
    executions: 1,
  });

  writeExportedEntry("v2");

  await waitFor(async () => {
    const nextCached = await fetchJson(`${exportedServer.url}/cached`);
    assert.equal(nextCached.version, "v2");
    assert.equal(nextCached.executions, 2);
    return nextCached;
  });

  assert.ok(reloadEvents.length >= 2);
  await exportedServer.close();
  assert.equal(exportedServer.status().state, "closed");

  const selfStartEntryPath = path.join(selfStartDir, "app.js");
  writeFixture(
    selfStartEntryPath,
    `
import { createApp } from "${REPO_INDEX_PATH}";

const app = createApp();
app.get("/self", (_req, res) => {
  res.json({ ok: true });
});

export const server = await app.listen().port(0);
`.trimStart(),
  );

  const selfStartingServer = await createDevServer({
    entry: selfStartEntryPath,
    watch: [selfStartDir],
    clear: false,
  });

  const selfResponse = await fetchJson(`${selfStartingServer.url}/self`);
  assert.deepEqual(selfResponse, { ok: true });
  assert.equal(selfStartingServer.status().state, "ready");
  assert.equal(selfStartingServer.status().revision, 1);

  await selfStartingServer.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
  process.exit(0);
}

await main();
