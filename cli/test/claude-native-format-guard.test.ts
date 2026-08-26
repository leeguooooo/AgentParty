// #953：拿**真 claude 二进制**去核「原生还认不认我们发的格式」。
//
// 仓里原有的守卫（claude-inbox-inject.test.ts 的「attr 顺序固定…逐字精确」）钉的是
// **我们自己的输出**，防的是我们改坏自己；**Claude 那边改了格式它照样全绿**。
// 用「我们的输出没变」代替「原生还认不认」，是拿便宜信号替真实判据。这条把真实判据取回来。
//
// 失败为什么危险：原生接收侧是**顺序固定的严格正则**，匹配不上时的表现是
// **接收方什么都不会发生、也不会报错**（socket 写成功、对方一个字都收不到、两侧零告警）。
//
// 拿不到二进制/抠不出正则一律 **skip 不红**：CI 上没装 claude 是常态，为此常红会让人
// 把守卫关掉，那就白做了。要抓的是「装了 claude 的开发机上原生格式已经变了」。
import { describe, expect, test } from "bun:test";
import {
  buildNativeStrictRegex,
  locateClaudeBinary,
  readClaudeNativeCrossSessionFormat,
} from "../src/claude-native-format";
import { wrapCrossSessionMessage } from "../src/claude-inbox-inject";

// **惰性**取，不在模块加载时扫二进制：`strings -a` 要跑 1 秒并把 58MB 字符串读进内存，
// 放在顶层会卡在同目录所有 spec 之前，把重 subprocess 的用例挤过 5 秒超时线（实测把
// worktree / cli 那几条挤红了，而它们跟本改动毫无关系）。
let cached: { fmt: ReturnType<typeof readClaudeNativeCrossSessionFormat>; native: RegExp | null } | undefined;
function nativeFormat() {
  if (cached === undefined) {
    const binary = locateClaudeBinary();
    const fmt = binary === null ? null : readClaudeNativeCrossSessionFormat(binary);
    cached = { fmt, native: fmt === null ? null : buildNativeStrictRegex(fmt) };
  }
  return cached;
}

describe("原生 cross-session 格式漂移守卫（#953）", () => {
  test("原生严格正则认我们 wrap 出来的消息（无 claude 则跳过）", () => {
    const { fmt, native } = nativeFormat();
    if (native === null || fmt === null) return;
    const samples = [
      wrapCrossSessionMessage({
        from: "uds:/tmp/cc-socks/1.sock",
        fromName: "pwtk",
        fromMode: "prompting",
        body: "channel=pwtk seq=42",
      }),
      // 多行正文：body 段用的是 [\s\S]*，换行必须能过。
      wrapCrossSessionMessage({
        from: "uds:/tmp/cc-socks/2.sock",
        fromName: "a-b_c",
        fromMode: "bypass",
        body: "line1\nline2",
      }),
      // 全属性齐活——顺序就固化在原生那条正则里，多一个属性也得排在对的位置。
      wrapCrossSessionMessage({
        from: "uds:/tmp/cc-socks/3.sock",
        fromSession: "abc123",
        hopChain: "a,b",
        fromName: "n",
        fromMode: "bypass",
        body: "x",
      }),
    ];
    for (const s of samples) {
      expect({
        sample: s.split("\n")[0],
        accepted: native.test(s),
        binary: fmt.binaryPath,
      }).toEqual({ sample: s.split("\n")[0], accepted: true, binary: fmt.binaryPath });
    }
  });

  test("从二进制读到的字符集与取值集，与我们的常量一致（无 claude 则跳过）", () => {
    const { fmt } = nativeFormat();
    if (fmt === null) return;
    // 这两个也是逆向来的，一起盯住。
    expect(fmt.fromCharset?.replace(/\\\\/g, "\\")).toBe("A-Za-z0-9%:_/.\\-");
    expect(fmt.fromModes).toEqual(["bypass", "prompting"]);
  });

  test("抠不出来时 skip 而不是红（无 claude 的 CI 上不许常红）", () => {
    // 这条恒跑：它断言的是"降级路径存在且是 skip"，不依赖本机有没有 claude。
    expect(locateClaudeBinary({ AGENTPARTY_CLAUDE_BINARY: "/nonexistent/claude", HOME: "/nonexistent" })).toBe(null);
    expect(readClaudeNativeCrossSessionFormat("/nonexistent/claude")).toBe(null);
  });
});
