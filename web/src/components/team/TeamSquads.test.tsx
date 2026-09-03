// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChannelSquad, PresenceEntry, Sender } from "@agentparty/shared";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../../i18n/locale";
import { buildTeamBoard } from "../../lib/teamBoard";
import { TeamBoard } from "./TeamBoard";

const NOW = 1_700_000_000_000;
let renderer: ReactTestRenderer | null = null;
let actEnv: PropertyDescriptor | undefined;
let storage: PropertyDescriptor | undefined;

beforeEach(() => {
  actEnv = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "ap_locale" ? "zh" : null), setItem() {}, removeItem() {} },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  if (actEnv) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnv);
  else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  if (storage) Object.defineProperty(globalThis, "localStorage", storage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function presence(name: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return { type: "presence", name, kind: "agent", state: "waiting", ts: NOW - 1000, last_seen: NOW - 1000, live: true, ...over } as PresenceEntry;
}
function sender(name: string, kind: Sender["kind"] = "agent"): Sender {
  return { name, kind } as Sender;
}
function squad(name: string, members: string[], leader: string | null = null): ChannelSquad {
  return { type: "squad", channel: "c", name, title: null, description: null, leader, members, created_by: "leo", created_by_kind: "human", created_at: NOW, updated_at: NOW };
}
function model(squads: ChannelSquad[]) {
  return buildTeamBoard({
    presence: [presence("a"), presence("b"), presence("c", { state: "offline" })],
    participants: [sender("a"), sender("b"), sender("c")],
    roles: [],
    squads,
    now: NOW,
  });
}
function render(props: Partial<Parameters<typeof TeamBoard>[0]> = {}, squads: ChannelSquad[] = [squad("fe", ["a", "b"], "a")]) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <TeamBoard model={model(squads)} now={NOW} canModerate={true} {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!;
}
const cardNames = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === "li" && typeof n.props["data-lane"] === "string").map((n) => n.props["data-name"]);

describe("TeamBoard · 小队与主持（#1060 PR C）", () => {
  test("点小队名只看它的成员，再点一次恢复全部", () => {
    const r = render({ onCreateSquad: async () => true, onUpdateSquad: async () => true });
    expect(cardNames(r)).toEqual(["a", "b", "c"]);
    const name = r.root.findByProps({ className: "team-squad-name" });
    act(() => name.props.onClick());
    expect(cardNames(r)).toEqual(["a", "b"]);
    expect(name.props["aria-pressed"]).toBe(true);
    act(() => name.props.onClick());
    expect(cardNames(r)).toEqual(["a", "b", "c"]);
  });

  test("新建小队：名字不合法 / 没选成员在本地就拦下，合法时把 name + members + leader 交给 onCreateSquad", async () => {
    const onCreateSquad = mock(async () => true);
    const r = render({ onCreateSquad, onUpdateSquad: async () => true }, []);
    act(() => r.root.findByProps({ className: "d-btn team-squad-create" }).props.onClick());
    const form = r.root.findByType("form");
    const [nameInput] = form.findAllByType("input").filter((n) => n.props.type !== "checkbox");
    act(() => nameInput!.props.onChange({ target: { value: "bad name!" } }));
    await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
    expect(onCreateSquad).not.toHaveBeenCalled();
    act(() => nameInput!.props.onChange({ target: { value: "@infra" } }));
    await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
    expect(onCreateSquad).not.toHaveBeenCalled(); // 没选成员
    const boxes = form.findAllByType("input").filter((n) => n.props.type === "checkbox");
    act(() => boxes[0]!.props.onChange());
    act(() => form.findByType("select").props.onChange({ target: { value: "a" } }));
    await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
    expect(onCreateSquad).toHaveBeenCalledWith("infra", { title: null, members: ["a"], leader: "a" });
    expect(r.root.findAllByType("form")).toHaveLength(0);
  });

  test("编辑小队：名字锁死，成员整体替换后交给 onUpdateSquad；删除走 onDeleteSquad", async () => {
    const onUpdateSquad = mock(async () => true);
    const onDeleteSquad = mock(async () => true);
    const r = render({ onCreateSquad: async () => true, onUpdateSquad, onDeleteSquad });
    const row = r.root.findByProps({ "data-squad": "fe" });
    const [editBtn] = row.findAll((n) => n.type === "button" && n.props.className === "team-card-linkbtn");
    act(() => editBtn!.props.onClick());
    const form = row.findByType("form");
    const nameInput = form.findAllByType("input").find((n) => n.props.type !== "checkbox")!;
    expect(nameInput.props.disabled).toBe(true);
    const boxes = form.findAllByType("input").filter((n) => n.props.type === "checkbox");
    act(() => boxes[1]!.props.onChange()); // 去掉 b
    await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
    expect(onUpdateSquad).toHaveBeenCalledWith("fe", { title: null, members: ["a"], leader: "a" });
    const del = r.root.findByProps({ "data-squad": "fe" }).findAll((n) => n.type === "button" && String(n.props.className).includes("team-squad-delete"))[0]!;
    await act(async () => { del.props.onClick(); await Promise.resolve(); });
    expect(onDeleteSquad).toHaveBeenCalledWith("fe");
  });

  test("「设为主持」只给在线、还不是主持的 agent；非版主看不到", async () => {
    const onAssignHost = mock(async () => true);
    const r = render({ onAssignHost });
    const buttons = r.root.findAll((n) => n.type === "button" && String(n.props.className).includes("team-card-hostbtn"));
    expect(buttons.map((b) => b.props.title)).toHaveLength(2); // a、b 在线；c 离线没有
    await act(async () => { buttons[0]!.props.onClick(); await Promise.resolve(); });
    expect(onAssignHost).toHaveBeenCalledWith("a");
    const r2 = render({ onAssignHost, canModerate: false });
    expect(r2.root.findAll((n) => n.type === "button" && String(n.props.className).includes("team-card-hostbtn"))).toHaveLength(0);
  });
});
