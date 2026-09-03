import { describe, expect, test } from "bun:test";
import { buildPersonRows, isStaleSession, personAnchor, type PersonLike } from "./personRoster";

function s(name: string, over: Partial<PersonLike> = {}): PersonLike {
  return {
    name,
    kind: "human",
    account: null,
    handle: null,
    displayName: null,
    owner: null,
    display: name,
    state: "offline",
    ...over,
  };
}

describe("名单按人聚合（#1067）", () => {
  test("锚点优先级：handle > account/owner > name", () => {
    expect(personAnchor(s("a", { handle: "Leo", account: "lark:on_x" }))).toEqual({ key: "handle:leo", anchor: "handle" });
    expect(personAnchor(s("a", { account: "leo@x.com" }))).toEqual({ key: "account:leo@x.com", anchor: "account" });
    // 服务端按原值精确比较 account：只差大小写＝两个主体
    expect(personAnchor(s("a", { account: "Leo@x.com" })).key).not.toBe(personAnchor(s("b", { account: "leo@x.com" })).key);
    expect(personAnchor(s("a", { owner: "leo@x.com" }))).toEqual({ key: "account:leo@x.com", anchor: "account" });
    expect(personAnchor(s("a"))).toEqual({ key: "name:human:a", anchor: "name" });
    // agent 是独立个体：无论 handle/account 如何，都按名字各自成行
    expect(personAnchor(s("bot", { kind: "agent", handle: "bot", account: "acct" }))).toEqual({ key: "name:agent:bot", anchor: "name" });
  });

  test("同一账号的多个会话折成一行，代表取排序最靠前的那个", () => {
    const rows = buildPersonRows(
      [
        s("leo-host-chat", { account: "leo@x.com", state: "offline" }),
        s("leo-dispatch", { account: "leo@x.com", state: "online", displayName: "Leo" }),
        s("leo-host-e2e", { account: "leo@x.com", state: "offline" }),
      ],
      { rank: (item) => (item.state === "online" ? 0 : 1) },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessions).toHaveLength(3);
    expect(rows[0]!.primary.name).toBe("leo-dispatch");
    expect(rows[0]!.display).toBe("Leo");
    expect(rows[0]!.accountCount).toBe(1);
  });

  test("同一个人的两个账号靠 handle 合并，并标出账号数（截图里的「两个我」）", () => {
    const rows = buildPersonRows([
      s("lark-14c1a0719d91", { handle: "leo", account: "lark-email:leo@x.com", displayName: "Leo" }),
      s("lark-5a360aff4587", { handle: "leo", account: "lark:on_22608d74" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.anchor).toBe("handle");
    expect(rows[0]!.accountCount).toBe(2);
    expect(rows[0]!.display).toBe("Leo");
  });

  test("显示名永不落到不透明账号串上", () => {
    const rows = buildPersonRows([s("lark:on_acda4d", { account: "lark:on_acda4d", display: "lark:on_acda4d" })]);
    expect(rows[0]!.display).toBe("lark:on_acda4d"); // 无可读名时保留原样，但……
    expect(rows[0]!.owner).toBeNull(); // 归属列不显示不透明串
    const withName = buildPersonRows([s("lark:on_acda4d", { account: "lark:on_acda4d", displayName: "向阳", display: "lark:on_acda4d" })]);
    expect(withName[0]!.display).toBe("向阳");
  });

  test("历史遗留会话：无任何身份信息 + 不透明名字 + 离线", () => {
    expect(isStaleSession(s("lark:on_acda4d50062e089bf3b2401b907decde"))).toBe(true);
    expect(isStaleSession(s("193af9b8-cb06-4efe-a0f5-f1284bb8303e"))).toBe(true);
    expect(isStaleSession(s("lark:on_x", { state: "online" }))).toBe(false);
    expect(isStaleSession(s("lark:on_x", { account: "lark:on_x" }))).toBe(false);
    expect(isStaleSession(s("leo", { kind: "agent" }))).toBe(false);
    const rows = buildPersonRows([s("lark:on_dead"), s("leo", { account: "leo@x.com", state: "online" })]);
    expect(rows.filter((r) => r.stale).map((r) => r.primary.name)).toEqual(["lark:on_dead"]);
  });

  test("agent 各自成行，不会因为同 owner 被并到人身上", () => {
    const rows = buildPersonRows([
      s("leo", { account: "leo@x.com", handle: "leo", state: "online" }),
      s("bot-a", { kind: "agent", account: "leo@x.com", owner: "leo@x.com", state: "online" }),
      s("bot-b", { kind: "agent", account: "leo@x.com", owner: "leo@x.com", state: "online" }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === "human")!.sessions).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "agent").map((r) => r.primary.name).sort()).toEqual(["bot-a", "bot-b"]);
  });
});
