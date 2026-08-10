// client.ts 的 message_update action allow-list 必须逐字镜像 protocol.ts 的 MessageUpdateFrame["action"]。
//
// 这条不变量之前已经断过一次（#622）：allow-list 漏了一个词，对应类型的帧不是报错而是**静默丢弃**——
// 收帧方看到的是「什么都没发生」，最难查的那种。类型系统在这里帮不上忙：allow-list 是运行时的字符串
// 数组，与类型联合之间没有任何编译期联系。所以只能靠这条测试把两边钉在一起。
import { describe, expect, test } from "bun:test";

const PROTOCOL = new URL("../../shared/src/protocol.ts", import.meta.url);
const CLIENT = new URL("../src/client.ts", import.meta.url);

function unionMembers(source: string): string[] {
  const match = source.match(/export interface MessageUpdateFrame \{[\s\S]*?\n {2}action:([^;]+);/);
  if (match === null) throw new Error("could not find MessageUpdateFrame.action in protocol.ts");
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
}

function allowList(source: string): string[] {
  const match = source.match(/case "message_update":[\s\S]*?\[([^\]]+)\]\.includes\(String\(value\.action\)\)/);
  if (match === null) throw new Error("could not find the message_update allow-list in client.ts");
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
}

describe("message_update action allow-list", () => {
  test("client.ts mirrors protocol.ts verbatim", async () => {
    const actions = unionMembers(await Bun.file(PROTOCOL).text());
    const allowed = allowList(await Bun.file(CLIENT).text());
    expect(actions.length).toBeGreaterThan(0);
    expect(allowed).toEqual(actions);
  });

  test("receipt is one of them (#828)", async () => {
    expect(allowList(await Bun.file(CLIENT).text())).toContain("receipt");
  });
});
