// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { desktopClipboardReader } from "./desktopClipboard";

describe("desktopClipboardReader (#1102)", () => {
  test("outside the desktop shell there is no bridge", () => {
    expect(desktopClipboardReader({}, async () => "x")).toBeNull();
  });

  test("inside the shell it invokes the clipboard-manager read_text command", async () => {
    const calls: string[] = [];
    const read = desktopClipboardReader({ __TAURI_INTERNALS__: {} }, async (cmd) => {
      calls.push(cmd);
      return "hi";
    });
    expect(read).not.toBeNull();
    expect(await read!()).toBe("hi");
    expect(calls).toEqual(["plugin:clipboard-manager|read_text"]);
  });

  test("a non-string reply becomes empty text", async () => {
    const read = desktopClipboardReader({ __TAURI_INTERNALS__: {} }, async () => null);
    expect(await read!()).toBe("");
  });
});
