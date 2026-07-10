// #126 follow-up 安全修复：jwtSub + gateSession 的纯状态机测试。
import { describe, expect, test } from "bun:test";
import { gateSession, jwtSub, sessionIdentityOf } from "./sessionIdentity";

// 造一个 payload 为 {sub} 的假 JWT（不签名——jwtSub 只解不验）。
// 先 UTF-8 编码再 btoa：payload 里可能有非 ASCII（如中文 sub），btoa 本身只吃 Latin1，
// 直接喂 JSON 字符串会抛 InvalidCharacterError——这里的编码方式要对得上 decodeSegment 的解码方式。
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}
const NOW = 1_000_000;
const fresh = (over = {}) => ({ accessToken: "at", refreshToken: "rt", expiresAt: NOW + 3600, ...over });

describe("jwtSub", () => {
  test("合法 JWT 解出 sub", () => {
    expect(jwtSub(fakeJwt({ sub: "user-1" }))).toBe("user-1");
  });
  test("payload 无 sub 字段 → null", () => {
    expect(jwtSub(fakeJwt({ name: "no sub here" }))).toBeNull();
  });
  test("只有 2 段（非 JWT 结构）→ null", () => {
    const twoSeg = fakeJwt({ sub: "user-1" }).split(".").slice(0, 2).join(".");
    expect(jwtSub(twoSeg)).toBeNull();
  });
  test("非字符串输入 → null", () => {
    expect(jwtSub(null)).toBeNull();
    expect(jwtSub(undefined)).toBeNull();
  });
  test("payload 段 base64 乱码 → null", () => {
    expect(jwtSub("aaa.###not-base64###.sig")).toBeNull();
  });
  test("sub 为空串 → null", () => {
    expect(jwtSub(fakeJwt({ sub: "" }))).toBeNull();
  });
  test("sub 含非 ASCII（如中文用户名）→ 正确解出", () => {
    expect(jwtSub(fakeJwt({ sub: "用户-1" }))).toBe("用户-1");
  });
});

describe("sessionIdentityOf", () => {
  test("有 identity → 原值", () => {
    expect(sessionIdentityOf({ identity: "user-1" })).toBe("user-1");
  });
  test("旧 session 无该字段 → null", () => {
    expect(sessionIdentityOf({ accessToken: "at" })).toBeNull();
  });
  test("null → null", () => {
    expect(sessionIdentityOf(null)).toBeNull();
  });
});

describe("gateSession（#126 follow-up 边界矩阵，nowSec = NOW）", () => {
  test("session 为 null → none", () => {
    expect(gateSession(null, "user-1", NOW)).toBe("none");
  });
  test("accessToken 为 null → none", () => {
    expect(gateSession({ accessToken: null }, "user-1", NOW)).toBe("none");
  });
  test("旧 session 无 identity + 有 refreshToken → refresh（禁止 adopt，走正常 refresh）", () => {
    expect(gateSession(fresh({ identity: undefined }), "user-1", NOW)).toBe("refresh");
  });
  test("旧 session 无 identity + 无 refreshToken → none", () => {
    expect(gateSession(fresh({ identity: undefined, refreshToken: null }), "user-1", NOW)).toBe("none");
  });
  test("identity 有值但 currentIdentity 为 null → foreign（无法证明同身份，一步都不碰）", () => {
    expect(gateSession(fresh({ identity: "user-1" }), null, NOW)).toBe("foreign");
  });
  test("identity ≠ currentIdentity 且很新鲜 → foreign（跨身份回归：新鲜也不许 adopt）", () => {
    expect(gateSession(fresh({ identity: "user-2" }), "user-1", NOW)).toBe("foreign");
  });
  test("identity === currentIdentity 且新鲜 → adopt（同身份回归）", () => {
    expect(gateSession(fresh({ identity: "user-1" }), "user-1", NOW)).toBe("adopt");
  });
  test("identity === currentIdentity 但已过期 + 有 refreshToken → refresh", () => {
    expect(gateSession(fresh({ identity: "user-1", expiresAt: NOW - 1 }), "user-1", NOW)).toBe("refresh");
  });
  test("identity === currentIdentity 但已过期 + 无 refreshToken → none", () => {
    expect(
      gateSession(fresh({ identity: "user-1", expiresAt: NOW - 1, refreshToken: null }), "user-1", NOW),
    ).toBe("none");
  });
  test("SKEW 边界：expiresAt = NOW + 30 恰好不算新鲜 → 同身份下应为 refresh", () => {
    expect(gateSession(fresh({ identity: "user-1", expiresAt: NOW + 30 }), "user-1", NOW)).toBe("refresh");
  });
  test("SKEW 边界：expiresAt = NOW + 31 → adopt", () => {
    expect(gateSession(fresh({ identity: "user-1", expiresAt: NOW + 31 }), "user-1", NOW)).toBe("adopt");
  });
});
