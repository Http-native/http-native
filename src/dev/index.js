import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  _buildCompiledApplication,
  _normalizeListenOptions,
  _startCompiledServer,
} from "../index.js";
import { createDevWatchController } from "./hot-reload.js";

function isApplication(value) {
  return value && typeof value.listen === "function";
}

function resolveApplication(moduleNamespace) {
  const directCandidates = [moduleNamespace?.default, moduleNamespace?.app];
  for (const candidate of directCandidates) {
    if (isApplication(candidate)) {
      return candidate;
    }
  }

  const factoryCandidates = [moduleNamespace?.default, moduleNamespace?.app, moduleNamespace?.createApp];
  for (const factory of factoryCandidates) {
    if (typeof factory !== "function") {
      continue;
    }

    const value = factory();
    if (isApplication(value)) {
      return value;
    }
  }

  return null;
}

function createStatus(watchRoots) {
  return {
    state: "starting",
    revision: 0,
    reloadCount: 0,
    changedFile: null,
    lastReloadStartedAt: null,
    lastReloadCompletedAt: null,
    lastError: null,
    watchRoots,
  };
}

function selectWatchRoots(primary, secondary) {
  if (Array.isArray(primary)) {
    return [...primary];
  }

  if (Array.isArray(secondary)) {
    return [...secondary];
  }

  return undefined;
}

function normalizeReloadOptions(config) {
  if (!config || typeof config !== "object") {
    return {};
  }

  const watch = selectWatchRoots(config.watch, config.files);
  const debounceMs =
    config.debounceMs === undefined ? undefined : Number(config.debounceMs);

  return {
    ...(watch === undefined ? {} : { watch }),
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(config.clear === undefined ? {} : { clear: Boolean(config.clear) }),
  };
}

function areArraysEqual(left, right) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return left === right;
  }

  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

