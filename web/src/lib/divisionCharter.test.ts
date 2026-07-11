import { describe, expect, test } from "bun:test";
import { formatDivisionSection, mergeDivisionIntoCharter } from "./divisionCharter";

// issue #150：分工内容应该能一键同步进频道公告。这里只测纯函数（拼 markdown
// 小节 + 幂等合并进已有公告文本），DivisionBoard 组件测试另见 Channel.tsx 的
// DivisionBoard.test.tsx，覆盖按钮触发这两个函数的组合调用。

const LABELS = { heading: "Division of labor (synced)", empty: "No structured roles yet." };

describe("formatDivisionSection", () => {
  test("renders one bullet per role with account, role and responsibility", () => {
    const section = formatDivisionSection(
      [
        { display: "leo-claude", accountLabel: "leo", role: "host", responsibility: "desktop 集成验收" },
        { display: "Evan_Claude", accountLabel: "evan", role: "worker", responsibility: null },
      ],
      LABELS,
    );
    expect(section).toContain("leo-claude");
    expect(section).toContain("desktop 集成验收");
    expect(section).toContain("host");
    expect(section).toContain("Evan_Claude");
    expect(section).toContain("worker");
    expect(section).toContain(LABELS.heading);
  });

  test("uses the empty label when there are no declared roles", () => {
    const section = formatDivisionSection([], LABELS);
    expect(section).toContain(LABELS.empty);
  });

  test("wraps output in stable start/end markers so it can be found again later", () => {
    const section = formatDivisionSection([], LABELS);
    expect(section).toMatch(/^<!-- ap:division:start -->/);
    expect(section).toMatch(/<!-- ap:division:end -->$/);
  });
});

describe("mergeDivisionIntoCharter", () => {
  test("appends the section to charter text that has no prior sync marker", () => {
    const merged = mergeDivisionIntoCharter("# Team charter\n\nBe kind.", "<!-- ap:division:start -->\nfoo\n<!-- ap:division:end -->");
    expect(merged).toContain("# Team charter");
    expect(merged).toContain("Be kind.");
    expect(merged).toContain("foo");
  });

  test("appends cleanly to empty charter text without a leading blank line mess", () => {
    const merged = mergeDivisionIntoCharter("", "<!-- ap:division:start -->\nfoo\n<!-- ap:division:end -->");
    expect(merged).toBe("<!-- ap:division:start -->\nfoo\n<!-- ap:division:end -->");
  });

  test("replaces a previously-synced section in place instead of duplicating it", () => {
    const before = "# Team charter\n\n<!-- ap:division:start -->\nold content\n<!-- ap:division:end -->\n\nMore hand-written rules.";
    const merged = mergeDivisionIntoCharter(before, "<!-- ap:division:start -->\nnew content\n<!-- ap:division:end -->");
    expect(merged).toContain("new content");
    expect(merged).not.toContain("old content");
    expect(merged).toContain("More hand-written rules.");
    // exactly one copy of the section — no duplicate markers left behind
    expect(merged.split("ap:division:start").length - 1).toBe(1);
  });

  test("preserves hand-written charter prose surrounding the synced section", () => {
    const before = "Please read this.\n\n<!-- ap:division:start -->\nold\n<!-- ap:division:end -->\n\nAlso this.";
    const merged = mergeDivisionIntoCharter(before, "<!-- ap:division:start -->\nnew\n<!-- ap:division:end -->");
    expect(merged).toContain("Please read this.");
    expect(merged).toContain("Also this.");
  });
});
