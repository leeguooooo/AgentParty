// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../locale";
import { useT } from "../useT";
import { AppStrings } from "./App";

// App.tsx 高频文案曾硬编码英文（#132）。这里守：新增 key 的 en/zh 双语齐备、
// 人类可见文案 zh ≠ en（不是把英文原样塞进 zh）、且真实渲染出的是对应语言。
// 「App.tsx 源码里不再出现英文字面量」的回归门禁在同目录 App.i18n.source.test.ts。
export const APP_I18N_KEYS = [
  "App.error.ssoNotConfigured",
  "App.error.signInFailed",
  "App.error.sessionExpired",
  "App.error.tokenInvalid",
  "App.error.channelsLoadFailed",
  "App.error.startSignInFailed",
  "App.status.signingIn",
  "App.route.notFound",
  "App.channel.loading",
  "App.channel.unavailable",
  "App.tagline",
  "App.docs",
] as const;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;

// 只显示某 key 翻译结果的探针：读出真实渲染出的文本（走 useT → dict lookup），
// 而不是直接读字符串表，从而验证渲染路径真的落到了中文/英文。
function Probe({ tkey }: { tkey: string }) {
  const t = useT();
  return t(tkey);
}

function renderT(locale: "en" | "zh", tkey: string): string {
  localStorage.setItem("ap_locale", locale);
  act(() => {
    renderer = create(
      <LocaleProvider>
        <Probe tkey={tkey} />
      </LocaleProvider>,
    );
  });
  const json = renderer!.toJSON();
  return typeof json === "string" ? json : Array.isArray(json) ? json.join("") : "";
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
});

describe("App i18n leftovers (#132)", () => {
  test("every App key exists in both en and zh", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const key of APP_I18N_KEYS) {
        expect(AppStrings[locale][key], `${locale} missing ${key}`).toBeTruthy();
      }
    }
  });

  test("en and zh diverge for human-facing App copy (not left as English)", () => {
    for (const key of APP_I18N_KEYS) {
      expect(AppStrings.zh[key], `zh should differ from en for ${key}`).not.toBe(AppStrings.en[key]);
    }
  });

  test("renders Chinese under zh and English under en (real render, not just table)", () => {
    for (const key of APP_I18N_KEYS) {
      const en = renderT("en", key);
      const zh = renderT("zh", key);
      expect(en, `en render for ${key}`).toBe(AppStrings.en[key]);
      expect(zh, `zh render for ${key}`).toBe(AppStrings.zh[key]);
      expect(zh, `rendered zh should differ from en for ${key}`).not.toBe(en);
    }
    // 至少有一条 zh 渲染里真的是中文字符，防止「zh 值不小心又填了英文」
    expect(/[一-鿿]/.test(renderT("zh", "App.route.notFound"))).toBe(true);
  });
});
