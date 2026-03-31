import type { HttpServerConfig, ReloadOptions } from "../index.js";

export interface DevServerStatus {
  state: "starting" | "ready" | "reloading" | "error" | "closing" | "closed";
  revision: number;
  reloadCount: number;
  changedFile: string | null;
  lastReloadStartedAt: number | null;
  lastReloadCompletedAt: number | null;
  lastError: { message: string; stack?: string } | null;
  watchRoots: string[];
}

export interface DevServerOptions {
  entry: string;
  host?: string;
  port?: number;
  backlog?: number;
  serverConfig?: HttpServerConfig;
  /** Watch roots; all files under these roots are considered reloadable by default */
  watch?: string[];
  /** Alias of watch for app-level style configuration */
  files?: string[];
  debounceMs?: number;
  clear?: boolean;
  onReload?: (status: DevServerStatus) => void;
  onError?: (error: Error, status: DevServerStatus) => void;
}

export interface AppReloadConfig extends ReloadOptions {}

export interface DevServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  status(): DevServerStatus;
  reload(reason?: string): Promise<DevServerStatus>;
  close(): Promise<void>;
}

export function createDevServer(options: DevServerOptions): Promise<DevServerHandle>;
