const PENDING_KEY = "ap_pending_join_request";
const TARGET_KEY = "ap_join_request_target";
const PENDING_TTL_MS = 15 * 60 * 1000;
const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const JOIN_REQUEST_NOTE_MAX_LENGTH = 2000;

export interface PendingJoinRequest {
  slug: string;
  note: string;
  expiresAt: number;
}

function validSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

function validNote(value: unknown): value is string {
  return typeof value === "string" && value.length <= JOIN_REQUEST_NOTE_MAX_LENGTH;
}

export function savePendingJoinRequest(value: { slug: string; note?: string }, now = Date.now()): void {
  if (!validSlug(value.slug)) throw new Error("invalid pending join request");
  const rawNote: unknown = value.note;
  if (rawNote !== undefined && typeof rawNote !== "string") throw new Error("invalid pending join request");
  const note = (rawNote ?? "").trim();
  if (!validNote(note)) throw new Error("invalid pending join request");
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ slug: value.slug, note, expiresAt: now + PENDING_TTL_MS }));
}

export function readPendingJoinRequest(now = Date.now()): PendingJoinRequest | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Partial<PendingJoinRequest> | null;
    const note = parsed?.note === undefined ? "" : parsed.note;
    if (parsed === null || !validSlug(parsed.slug) || !validNote(note) || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) {
      throw new Error("invalid pending join request");
    }
    return { slug: parsed.slug, note, expiresAt: parsed.expiresAt };
  } catch {
    clearPendingJoinRequest();
    return null;
  }
}

export function clearPendingJoinRequest(): void {
  sessionStorage.removeItem(PENDING_KEY);
}

export function rememberJoinRequestTarget(slug: string): void {
  if (!validSlug(slug)) throw new Error("invalid join request target");
  sessionStorage.setItem(TARGET_KEY, slug);
}

export function readJoinRequestTarget(): string | null {
  const slug = sessionStorage.getItem(TARGET_KEY);
  if (slug === null) return null;
  if (validSlug(slug)) return slug;
  sessionStorage.removeItem(TARGET_KEY);
  return null;
}

export function clearJoinRequestTarget(): void {
  sessionStorage.removeItem(TARGET_KEY);
}