export async function createDevServer(options = {}) {
  const entry = typeof options.entry === "string" ? options.entry.trim() : "";
  if (!entry) {
    throw new TypeError("createDevServer({ entry }) requires a non-empty entry path");
  }

  const entryPath = path.resolve(process.cwd(), entry);
  const explicitReloadOptions = normalizeReloadOptions(options);
  const explicitWatchRoots = selectWatchRoots(options.watch, options.files);
  let currentServer = null;
  let currentStatus = createStatus([]);
  let currentImportVersion = 0;
  let watchController = null;
  let watchControllerConfig = null;
  let resolvedReloadOptions = {
    ...(explicitReloadOptions.debounceMs === undefined
      ? {}
      : { debounceMs: explicitReloadOptions.debounceMs }),
    ...(explicitReloadOptions.clear === undefined
      ? { clear: true }
      : { clear: explicitReloadOptions.clear }),
    ...(explicitWatchRoots === undefined ? {} : { watch: explicitWatchRoots }),
  };
  let observedSelfStart = false;
  let closed = false;
  let loadEntry = async () => {};
  const runtimeSandboxRoot = path.resolve(process.cwd(), ".http-native", "dev-runtime");

  const updateStatus = (patch) => {
    const nextWatchRoots = patch.watchRoots ?? currentStatus.watchRoots;
    currentStatus = {
      ...currentStatus,
      ...patch,
      watchRoots: nextWatchRoots,
    };
    return {
      ...currentStatus,
      watchRoots: [...currentStatus.watchRoots],
    };
  };

  const resolveListenOptions = (capturedOptions = {}) => {
    const mergedServerConfig = {
      ...(capturedOptions.serverConfig ?? capturedOptions.httpServerConfig ?? {}),
      ...(options.serverConfig ?? {}),
    };

    return {
      ...capturedOptions,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.backlog === undefined ? {} : { backlog: options.backlog }),
      serverConfig: mergedServerConfig,
      opt: {
        ...(capturedOptions.opt ?? {}),
        notify: false,
        hotReload: false,
        devComments: false,
      },
    };
  };

  const resolveReloadOptions = (app) => {
    const appReloadOptions = normalizeReloadOptions(app?._reloadConfig);
    const watch = explicitWatchRoots ?? appReloadOptions.watch;
    const debounceMs = explicitReloadOptions.debounceMs ?? appReloadOptions.debounceMs;
    const clear = explicitReloadOptions.clear ?? appReloadOptions.clear ?? true;

    return {
      ...(watch === undefined ? {} : { watch }),
      ...(debounceMs === undefined ? {} : { debounceMs }),
      clear,
    };
  };

  const ensureWatchController = (nextReloadOptions) => {
    const nextWatch = nextReloadOptions.watch;
    const nextDebounceMs = nextReloadOptions.debounceMs;
    const hasExistingController = watchController !== null;
    const hasSameConfig =
      hasExistingController &&
      watchControllerConfig !== null &&
      watchControllerConfig.debounceMs === nextDebounceMs &&
      areArraysEqual(watchControllerConfig.watch, nextWatch);

    if (hasSameConfig) {
      return;
    }

    watchController?.dispose?.();
    watchController = createDevWatchController({
      entryPath,
      roots: nextWatch,
      debounceMs: nextDebounceMs,
      onChange: async (changedFile) => {
        if (closed) {
          return;
        }

        try {
          await loadEntry({
            type: "reload",
            reason: "change",
            changedFile,
          });
        } catch {}
      },
      log: (message) => {
        console.warn(message);
      },
    });

    watchControllerConfig = {
      ...(nextDebounceMs === undefined ? {} : { debounceMs: nextDebounceMs }),
      ...(nextWatch === undefined ? {} : { watch: [...nextWatch] }),
    };
    watchController.refresh();
    updateStatus({ watchRoots: [...watchController.roots] });
  };

  const buildImportUrl = (version) => {
    const cwd = process.cwd();
    const relativeEntry = path.relative(cwd, entryPath);
    const isInsideWorkspace =
      relativeEntry &&
      !relativeEntry.startsWith("..") &&
      !path.isAbsolute(relativeEntry);

    if (!isInsideWorkspace) {
      return `${pathToFileURL(entryPath).href}?http-native-dev=${version}`;
    }

    const runtimeRoot = path.join(runtimeSandboxRoot, String(version));
    const workspacePath = path.join(runtimeRoot, "workspace");
    mkdirSync(workspacePath, { recursive: true });

    for (const entryName of readdirSync(cwd)) {
      if (entryName === ".git" || entryName === ".http-native" || entryName === "target") {
        continue;
      }

      const sourcePath = path.join(cwd, entryName);
      if (!existsSync(sourcePath)) {
        continue;
      }
      try {
        cpSync(sourcePath, path.join(workspacePath, entryName), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }

    return pathToFileURL(path.join(workspacePath, relativeEntry)).href;
  };

  const applyApplication = async (app, listenOptions = {}) => {
    const normalizedOptions = _normalizeListenOptions(resolveListenOptions(listenOptions));
    const compiledSnapshot = _buildCompiledApplication(app, normalizedOptions);

    if (!currentServer) {
      currentServer = await _startCompiledServer(compiledSnapshot, normalizedOptions);
      return currentServer;
    }

    currentServer._reloadCompiledSnapshot(compiledSnapshot);
    return currentServer;
  };

  loadEntry = async (trigger) => {
    observedSelfStart = false;
    let loadedApp = null;
    updateStatus({
      state: trigger.type === "initial" ? "starting" : "reloading",
      changedFile: trigger.changedFile ?? null,
      lastReloadStartedAt: Date.now(),
      lastError: null,
    });

    const devContext = {
      registerAppListen: async (app, listenOptions) => {
        observedSelfStart = true;
        loadedApp = app;
        return applyApplication(app, listenOptions);
      },
    };

    const previousContext = globalThis.__HTTP_NATIVE_DEV_CONTEXT__;
    globalThis.__HTTP_NATIVE_DEV_CONTEXT__ = devContext;

    try {
      const moduleUrl = buildImportUrl(++currentImportVersion);
      const loadedModule = await import(moduleUrl);

      if (!observedSelfStart) {
        loadedApp = resolveApplication(loadedModule);
        if (!loadedApp) {
          throw new Error(
            `Dev entry ${entryPath} must export an app, export a factory that returns an app, or self-start via app.listen().`,
          );
        }
        await applyApplication(loadedApp);
      }

      resolvedReloadOptions = resolveReloadOptions(loadedApp);
      ensureWatchController(resolvedReloadOptions);

      const nextRevision = trigger.type === "initial"
        ? 1
        : currentStatus.revision + 1;
      const nextReloadCount = trigger.type === "initial"
        ? 0
        : currentStatus.reloadCount + 1;

      if (resolvedReloadOptions.clear && trigger.type !== "initial") {
        console.clear();
      }

      const readyStatus = updateStatus({
        state: "ready",
        revision: nextRevision,
        reloadCount: nextReloadCount,
        lastReloadCompletedAt: Date.now(),
      });

      if (trigger.type !== "initial") {
        options.onReload?.(readyStatus);
      }

      return controller;
    } catch (error) {
      const errorStatus = updateStatus({
        state: "error",
        lastReloadCompletedAt: Date.now(),
        lastError: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      });
      options.onError?.(error, errorStatus);
      throw error;
    } finally {
      if (previousContext === undefined) {
        delete globalThis.__HTTP_NATIVE_DEV_CONTEXT__;
      } else {
        globalThis.__HTTP_NATIVE_DEV_CONTEXT__ = previousContext;
      }
    }
  };

  const controller = {
    get host() {
      return currentServer?.host ?? options.host ?? "127.0.0.1";
    },
    get port() {
      return currentServer?.port ?? Number(options.port ?? 3000);
    },
    get url() {
      return currentServer?.url ?? `http://${controller.host}:${controller.port}`;
    },
    status() {
      return {
        ...currentStatus,
        watchRoots: [...currentStatus.watchRoots],
      };
    },
    async reload(reason = "manual") {
      if (closed) {
        throw new Error("Dev server is already closed");
      }

      try {
        await loadEntry({
          type: "reload",
          reason,
          changedFile: reason === "manual" ? null : reason,
        });
      } catch {}

      return controller.status();
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      updateStatus({ state: "closing" });
      watchController?.dispose?.();
      watchController = null;
      await currentServer?.close?.();
      currentServer = null;
      rmSync(runtimeSandboxRoot, { recursive: true, force: true });
      updateStatus({ state: "closed" });
    },
  };

  await loadEntry({ type: "initial", reason: "initial", changedFile: null });

  return controller;
}
