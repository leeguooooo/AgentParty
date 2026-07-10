export const LAST_SUCCESSFUL_CHECK_KEY = "ap_desktop_updater_last_success";
export const LAST_UPDATER_DIAGNOSTIC_KEY = "ap_desktop_updater_diagnostic";

const AUTO_CHECK_DELAY_MS = 8_000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const VERSION_LOOKUP_TIMEOUT_MS = 2_000;
const MAX_RELEASE_NOTES_LENGTH = 2_000;

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export type UpdaterFailureStage = "check" | "install" | "relaunch";
export type UpdaterErrorKind = "offline" | "timeout" | "verification" | "install" | "relaunch" | "generic";

export interface DesktopUpdaterState {
  phase: UpdaterPhase;
  panelOpen: boolean;
  currentVersion: string | null;
  nextVersion: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  progressPercent: number | null;
  error: UpdaterErrorKind | null;
  failureStage: UpdaterFailureStage | null;
}

export interface UpdateCandidate {
  currentVersion: string;
  nextVersion: string;
  notes?: string | null;
}

export type DownloadEvent =
  | { type: "started"; totalBytes?: number }
  | { type: "progress"; chunkBytes: number }
  | { type: "finished" };

export interface DesktopUpdaterAdapter {
  version?(): Promise<string | null>;
  check(): Promise<UpdateCandidate | null>;
  install(onEvent: (event: DownloadEvent) => void): Promise<void>;
  relaunch(): Promise<void>;
  close(): Promise<void>;
}

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TimerAdapter {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
}

interface ControllerOptions {
  adapter: DesktopUpdaterAdapter;
  clock: { now(): number };
  storage: StorageAdapter;
  timer?: TimerAdapter;
}

export interface DesktopUpdaterController {
  getState(): DesktopUpdaterState;
  subscribe(listener: (state: DesktopUpdaterState) => void): () => void;
  start(): void;
  check(source: "auto" | "manual"): Promise<void>;
  install(): Promise<void>;
  retry(): Promise<void>;
  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;
  dispose(): void;
}

const INITIAL_STATE: DesktopUpdaterState = {
  phase: "idle",
  panelOpen: false,
  currentVersion: null,
  nextVersion: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  progressPercent: null,
  error: null,
  failureStage: null,
};

const defaultTimer: TimerAdapter = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
};

export function isTauriEnvironment(value: unknown = globalThis): boolean {
  return typeof value === "object" && value !== null && "__TAURI_INTERNALS__" in value;
}

export function shouldAutoCheck(storage: StorageAdapter, now: number): boolean {
  try {
    const raw = storage.getItem(LAST_SUCCESSFUL_CHECK_KEY);
    if (raw === null) return true;
    const timestamp = Number(raw);
    const age = now - timestamp;
    return !Number.isFinite(timestamp) || age >= AUTO_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function updaterErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

export function classifyUpdaterError(error: unknown, stage: UpdaterFailureStage): UpdaterErrorKind {
  const message = updaterErrorMessage(error).toLowerCase();
  if (/\b(timeout|timed out|etimedout)\b/.test(message)) return "timeout";
  if (/\b(offline|network|connection|unreachable|dns|failed to fetch|econnrefused|enotfound|enetunreach|ehostunreach)\b/.test(message)) {
    return "offline";
  }
  if (/\b(signature|checksum|verification|verify|certificate|cert)\b/.test(message)) return "verification";
  if (stage === "install") return "install";
  if (stage === "relaunch") return "relaunch";
  return "generic";
}

function boundReleaseNotes(notes: string | null | undefined): string | null {
  if (typeof notes !== "string") return null;
  const plainText = notes.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (plainText.length === 0) return null;
  if (plainText.length <= MAX_RELEASE_NOTES_LENGTH) return plainText;
  return plainText.slice(0, MAX_RELEASE_NOTES_LENGTH - 3).trimEnd() + "...";
}

function withTimeout<T>(promise: Promise<T>, timer: TimerAdapter, timeoutMs: number) {
  let timeoutId: unknown;
  let active = true;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = timer.setTimeout(() => {
      if (active) reject(new Error("Update check timed out"));
    }, timeoutMs);
  });
  const cancel = () => {
    if (!active) return;
    active = false;
    if (timeoutId !== undefined) timer.clearTimeout(timeoutId);
    timeoutId = undefined;
  };
  return { promise: Promise.race([promise, timeout]).finally(cancel), cancel };
}

