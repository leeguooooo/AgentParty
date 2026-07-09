// markdown 渲染管线：marked → highlight.js（代码块）→ DOMPurify 白名单净化（spec §9）。
// 消息 body 是不可信输入（跨公司 agent 都能写），白名单 + 外链 noopener 是硬要求。
import DOMPurify from "dompurify";
// hljs 只注册 agent 消息里实际常见的语言（比 lib/common 的 ~40 种小一半以上）；
// 未注册的语言走 highlightAuto 在已注册集合内猜，猜不中就按纯文本展示。
import hljs from "highlight.js/lib/core";
import langBash from "highlight.js/lib/languages/bash";
import langC from "highlight.js/lib/languages/c";
import langCpp from "highlight.js/lib/languages/cpp";
import langCss from "highlight.js/lib/languages/css";
import langDiff from "highlight.js/lib/languages/diff";
import langGo from "highlight.js/lib/languages/go";
import langJava from "highlight.js/lib/languages/java";
import langJavascript from "highlight.js/lib/languages/javascript";
import langJson from "highlight.js/lib/languages/json";
import langMarkdown from "highlight.js/lib/languages/markdown";
import langPython from "highlight.js/lib/languages/python";
import langRust from "highlight.js/lib/languages/rust";
import langShell from "highlight.js/lib/languages/shell";
import langSql from "highlight.js/lib/languages/sql";
import langTypescript from "highlight.js/lib/languages/typescript";
import langXml from "highlight.js/lib/languages/xml";
import langYaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";

hljs.registerLanguage("bash", langBash);
hljs.registerLanguage("c", langC);
hljs.registerLanguage("cpp", langCpp);
hljs.registerLanguage("css", langCss);
hljs.registerLanguage("diff", langDiff);
hljs.registerLanguage("go", langGo);
hljs.registerLanguage("java", langJava);
hljs.registerLanguage("javascript", langJavascript);
hljs.registerLanguage("json", langJson);
hljs.registerLanguage("markdown", langMarkdown);
hljs.registerLanguage("python", langPython);
hljs.registerLanguage("rust", langRust);
hljs.registerLanguage("shell", langShell);
hljs.registerLanguage("sql", langSql);
hljs.registerLanguage("typescript", langTypescript);
hljs.registerLanguage("xml", langXml);
hljs.registerLanguage("yaml", langYaml);

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const html = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      return `<pre><code class="hljs">${html}</code></pre>`;
    },
  },
});

// span/class 是 hljs 高亮产物的载体，必须放行。
// img 不放行：远程 src 会让每个看频道的人自动请求第三方主机（IP/时段追踪 beacon），
// MVP 先禁图，v2 需要时走图片代理再开。
const ALLOWED_TAGS = [
  "p", "br", "hr", "a",
  "code", "pre", "span",
  "ul", "ol", "li",
  "strong", "em", "del", "blockquote",
  "table", "thead", "tbody", "tr", "th", "td",
  "h1", "h2", "h3", "h4", "h5", "h6",
];
const ALLOWED_ATTR = ["href", "title", "class", "start"];

// class 只留 hljs 产物和受控 mention 产物，防止消息正文借用应用自身样式伪装系统 UI。
const SAFE_CLASS_RE = /^(?:hljs(?:-[\w-]+)?|ap-mention)$/;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // 外链新窗口 + noopener（净化后统一补，用户写不进 target/rel）
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.hasAttribute("class")) {
    const kept = (node.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((c) => SAFE_CLASS_RE.test(c))
      .join(" ");
    if (kept === "") node.removeAttribute("class");
    else node.setAttribute("class", kept);
  }
});

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false });
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
