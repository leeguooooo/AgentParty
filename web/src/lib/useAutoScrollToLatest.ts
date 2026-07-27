import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Log panes show a tail of a file, so the useful default is the newest line.
 * Keep this behavior shared between the overview and the dedicated duty-log view.
 */
export function useAutoScrollToLatest<T extends HTMLElement>(
  content: string | null | undefined,
  active = true,
): RefObject<T | null> {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || element === null || content?.trim() === "") return;
    element.scrollTop = element.scrollHeight;
  }, [active, content]);

  return ref;
}
