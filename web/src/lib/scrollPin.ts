export interface ScrollViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isNearBottom(viewport: ScrollViewport, threshold = 160): boolean {
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const scrollTop = Math.max(0, Math.min(viewport.scrollTop, maxScrollTop));
  return maxScrollTop - scrollTop < threshold;
}

export function pinToBottom(viewport: ScrollViewport, enabled: boolean): boolean {
  if (!enabled) return false;
  viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return true;
}
