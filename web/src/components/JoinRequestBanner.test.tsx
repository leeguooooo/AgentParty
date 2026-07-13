// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { JoinRequestBanner } from "./JoinRequestBanner";

let renderer: ReactTestRenderer | null = null;
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });
function render(props: React.ComponentProps<typeof JoinRequestBanner>) {
  act(() => { renderer = create(<LocaleProvider><JoinRequestBanner {...props} /></LocaleProvider>); });
  return renderer!;
}

test("offers join with a trimmed optional application note", () => {
  let applied: string | null = null;
  const r = render({ state: "idle", onApply: (note) => { applied = note; } });
  const input = r.root.findByProps({ className: "joinrequest-note-input" });
  act(() => input.props.onChange({ target: { value: "  I can help test releases  " } }));
  act(() => r.root.findByProps({ className: "d-btn d-btn--primary joinrequest-apply" }).props.onClick());
  expect(applied).toBe("I can help test releases");
  expect(input.props.maxLength).toBe(2000);
});

test("renders server states, rejection reason, and approved entry", () => {
  for (const state of ["submitting", "pending", "already_member"] as const) {
    const r = render({ state });
    expect(r.root.findByProps({ "data-join-request-state": state })).toBeTruthy();
    act(() => r.unmount()); renderer = null;
  }
  const rejected = render({ state: "rejected", reason: "Need a clearer purpose" });
  expect(JSON.stringify(rejected.toJSON())).toContain("Need a clearer purpose");
  act(() => rejected.unmount()); renderer = null;
  let entered = 0;
  const approved = render({ state: "approved", onEnter: () => { entered += 1; } });
  act(() => approved.root.findByProps({ className: "d-btn d-btn--primary joinrequest-enter" }).props.onClick());
  expect(entered).toBe(1);
});

test("error state exposes retry", () => {
  let retries = 0;
  const r = render({ state: "error", onRetry: () => { retries += 1; } });
  act(() => r.root.findByProps({ className: "d-btn joinrequest-status-retry" }).props.onClick());
  expect(retries).toBe(1);
});