export function createDesktopUpdaterController(options: ControllerOptions): DesktopUpdaterController {
  const timer = options.timer ?? defaultTimer;
  const listeners = new Set<(state: DesktopUpdaterState) => void>();
  let state = { ...INITIAL_STATE };
  let startupTimer: unknown;
  let started = false;
  let disposed = false;
  let checkPromise: Promise<void> | null = null;
  let cancelCheckTimeout: (() => void) | null = null;
  let operationPromise: Promise<void> | null = null;
  let closeRequested = false;

  const publish = (next: DesktopUpdaterState) => {
    if (disposed) return;
    state = next;
    listeners.forEach((listener) => listener(state));
  };

  const patch = (next: Partial<DesktopUpdaterState>) => publish({ ...state, ...next });

  const persistDiagnostic = (diagnostic: Record<string, string | number | null>) => {
    try {
      options.storage.setItem(LAST_UPDATER_DIAGNOSTIC_KEY, JSON.stringify(diagnostic));
    } catch {
      // Updater behavior must not depend on diagnostics storage availability.
    }
  };

  const reportFailure = (
    stage: UpdaterFailureStage,
    error: unknown,
    source: "auto" | "manual" | null = null,
    appVersion: string | null = null,
  ) => {
    if (disposed) return;
    const category = classifyUpdaterError(error, stage);
    console.error(`[desktop-updater] ${stage} failed`, error);
    persistDiagnostic({ status: "failure", source, stage, category, timestamp: options.clock.now(), appVersion });
    patch({ phase: "error", failureStage: stage, error: category });
  };

  const closeAdapter = async () => {
    try {
      await options.adapter.close();
    } catch (error) {
      console.error("[desktop-updater] failed to close update handle", error);
    }
  };

  const closeAdapterWhenIdle = () => {
    if (closeRequested) return;
    closeRequested = true;
    const pending = [checkPromise, operationPromise].filter((promise): promise is Promise<void> => promise !== null);
    if (pending.length === 0) {
      void closeAdapter();
      return;
    }
    void Promise.allSettled(pending).then(closeAdapter);
  };

  const beginRelaunch = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (operationPromise !== null) return operationPromise;
    patch({ phase: "ready", failureStage: null, error: null });
    const active = (async () => {
      try {
        await options.adapter.relaunch();
      } catch (error) {
        reportFailure("relaunch", error, null, state.currentVersion);
      }
    })();
    operationPromise = active;
    void active.finally(() => {
      if (operationPromise === active) operationPromise = null;
    });
    return active;
  };

  const beginInstall = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (operationPromise !== null) return operationPromise;
    const canInstall = state.phase === "available" || (state.phase === "error" && state.failureStage === "install");
    if (!canInstall) return Promise.resolve();

    patch({
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: null,
      failureStage: null,
      error: null,
    });

    const active = (async () => {
      try {
        await options.adapter.install((event) => {
          if (disposed) return;
          if (event.type === "started") {
            const totalBytes =
              event.totalBytes !== undefined && Number.isFinite(event.totalBytes) && event.totalBytes > 0
                ? event.totalBytes
                : null;
            patch({ downloadedBytes: 0, totalBytes, progressPercent: totalBytes === null ? null : 0 });
            return;
          }
          if (event.type === "progress") {
            const chunkBytes = Math.max(0, Number.isFinite(event.chunkBytes) ? event.chunkBytes : 0);
            const downloadedBytes =
              state.totalBytes === null
                ? state.downloadedBytes + chunkBytes
                : Math.min(state.totalBytes, state.downloadedBytes + chunkBytes);
            patch({
              downloadedBytes,
              progressPercent:
                state.totalBytes === null ? null : Math.min(100, Math.round((downloadedBytes / state.totalBytes) * 100)),
            });
            return;
          }
          patch({
            phase: "installing",
            downloadedBytes: state.totalBytes ?? state.downloadedBytes,
            progressPercent: state.totalBytes === null ? null : 100,
          });
        });
      } catch (error) {
        reportFailure("install", error, null, state.currentVersion);
        return;
      }
      if (disposed) return;
      patch({
        phase: "ready",
        downloadedBytes: state.totalBytes ?? state.downloadedBytes,
        progressPercent: state.totalBytes === null ? null : 100,
      });
      try {
        await options.adapter.relaunch();
      } catch (error) {
        reportFailure("relaunch", error, null, state.currentVersion);
      }
    })();
    operationPromise = active;
    void active.finally(() => {
      if (operationPromise === active) operationPromise = null;
    });
    return active;
  };

  const controller: DesktopUpdaterController = {
    getState: () => state,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      if (disposed || started) return;
      started = true;
      if (!shouldAutoCheck(options.storage, options.clock.now())) return;
      startupTimer = timer.setTimeout(() => {
        startupTimer = undefined;
        if (disposed || !shouldAutoCheck(options.storage, options.clock.now())) return;
        void controller.check("auto");
      }, AUTO_CHECK_DELAY_MS);
    },

    check(source) {
      if (disposed) return Promise.resolve();
      if (source === "manual" && !state.panelOpen) patch({ panelOpen: true });
      if (checkPromise !== null) return checkPromise;
      if (operationPromise !== null || state.failureStage === "install" || state.failureStage === "relaunch") {
        return operationPromise ?? Promise.resolve();
      }

      patch({
        phase: "checking",
        panelOpen: source === "manual" ? true : state.panelOpen,
        currentVersion: null,
        nextVersion: null,
        notes: null,
        downloadedBytes: 0,
        totalBytes: null,
        progressPercent: null,
        error: null,
        failureStage: null,
      });
      persistDiagnostic({
        status: "attempt",
        source,
        stage: "check",
        category: null,
        timestamp: options.clock.now(),
        appVersion: null,
      });

      const active = (async () => {
        const timedCheck = withTimeout(options.adapter.check(), timer, CHECK_TIMEOUT_MS);
        cancelCheckTimeout = timedCheck.cancel;
        const appVersionPromise = options.adapter.version === undefined
          ? Promise.resolve(null)
          : withTimeout(options.adapter.version(), timer, VERSION_LOOKUP_TIMEOUT_MS).promise.catch(() => null);
        try {
          const update = await timedCheck.promise;
          const appVersion = update?.currentVersion ?? await appVersionPromise;
          if (disposed) return;
          try {
            options.storage.setItem(LAST_SUCCESSFUL_CHECK_KEY, String(options.clock.now()));
          } catch {
            // A successful native check remains successful when persistence is unavailable.
          }
          persistDiagnostic({
            status: "success",
            source,
            stage: "check",
            category: null,
            timestamp: options.clock.now(),
            appVersion,
          });
          if (update === null) {
            patch({ phase: "up-to-date" });
            return;
          }
          patch({
            phase: "available",
            currentVersion: update.currentVersion,
            nextVersion: update.nextVersion,
            notes: boundReleaseNotes(update.notes),
          });
        } catch (error) {
          reportFailure("check", error, source, await appVersionPromise);
        } finally {
          cancelCheckTimeout = null;
        }
      })();
      checkPromise = active;
      void active.finally(() => {
        if (checkPromise === active) checkPromise = null;
      });
      return active;
    },

    install() {
      return beginInstall();
    },

    retry() {
      if (state.failureStage === "check") return controller.check("manual");
      if (state.failureStage === "install") return beginInstall();
      if (state.failureStage === "relaunch") return beginRelaunch();
      return Promise.resolve();
    },

    openPanel: () => patch({ panelOpen: true }),
    closePanel: () => patch({ panelOpen: false }),
    togglePanel: () => patch({ panelOpen: !state.panelOpen }),

    dispose() {
      if (disposed) return;
      disposed = true;
      if (startupTimer !== undefined) timer.clearTimeout(startupTimer);
      cancelCheckTimeout?.();
      startupTimer = undefined;
      cancelCheckTimeout = null;
      listeners.clear();
      closeAdapterWhenIdle();
    },
  };

  return controller;
}

