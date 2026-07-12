import { useState, type FormEvent } from "react";
import {
  inviteLarkMember,
  LarkDirectoryApiError,
  searchLarkDirectory,
  type LarkDirectoryPage,
  type LarkDirectoryUser,
} from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/LarkMemberInvite";
import "./LarkMemberInvite.css";

interface Props {
  slug: string;
  token: string;
  search?: typeof searchLarkDirectory;
  invite?: typeof inviteLarkMember;
  onInvited?(user: LarkDirectoryUser): void;
}

export function LarkMemberInvite({
  slug,
  token,
  search = searchLarkDirectory,
  invite = inviteLarkMember,
  onInvited,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<LarkDirectoryUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function errorLabel(cause: unknown, fallbackKey: string): string {
    if (cause instanceof LarkDirectoryApiError) {
      if (cause.status === 429 || cause.code === "rate_limited") return t("LarkInvite.error.rateLimited");
      if (cause.status === 403) return t("LarkInvite.error.forbidden");
      if (cause.status === 503 && cause.message.toLowerCase().includes("permission")) {
        return t("LarkInvite.error.permission");
      }
    }
    return t(fallbackKey);
  }

  async function runSearch(nextCursor: string | null) {
    const normalized = query.trim();
    if (!normalized) return;
    setBusy(true);
    setError(null);
    try {
      const page: LarkDirectoryPage = await search(token, slug, normalized, 20, nextCursor);
      setUsers((current) => nextCursor === null ? page.users : [...current, ...page.users]);
      setCursor(page.next_cursor);
      setSearched(true);
    } catch (cause) {
      setError(errorLabel(cause, "LarkInvite.error.search"));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await runSearch(null);
  }

  async function add(user: LarkDirectoryUser) {
    setInviting(user.id);
    setError(null);
    try {
      const added = await invite(token, slug, user.id);
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, already_member: true } : item));
      onInvited?.(added);
    } catch (cause) {
      setError(errorLabel(cause, "LarkInvite.error.invite"));
    } finally {
      setInviting(null);
    }
  }

  return (
    <section className="lark-invite" aria-labelledby="lark-invite-title">
      <h3 id="lark-invite-title">{t("LarkInvite.title")}</h3>
      <form className="lark-invite-search" onSubmit={submit}>
        <input
          type="search"
          value={query}
          maxLength={64}
          aria-label={t("LarkInvite.searchLabel")}
          placeholder={t("LarkInvite.placeholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="d-btn d-btn--primary" disabled={busy || !query.trim()}>
          {busy ? t("LarkInvite.searching") : t("LarkInvite.search")}
        </button>
      </form>
      {error !== null && <p className="lark-invite-error" role="alert">{error}</p>}
      {searched && users.length === 0 && !busy && <p className="lark-invite-empty">{t("LarkInvite.empty")}</p>}
      {users.length > 0 && (
        <ul className="lark-invite-results">
          {users.map((user) => (
            <li key={user.id}>
              {user.avatar_url
                ? <img src={user.avatar_url} alt="" width={32} height={32} referrerPolicy="no-referrer" />
                : <span className="lark-invite-avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>}
              <span className="lark-invite-name">{user.name}</span>
              <button
                type="button"
                className="d-btn"
                data-lark-user-id={user.id}
                disabled={user.already_member || inviting === user.id}
                onClick={() => add(user)}
              >
                {user.already_member
                  ? t("LarkInvite.added")
                  : inviting === user.id
                    ? t("LarkInvite.inviting")
                    : t("LarkInvite.invite")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor !== null && (
        <button type="button" className="d-btn lark-invite-more" disabled={busy} onClick={() => runSearch(cursor)}>
          {t("LarkInvite.more")}
        </button>
      )}
    </section>
  );
}
