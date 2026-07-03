export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const MAX_TIMEOUT_SEC = Math.floor(2_147_483_647 / 1000);

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

export function isName(value: string): boolean {
  return NAME_RE.test(value);
}

export function parseNonNegativeIntFlag(value: string | undefined, flag: string): number | string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return `--${flag} must be a non-negative integer`;
  return Number(value);
}

export function parsePositiveIntFlag(
  value: string | undefined,
  flag: string,
  max?: number,
): number | string | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) return `--${flag} must be a positive integer`;
  const n = Number(value);
  if (max !== undefined && n > max) return `--${flag} must be <= ${max}`;
  return n;
}

export function normalizeServerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
