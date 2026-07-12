// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { LarkDirectoryApiError } from "../lib/api";
import { LarkMemberInvite } from "./LarkMemberInvite";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });

test("searches and directly invites a Lark organization user", async () => {
  const invited: string[] = [];
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => ({ users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }], next_cursor: null })}
          invite={async (_token, _slug, id) => { invited.push(id); return { id, name: "Alice", avatar_url: null, already_member: false }; }}
        />
      </LocaleProvider>,
    );
  });
  const input = renderer!.root.findByProps({ "aria-label": "Search Lark organization" });
  act(() => input.props.onChange({ target: { value: "Alice" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  const button = renderer!.root.findByProps({ "data-lark-user-id": "on_alice" });
  await act(async () => button.props.onClick());
  expect(invited).toEqual(["on_alice"]);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Added");
});

test("renders Chinese labels and a contact-permission error", async () => {
  localStorage.setItem("ap_locale", "zh");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <LarkMemberInvite
          slug="room"
          token="token"
          search={async () => { throw new LarkDirectoryApiError("Lark contact permission is not enabled", 503, "unavailable", null); }}
        />
      </LocaleProvider>,
    );
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("搜索同组织成员");
  const input = renderer!.root.findByType("input");
  act(() => input.props.onChange({ target: { value: "张" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(JSON.stringify(renderer!.toJSON())).toContain("当前部署尚未开通 Lark 通讯录权限");
});
