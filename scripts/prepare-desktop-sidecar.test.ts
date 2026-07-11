import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  bunTargetForRustTriple,
  parseCliArgs,
  parseRustHostTriple,
  sidecarOutputPath,
  validateArtifactSize,
} from "./prepare-desktop-sidecar";

describe("prepare desktop sidecar", () => {
  test("maps Apple Silicon Rust hosts to Bun's macOS arm64 target", () => {
    expect(bunTargetForRustTriple("aarch64-apple-darwin")).toBe("bun-darwin-arm64");
  });

  test("maps Intel Rust hosts to Bun's macOS x64 target", () => {
    expect(bunTargetForRustTriple("x86_64-apple-darwin")).toBe("bun-darwin-x64");
  });

  test("maps supported Linux and Windows Rust hosts", () => {
    expect(bunTargetForRustTriple("aarch64-unknown-linux-gnu")).toBe("bun-linux-arm64");
    expect(bunTargetForRustTriple("x86_64-unknown-linux-gnu")).toBe("bun-linux-x64");
    expect(bunTargetForRustTriple("x86_64-pc-windows-msvc")).toBe("bun-windows-x64");
  });

  test("fails closed for an unsupported Rust host", () => {
    expect(() => bunTargetForRustTriple("riscv64gc-unknown-linux-gnu")).toThrow(
      "unsupported Rust host triple: riscv64gc-unknown-linux-gnu",
    );
  });

  test("extracts the host triple from rustc verbose version output", () => {
    expect(parseRustHostTriple("rustc 1.96.0\nhost: x86_64-apple-darwin\nrelease: 1.96.0\n")).toBe(
      "x86_64-apple-darwin",
    );
  });

  test("rejects rustc output without a host triple", () => {
    expect(() => parseRustHostTriple("rustc 1.96.0\nrelease: 1.96.0\n")).toThrow(
      "rustc -vV did not report a host triple",
    );
  });

  test("accepts an injectable target and rejects incomplete CLI arguments", () => {
    expect(parseCliArgs(["--target", "aarch64-apple-darwin"])).toEqual({
      target: "aarch64-apple-darwin",
    });
    expect(() => parseCliArgs(["--target"])).toThrow("--target requires a Rust host triple");
    expect(() => parseCliArgs(["--unknown"])).toThrow("unknown argument: --unknown");
  });

  test("uses Tauri's target-suffixed external binary filename", () => {
    expect(sidecarOutputPath("/repo", "aarch64-apple-darwin")).toBe(
      resolve("/repo", "desktop/src-tauri/binaries/party-aarch64-apple-darwin"),
    );
    expect(sidecarOutputPath("C:/repo", "x86_64-pc-windows-msvc")).toEndWith(
      "desktop/src-tauri/binaries/party-x86_64-pc-windows-msvc.exe",
    );
  });

  test("fails closed for an empty sidecar artifact", () => {
    expect(() => validateArtifactSize("/tmp/party", 0)).toThrow(
      "desktop sidecar is empty: /tmp/party",
    );
    expect(() => validateArtifactSize("/tmp/party", 128)).not.toThrow();
  });
});
