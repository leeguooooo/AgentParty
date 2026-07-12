// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import type { AuthProviderConfig } from "../lib/oidc";
import { TokenGate } from "./TokenGate";

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

const props = {
  error: null,
  providers: [],
  onSso: () => {},
  onSubmit: () => {},
};

const providers: AuthProviderConfig[] = [
  {
    type: "oidc",
    id: "@oidc",
    label: "",
    issuer: "https://accounts.example.com",
    clientId: "agentparty-web",
  },
  {
    type: "oauth",
    id: "github",
    kind: "github",
    label: "",
    clientId: "github-client",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user",
  },
  {
    type: "oauth",
    id: "custom",
    kind: "custom",
    label: "  Continue with Company SSO  ",
    clientId: "custom-client",
    authorizeUrl: "https://login.example.com/authorize",
    scope: "openid",
  },
];

describe("TokenGate", () => {
  test("renders a language switcher on the logged-out login page", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <TokenGate {...props} />
      </LocaleProvider>,
    );
    // the reused switcher marks itself with the lang-switch group + both locale buttons
    expect(html).toContain("lang-switch");
    expect(html).toContain(">EN<");
    expect(html).toContain(">中<");
  });

  describe("interactive locale switching", () => {
    let renderer: ReactTestRenderer | null = null;
    // Restore globals after each case so a persisted memoryStorage carrying `ap_locale=zh`
    // cannot leak into other test files' LocaleProviders.
    let priorStorage: PropertyDescriptor | undefined;
    let priorActEnv: PropertyDescriptor | undefined;

    beforeEach(() => {
      priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      priorActEnv = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
    });

    afterEach(() => {
      act(() => { renderer?.unmount(); });
      renderer = null;
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else delete (globalThis as Record<string, unknown>).localStorage;
      if (priorActEnv) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnv);
      else delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    });

    test("clicking 中 switches the gate copy to Chinese", () => {
      act(() => {
        renderer = create(
          <LocaleProvider>
            <TokenGate {...props} providers={providers} />
          </LocaleProvider>,
        );
      });
      const root = renderer!.root;

      const subtitle = () => {
        const node = root.findAll((n) => n.props.className === "d-hand gate-sub")[0];
        if (!node) throw new Error("gate subtitle not found");
        return node.children.join("");
      };
      // default locale is English
      expect(subtitle()).toBe("agents talk, humans watch");
      const providerLabels = () => root
        .findAll((n) => n.props.className === "d-btn d-btn--primary gate-btn")
        .map((n) => n.children.join(""));
      expect(providerLabels()).toEqual([
        "Sign in with account center",
        "Sign in with github",
        "  Continue with Company SSO  ",
      ]);

      const zhButton = root
        .findAll((n) => n.type === "button")
        .find((n) => n.children.join("") === "中");
      if (!zhButton) throw new Error("Chinese locale button not rendered on the login page");

      act(() => { zhButton.props.onClick(); });

      expect(subtitle()).toBe("Agent 言说，人默望");
      expect(providerLabels()).toEqual([
        "使用账号中心登录",
        "使用 github 登录",
        "  Continue with Company SSO  ",
      ]);
    });
  });
});
