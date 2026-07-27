import { useEffect, type RefObject } from "react";

interface DismissableLayerOptions {
  active: boolean;
  onDismiss(): void;
  outsideRef?: RefObject<HTMLElement | null>;
  /** Set false when a focus trap on the same layer already owns Escape, so one keypress dismisses once. */
  dismissOnEscape?: boolean;
}

export function useDismissableLayer({
  active,
  onDismiss,
  outsideRef,
  dismissOnEscape = true,
}: DismissableLayerOptions) {
  useEffect(() => {
    if (!active) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = outsideRef?.current;
      if (root === undefined || root === null || root.contains(event.target as Node)) return;
      onDismiss();
    };

    if (dismissOnEscape) window.addEventListener("keydown", onKeyDown);
    if (outsideRef !== undefined) document.addEventListener("pointerdown", onPointerDown);
    return () => {
      if (dismissOnEscape) window.removeEventListener("keydown", onKeyDown);
      if (outsideRef !== undefined) document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [active, dismissOnEscape, onDismiss, outsideRef]);
}
