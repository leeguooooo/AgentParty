const API_BASE_KEY = "ap_api_base";

function defaultApiBase(): string {
  return normalizeApiBase(import.meta.env.VITE_API_BASE);
}

function normalizeApiBase(base: string | undefined | null): string {
  return (base ?? "").trim().replace(/\/+$/, "");
}

export function apiBase(): string {
  try {
    return normalizeApiBase(localStorage.getItem(API_BASE_KEY) ?? defaultApiBase());
  } catch {
    return defaultApiBase();
  }
}

export function setApiBase(base: string): void {
  try {
    localStorage.setItem(API_BASE_KEY, normalizeApiBase(base));
  } catch {
    // Non-browser test/runtime environments have no localStorage.
  }
}

export function clearApiBase(): void {
  try {
    localStorage.removeItem(API_BASE_KEY);
  } catch {
    // Non-browser test/runtime environments have no localStorage.
  }
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

export function wsUrl(path: string): string {
  const base = apiBase();
  if (base !== "") return `${base.replace(/^http/i, "ws")}${path}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
