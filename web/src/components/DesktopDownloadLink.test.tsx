// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopDownloadLink } from "./DesktopDownloadLink";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

describe("DesktopDownloadLink", () => {
  test("links browser users to the desktop product page", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <DesktopDownloadLink desktop={false} />
        </LocaleProvider>,
      );
    });

    const link = renderer.root.findByType("a");
    expect(link.props.href).toBe("https://app.leeguoo.com/agentparty");
    expect(link.children.join("")).toBe("desktop");
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
