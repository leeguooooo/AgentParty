import { describe, expect, test } from "bun:test";
import { authConfigForRuntime, decideJoinAuthAction, type AuthConfig } from "./oidc";

const config: AuthConfig = {
  oidc: { issuer: "https://account.example.com", clientId: "agentparty-web" },
  providers: [
    {
      type: "oidc",
      id: "oidc",
      label: "Sign in",
      issuer: "https://account.example.com",
      clientId: "agentparty-web",
    },
  ],
};

describe("authConfigForRuntime", () => {
  test("keeps redirect-based providers in a browser runtime", () => {
    expect(authConfigForRuntime(config, {})).toBe(config);
  });

  test("hides redirect-based providers in Tauri without mutating the fetched config", () => {
    expect(authConfigForRuntime(config, { __TAURI_INTERNALS__: {} })).toEqual({ oidc: null, providers: [] });
    expect(config.providers).toHaveLength(1);
    expect(config.oidc?.clientId).toBe("agentparty-web");
  });
});

describe("decideJoinAuthAction", () => {
  test("does nothing outside a join route", () => {
    expect(
      decideJoinAuthAction({
        joinCode: null,
        hasToken: false,
        providerAvailable: true,
        providersResolved: true,
        providerLoginPending: false,
      }),
    ).toBe("none");
  });

  test("redeems a join code when a token is present", () => {
    expect(
      decideJoinAuthAction({
        joinCode: "invite-123",
        hasToken: true,
        providerAvailable: false,
        providersResolved: true,
        providerLoginPending: false,
      }),
    ).toBe("redeem");
  });

  test("starts provider login for an unauthenticated browser join", () => {
    const browserConfig = authConfigForRuntime(config, {});
    expect(
      decideJoinAuthAction({
        joinCode: "invite-123",
        hasToken: false,
        providerAvailable: browserConfig.providers.length > 0,
        providersResolved: true,
        providerLoginPending: false,
      }),
    ).toBe("begin-provider-login");
  });

  test("requests token login when Tauri filters redirect providers", () => {
    const tauriConfig = authConfigForRuntime(config, { __TAURI_INTERNALS__: {} });
    expect(
      decideJoinAuthAction({
        joinCode: "invite-123",
        hasToken: false,
        providerAvailable: tauriConfig.providers.length > 0,
        providersResolved: true,
        providerLoginPending: false,
      }),
    ).toBe("request-token-login");
  });

  test("waits while a provider callback is pending", () => {
    expect(
      decideJoinAuthAction({
        joinCode: "invite-123",
        hasToken: false,
        providerAvailable: true,
        providersResolved: true,
        providerLoginPending: true,
      }),
    ).toBe("none");
  });

  test("waits until provider availability is resolved", () => {
    expect(
      decideJoinAuthAction({
        joinCode: "invite-123",
        hasToken: false,
        providerAvailable: false,
        providersResolved: false,
        providerLoginPending: false,
      }),
    ).toBe("none");
  });
});
