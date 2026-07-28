// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopDownloadLink } from "./DesktopDownloadLink";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

describe("DesktopDownloadLink", () => {
  test("opens the installer in-page instead of navigating away", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <DesktopDownloadLink desktop={false} />
        </LocaleProvider>,
      );
    });

    const button = renderer.root.findByType("button");
    expect(button.children.join("")).toBe("desktop");
    await act(async () => button.props.onClick());
    expect(renderer.root.findByProps({ role: "dialog" })).toBeTruthy();
    expect(renderer.root.findByType("textarea").props.value).toContain("install-desktop.sh");
  });

  test("is hidden inside the desktop runtime", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <DesktopDownloadLink desktop />
        </LocaleProvider>,
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });
});