type Importer = (specifier: string) => Promise<unknown>;

interface TauriUpdaterOptions {
  importer?: Importer;
}

interface TauriUpdaterModule {
  check(): Promise<TauriUpdate | null>;
}

interface TauriProcessModule {
  relaunch(): Promise<void>;
}

interface TauriUpdate {
  currentVersion: string;
  version: string;
  body?: string | null;
  downloadAndInstall(onEvent: (event: TauriDownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}

type TauriDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength?: number } }
  | { event: "Finished"; data?: Record<string, never> };

const nativeImport: Importer = (specifier) => {
  if (specifier === "@tauri-apps/plugin-updater") return import("@tauri-apps/plugin-updater");
  if (specifier === "@tauri-apps/plugin-process") return import("@tauri-apps/plugin-process");
  if (specifier === "@tauri-apps/api/app") return import("@tauri-apps/api/app");
  return Promise.reject(new Error(`Unsupported Tauri plugin: ${specifier}`));
};

export async function createTauriUpdaterAdapter(options: TauriUpdaterOptions = {}): Promise<DesktopUpdaterAdapter> {
  const importer = options.importer ?? nativeImport;
  const [updaterModule, processModule] = (await Promise.all([
    importer("@tauri-apps/plugin-updater"),
    importer("@tauri-apps/plugin-process"),
  ])) as [TauriUpdaterModule, TauriProcessModule];
  let retainedUpdate: TauriUpdate | null = null;
  let checkGeneration = 0;

  let lifecycleQueue: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleQueue.then(operation, operation);
    lifecycleQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const closeUpdate = async (update: TauriUpdate | null) => {
    if (update === null) return;
    try {
      await update.close();
    } catch (error) {
      console.error("[desktop-updater] failed to close native update handle", error);
    }
  };

  return {
    async version() {
      const appModule = (await importer("@tauri-apps/api/app")) as { getVersion(): Promise<string> };
      return appModule.getVersion();
    },

    check() {
      const generation = ++checkGeneration;
      const operationBarrier = lifecycleQueue;
      return (async () => {
        // A check must not replace the retained handle during install/relaunch,
        // but a timed-out check must not block a newer retry forever.
        await operationBarrier;
        const nextUpdate = await updaterModule.check();
        if (generation !== checkGeneration) {
          await closeUpdate(nextUpdate);
          return null;
        }
        const previousUpdate = retainedUpdate;
        retainedUpdate = nextUpdate;
        await closeUpdate(previousUpdate);
        if (nextUpdate === null) return null;
        return {
          currentVersion: nextUpdate.currentVersion,
          nextVersion: nextUpdate.version,
          notes: nextUpdate.body ?? null,
        };
      })();
    },

    install(onEvent) {
      return enqueue(async () => {
        if (retainedUpdate === null) throw new Error("No update is ready to install");
        await retainedUpdate.downloadAndInstall((event) => {
          if (event.event === "Started") {
            onEvent({ type: "started", totalBytes: event.data.contentLength });
          } else if (event.event === "Progress") {
            onEvent({ type: "progress", chunkBytes: event.data.chunkLength ?? 0 });
          } else if (event.event === "Finished") {
            onEvent({ type: "finished" });
          }
        });
      });
    },

    relaunch: () => enqueue(processModule.relaunch),

    close() {
      checkGeneration += 1;
      return enqueue(async () => {
        const update = retainedUpdate;
        retainedUpdate = null;
        await closeUpdate(update);
      });
    },
  };
}

