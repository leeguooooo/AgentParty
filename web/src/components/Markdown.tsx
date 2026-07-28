import { useMemo } from "react";
import type { IdentityDisplayMap } from "../lib/identityDisplay";
import { renderMarkdown } from "../lib/markdown";

export function Markdown({
  source,
  identities,
  display,
}: {
  source: string;
  identities?: IdentityDisplayMap;
  display?: (name: string) => string;
}) {
  // renderMarkdown 内部已过 DOMPurify 白名单；mention 在 marked 解析后美化（#131）
  const html = useMemo(() => renderMarkdown(source, identities, display), [source, identities, display]);
  return <div className="msg-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
