// 引用预览文字：把正文压成单行、截断到定长。Channel 插话框的"回复中"提示条与
// MessageCard 的引用预览块共用同一份实现，避免两处截断规则各写各的、慢慢跑偏。
export function summarizeReplyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 96) return collapsed;
  return `${collapsed.slice(0, 93)}...`;
}
