// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import "../i18n/strings/Channel"; // 触发 registerDict，让 t() 解析团队面板文案
import { TeamTabs } from "./TeamTabs";

// #504 团队面板博客风：三个页签（01 分工 / 02 Agent 看板 / 03 协调）替代一整页长滚动。
// 只测结构层——页签切换、角标计数、头部提示符——现有 DivisionBoard/AgentBoard 数据逻辑不动。

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <LocaleProvider>
        <TeamTabs
          stats={{ roles: 3, online: 3, offline: 7, unclaimed: 10 }}
          mentionCount={1}
          division={<div>DIVISION_PANEL</div>}
          board={<div>BOARD_PANEL</div>}
          coordination={<div>COORD_PANEL</div>}
        />
      </LocaleProvider>,
    );
  });
  return r;
}

function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object" && "children" in (node as { children?: unknown })) {
      walk((node as { children?: unknown }).children);
    }
  };
  walk(r.toJSON());
  return out.join(" ");
}

function tabButtons(r: ReactTestRenderer) {
  return r.root
    .findAllByType("button")
    .filter((b) => (b.props.className ?? "").includes("team-blog-tab"));
}

describe("TeamTabs (#504 博客风页签)", () => {
  test("头部渲染 $ cat ./team/overview 提示符与状态角标", () => {
    const r = render();
    const text = allText(r);
    expect(text).toContain("$ cat ./team/overview");
    expect(text).toContain("10"); // 未认领
    expect(text).toContain("7"); // 离线
  });

  test("默认显示分工页，看板/协调页不渲染", () => {
    const r = render();
    const text = allText(r);
    expect(text).toContain("DIVISION_PANEL");
    expect(text).not.toContain("BOARD_PANEL");
    expect(text).not.toContain("COORD_PANEL");
  });

  test("三个页签编号 01/02/03，未认领角标挂在分工、@角标挂在协调", () => {
    const r = render();
    expect(tabButtons(r).length).toBe(3);
    const text = allText(r);
    expect(text).toContain("01");
    expect(text).toContain("02");
    expect(text).toContain("03");
    // 分工页签带未认领 10；协调页签带 @1
    expect(text).toContain("10");
    expect(text).toContain("@1");
  });

  test("点第二个页签切到看板，点第三个切到协调", () => {
    const r = render();
    act(() => {
      tabButtons(r)[1]!.props.onClick();
    });
    let text = allText(r);
    expect(text).toContain("BOARD_PANEL");
    expect(text).not.toContain("DIVISION_PANEL");
    act(() => {
      tabButtons(r)[2]!.props.onClick();
    });
    text = allText(r);
    expect(text).toContain("COORD_PANEL");
    expect(text).not.toContain("BOARD_PANEL");
  });
});