interface BrowserDesktopUpdaterClientOptions {
  windowRef?: unknown;
  clock?: { now(): number };
  storage?: StorageAdapter;
  timer?: TimerAdapter;
  importer?: Importer;
}

function storageFromWindow(windowRef: unknown): StorageAdapter {
  try {
    if (typeof windowRef === "object" && windowRef !== null && "localStorage" in windowRef) {
      const storage = (windowRef as { localStorage?: StorageAdapter | null }).localStorage;
      if (storage !== undefined && storage !== null) return storage;
    }
  } catch {
    // Storage may be blocked while the desktop updater remains otherwise usable.
  }
  return {
    getItem: () => null,
    setItem: () => {},
  };
}

export function createBrowserDesktopUpdaterClient(
  options: BrowserDesktopUpdaterClientOptions = {},
): DesktopUpdaterController | null {
  const windowRef = options.windowRef ?? globalThis;
  if (!isTauriEnvironment(windowRef)) return null;
  let nativeAdapterPromise: Promise<DesktopUpdaterAdapter> | null = null;
  const getNativeAdapter = () => {
    if (nativeAdapterPromise === null) {
      nativeAdapterPromise = createTauriUpdaterAdapter({ importer: options.importer }).catch((error) => {
        nativeAdapterPromise = null;
        throw error;
      });
    }
    return nativeAdapterPromise;
  };
  const controller = createDesktopUpdaterController({
    adapter: {
      async check() {
        return (await getNativeAdapter()).check();
      },
      async install(onEvent) {
        return (await getNativeAdapter()).install(onEvent);
      },
      async relaunch() {
        return (await getNativeAdapter()).relaunch();
      },
      async close() {
        if (nativeAdapterPromise !== null) await (await nativeAdapterPromise).close();
      },
    },
    clock: options.clock ?? { now: () => Date.now() },
    storage: options.storage ?? storageFromWindow(windowRef),
    timer: options.timer,
  });
  return controller;
}
