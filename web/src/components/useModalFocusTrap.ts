import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

interface ModalFocusTrapOptions {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onEscape?(): void;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (container === null || typeof container.querySelectorAll !== "function") return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      (element.closest?.('[hidden], [aria-hidden="true"]') ?? null) === null &&
      // jsdom leaves tabIndex undefined on bare stubs; only a negative value means opted out.
      (element.tabIndex === undefined || element.tabIndex >= 0),
  );
}

/**
 * Gives an aria-modal dialog the keyboard behavior its semantics promise:
 * focus enters on open, Tab stays inside, Escape dismisses, and close restores
 * the element that launched it.
 */
export function useModalFocusTrap({
  active,
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onEscape,
}: ModalFocusTrapOptions): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;

    const doc = typeof document === "undefined" ? null : document;
    const win = typeof window === "undefined" ? null : window;
    const previouslyFocused = (doc?.activeElement ?? null) as HTMLElement | null;
    const container = () => containerRef.current;
    const items = () => focusableElements(container());

    (initialFocusRef?.current ?? items()[0] ?? container())?.focus?.();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;

      const focusables = items();
      const root = container();
      if (focusables.length === 0) {
        event.preventDefault();
        root?.focus?.();
        return;
      }

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const current = (doc?.activeElement ?? null) as HTMLElement | null;
      const focusIsOutside =
        current === null ||
        root === null ||
        typeof root.contains !== "function" ||
        !root.contains(current);
      if (event.shiftKey && (current === first || current === root || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    };

    win?.addEventListener?.("keydown", onKeyDown);
    return () => {
      win?.removeEventListener?.("keydown", onKeyDown);
      // 显式目标若已随卸载消失，退回打开前的焦点，而不是把焦点丢给 body。
      const explicit = returnFocusRef?.current ?? null;
      const target = explicit !== null && explicit.isConnected !== false ? explicit : previouslyFocused;
      if (target?.isConnected === false) return;
      target?.focus?.();
    };
  }, [active, containerRef, initialFocusRef, returnFocusRef]);
}
