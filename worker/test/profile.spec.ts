// PUT /api/me/handle + GET /api/me 返回 handle（spec 2026-07-08，Task A4）：human 账号会话可设置/更新
// 自己的全局唯一 handle；撞已存在 token 名（含别的 agent token）时 409。
import { describe, expect, it } from "vitest";
import { api, seedToken, uniq } from "./helpers";

describe("PUT /api/me/handle + GET /api/me handle", () => {
  it("human 账号设置 handle 后，GET /api/me 回显该 handle", async () => {
    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });

    const put = await api("/api/me/handle", token, {
      method: "PUT",
      body: JSON.stringify({ handle: "leo" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ handle: "leo" });

    const me = await api("/api/me", token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ handle: "leo" });
  });

  it("handle 撞已存在的 token 名时返回 409", async () => {
    // 名字须满足 HANDLE_RE（全小写字母数字，uniq() 生成的即是）才能验证「撞 token 名」这条冲突路径，
    // 而不是先撞 validateHandleFormat 的格式校验；不用字面量 "bob" 避免跟其它 spec 文件已铸的同名 token 撞车
    // （isolatedStorage: false，D1 在整个 vitest run 内跨文件共享）。
    const tokenName = uniq("agentname");
    await seedToken("agent", tokenName);

    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });

    const put = await api("/api/me/handle", token, {
      method: "PUT",
      body: JSON.stringify({ handle: tokenName }),
    });
    expect(put.status).toBe(409);
  });

  // 命名空间大小写未闭合兜底：先铸一个带大写字母的 token 名，再设同名小写 handle——
  // handleConflict 若按精确大小写匹配 tokens.name，会漏放这条撞车路径。
  it("handle 撞已存在 token 名的大小写变体时返回 409", async () => {
    const tokenName = uniq("CaseTok");
    await seedToken("agent", tokenName);

    const owner = uniq("acct");
    const { token } = await seedToken("human", uniq("tok-human"), { owner });

    const put = await api("/api/me/handle", token, {
      method: "PUT",
      body: JSON.stringify({ handle: tokenName.toLowerCase() }),
    });
    expect(put.status).toBe(409);
  });

  // Option A（GitHub 式，spec 2026-07-08 更新）：handle 允许大写、原样保留显示，但唯一性仍不分
  // 大小写——"Evan" 已被占用后，另一账号设同一 handle 的大小写变体（"evan"）必须 409，不能并存。
  it("设置 handle 后原样保留大小写回显，另一账号设其大小写变体时返回 409", async () => {
    const base = uniq("evan");
    const handle = base[0].toUpperCase() + base.slice(1); // 如 Evan-xxxxxxxx

    const owner1 = uniq("acct");
    const { token: token1 } = await seedToken("human", uniq("tok-human"), { owner: owner1 });
    const put1 = await api("/api/me/handle", token1, {
      method: "PUT",
      body: JSON.stringify({ handle }),
    });
    expect(put1.status).toBe(200);
    expect(await put1.json()).toMatchObject({ handle }); // 保留原大小写，不被强制转小写

    const me1 = await api("/api/me", token1);
    expect(await me1.json()).toMatchObject({ handle });

    const owner2 = uniq("acct");
    const { token: token2 } = await seedToken("human", uniq("tok-human"), { owner: owner2 });
    const put2 = await api("/api/me/handle", token2, {
      method: "PUT",
      body: JSON.stringify({ handle: handle.toLowerCase() }),
    });
    expect(put2.status).toBe(409);
  });
});
