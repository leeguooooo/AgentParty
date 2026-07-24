// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { canApplyCharterWrite } from "./charterRequestGeneration";
import { useCharterRequestGeneration } from "./useCharterRequestGeneration";

type Lifecycle = ReturnType<typeof useCharterRequestGeneration>;

let renderer: ReactTestRenderer | null = null;
let latest: Lifecycle | null = null;

function Harness({ slug, token }: { slug: string; token: string }) {
  latest = useCharterRequestGeneration(slug);
  return <span data-token={token}>{latest.saving ? "saving" : "idle"}</span>;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  latest = null;
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer!.unmount());
    renderer = null;
  }
});

describe("useCharterRequestGeneration lifecycle", () => {
  test("same-slug token refresh preserves a pending PUT until its finally cleanup", () => {
    act(() => {
      renderer = create(<Harness slug="demo" token="old-token" />);
    });

    let requestId: number | null = null;
    act(() => {
      requestId = latest!.beginWrite();
    });
    expect(requestId).not.toBeNull();
    expect(latest!.saving).toBe(true);
    expect(canApplyCharterWrite(latest!.generationRef.current, requestId!)).toBe(true);

    act(() => {
      renderer!.update(<Harness slug="demo" token="new-token" />);
    });
    expect(latest!.saving).toBe(true);
    expect(canApplyCharterWrite(latest!.generationRef.current, requestId!)).toBe(true);

    act(() => {
      expect(latest!.finishWrite(requestId!)).toBe(true);
    });
    expect(latest!.saving).toBe(false);
  });

  test("slug changes invalidate a pending PUT and reset saving", () => {
    act(() => {
      renderer = create(<Harness slug="first" token="token" />);
    });
    let requestId: number | null = null;
    act(() => {
      requestId = latest!.beginWrite();
    });
    const previousGeneration = latest!.generationRef;

    act(() => {
      renderer!.update(<Harness slug="second" token="token" />);
    });
    expect(canApplyCharterWrite(previousGeneration.current, requestId!)).toBe(false);
    expect(latest!.saving).toBe(false);
  });

  test("unmount invalidates a pending PUT", () => {
    act(() => {
      renderer = create(<Harness slug="demo" token="token" />);
    });
    let requestId: number | null = null;
    act(() => {
      requestId = latest!.beginWrite();
    });
    const generation = latest!.generationRef;

    act(() => {
      renderer!.unmount();
      renderer = null;
    });
    expect(canApplyCharterWrite(generation.current, requestId!)).toBe(false);
  });
});
