// markdown 渲染管线：marked → highlight.js（代码块）→ DOMPurify（spec §9）
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";

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

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false });
  return DOMPurify.sanitize(raw);
}
