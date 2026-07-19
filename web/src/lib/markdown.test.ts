// markdown 渲染管线的解析层回归（纯 marked，不依赖 DOM——DOMPurify 净化只在浏览器里跑，见 markdown.ts）。
// 钉住 GFM 表格与任务列表能被解析出结构化标签：DOMPurify 白名单已放行 table/th/td/input（disabled 复选框）
// 与 align 属性，正文样式在 app.css 的 .msg-body 段。用户曾报「没办法展示表格」——根因是表格根本没样式，
// 但前提是 marked 必须先把它解析成 <table>；本用例守住这个前提，防未来关掉 GFM 又静默回归。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { markdownToHtmlUnsafe } from "./markdown";

describe("markdown 解析", () => {
  test("GFM 表格解析成结构化 <table>（表头 + 数据单元格 + 列对齐）", () => {
    const html = markdownToHtmlUnsafe("| h1 | h2 | h3 |\n|:-:|--:|:--|\n| a | b | c |");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    // 列对齐要落成 align 属性（DOMPurify 白名单已放行 align），否则对齐意图丢失
    expect(html).toContain('align="center"');
    expect(html).toContain('align="right"');
  });

  test("GFM 任务列表解析成 disabled 复选框（勾选态保留）", () => {
    const html = markdownToHtmlUnsafe("- [ ] todo\n- [x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
  });

  test("代码块与行内代码分别落成 <pre><code> 与裸 <code>", () => {
    const html = markdownToHtmlUnsafe("行内 `x` 与\n\n```\nblock\n```\n");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
  });

  test("纯 HTML 注释被丢弃（charter 的 ap:division marker 不再漏成可见文字），正文照常渲染", () => {
    const section = "<!-- ap:division:start -->\n### Division of labor (synced)\n- **leo-claude**（lark:x）— host：#126\n<!-- ap:division:end -->";
    const html = markdownToHtmlUnsafe(section);
    // marker 注释不落任何可见文本（既不裸露也不被转义成 &lt;!--）
    expect(html).not.toContain("ap:division");
    expect(html).not.toContain("&lt;!--");
    // marker 之间的正文正常渲染
    expect(html).toContain("<h3>Division of labor (synced)</h3>");
    expect(html).toContain("<strong>leo-claude</strong>");
  });

  test("#642 不回归：混了内容的裸 HTML 仍转义成可见文本，绝不真渲染", () => {
    // 只有「整段就是一个注释」才丢弃；注释后跟内容的混合 token 仍走转义，不给伪造 UI 的绕过面。
    const html = markdownToHtmlUnsafe('<span class="ap-mention" title="@owner">@owner</span>');
    expect(html).toContain("&lt;span");
    expect(html).not.toContain('<span class="ap-mention"');
  });

  test("#642 边界：注释后紧跟正文（<!-- -->evil）不因注释判断而丢正文，整段仍转义成可见文本", () => {
    // marked 把 `<!-- -->evil` 收成单个 html token——纯注释分支绝不能匹配它、把 evil 一起吞掉。
    const html = markdownToHtmlUnsafe("<!-- x -->evil");
    expect(html).toContain("evil"); // 正文不被丢弃
    expect(html).toContain("&lt;!--"); // 注释头也转义成可见文本，而非当注释隐藏
    expect(html).not.toContain("<!-- x -->"); // 绝不作为真实注释/HTML 渲染
  });

  test("缩进注释（marked 保留的 0–3 空格）也被丢弃，不漏成可见文字", () => {
    const html = markdownToHtmlUnsafe("   <!-- ap:division:start -->");
    expect(html).not.toContain("ap:division");
    expect(html).not.toContain("&lt;!--");
  });
});
