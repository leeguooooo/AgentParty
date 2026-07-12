// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { ServerProfileStrings } from "../i18n/strings/ServerProfiles";
import {
  OFFICIAL_SERVER_PROFILES,
  type ServerProfileStorage,
} from "../lib/serverProfiles";
import { DesktopServerAuthorizationRequiredError } from "../lib/serverSwitch";
import {
  probeAndAddServerProfile,
  ServerProfilePicker,
  ServerSwitcher,
  ServerSwitcherView,
} from "./ServerProfiles";

describe("server profile controls", () => {
  test("registers complete English and Chinese labels", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const key of [
        "ServerProfiles.server",
        "ServerProfiles.add.title",
        "ServerProfiles.add.check",
        "ServerProfiles.providers.none",
        "ServerProfiles.switch.failed",
        "ServerProfiles.switch.unpaired",
        "ServerProfiles.switch.authorizationRequired",
        "ServerProfiles.switch.pair",
        "ServerProfiles.switch.retry",
        "ServerProfiles.switch.authorizeRetry",
        "ServerProfiles.addPair",
        "ServerProfiles.addPair.cancel",
      ]) {
        expect(ServerProfileStrings[locale][key]).toBeTruthy();
      }
    }
  });

  test("renders official profiles and keyboard-native custom server controls", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <ServerProfilePicker
          profiles={[...OFFICIAL_SERVER_PROFILES]}
          selectedOrigin={OFFICIAL_SERVER_PROFILES[0]!.origin}
          onSelect={() => {}}
          onProfilesChanged={() => {}}
        />
      </LocaleProvider>,
    );
    expect(html).toContain("AgentParty Production");
    expect(html).toContain("AgentParty Test");
    expect(html).toContain('type="url"');
    expect(html).toContain("Check and add server");
    expect(html).not.toContain("emoji");
  });

  test("renders a compact header switcher with pending and failure states", () => {
    const pending = renderToStaticMarkup(
      <LocaleProvider>
        <ServerSwitcherView
          profiles={[...OFFICIAL_SERVER_PROFILES]}
          activeOrigin={OFFICIAL_SERVER_PROFILES[0]!.origin}
          pending={true}
          error={null}
          pairTarget={null}
          authorizationTarget={null}
          retryTarget={null}
          onSelect={() => {}}
          onAddPair={() => {}}
          onPair={() => {}}
          onAuthorize={() => {}}
          onRetry={() => {}}
        />
      </LocaleProvider>,
    );
    expect(pending).toContain("disabled");
    expect(pending).toContain("Switching server");

    const failed = renderToStaticMarkup(
      <LocaleProvider>
        <ServerSwitcherView
          profiles={[...OFFICIAL_SERVER_PROFILES]}
          activeOrigin={OFFICIAL_SERVER_PROFILES[0]!.origin}
          pending={false}
          error="Could not switch"
          pairTarget="https://agentparty.pwtk-dev.work"
          authorizationTarget={null}
          retryTarget={null}
          onSelect={() => {}}
          onAddPair={() => {}}
          onPair={() => {}}
          onAuthorize={() => {}}
          onRetry={() => {}}
        />
      </LocaleProvider>,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Could not switch");
    expect(failed).toContain("Pair this server");
    expect(failed).toContain("Add or pair server");
  });

  test("authorizes the failed target interactively before retrying the switch", async () => {
    const current = OFFICIAL_SERVER_PROFILES[0]!.origin;
    const target = OFFICIAL_SERVER_PROFILES[1]!.origin;
    const calls: string[] = [];
    let switches = 0;
    const onSwitch = async (origin: string, restoredAccessToken?: string) => {
      switches += 1;
      calls.push(`switch:${origin}:${restoredAccessToken ?? "automatic"}`);
      if (switches === 1) throw new DesktopServerAuthorizationRequiredError(origin);
    };
    const restoreInteractive = async (origin: string) => {
      calls.push(`authorize:${origin}`);
      return "interactive-access";
    };
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <ServerSwitcher
            profiles={[...OFFICIAL_SERVER_PROFILES]}
            activeOrigin={current}
            onSwitch={onSwitch}
            onAddPair={() => {}}
            onPair={() => {}}
            restoreInteractive={restoreInteractive}
          />
        </LocaleProvider>,
      );
    });
    await act(async () => {
      renderer!.root.findByProps({ id: "active-server" }).props.onChange({ target: { value: target } });
    });
    const authorize = renderer!.root.findAllByType("button")
      .find((button) => button.children.join("") === "Authorize and retry");
    expect(authorize).toBeTruthy();

    await act(async () => { authorize!.props.onClick(); });

    expect(calls).toEqual([
      `switch:${target}:automatic`,
      `authorize:${target}`,
      `switch:${target}:interactive-access`,
    ]);
    await act(async () => renderer!.unmount());
  });

  test("retries generic failures without invoking interactive Keychain access", async () => {
    const current = OFFICIAL_SERVER_PROFILES[0]!.origin;
    const target = OFFICIAL_SERVER_PROFILES[1]!.origin;
    let switches = 0;
    let authorizations = 0;
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <ServerSwitcher
            profiles={[...OFFICIAL_SERVER_PROFILES]}
            activeOrigin={current}
            onSwitch={async () => {
              switches += 1;
              if (switches === 1) throw new TypeError("offline");
            }}
            onAddPair={() => {}}
            onPair={() => {}}
            restoreInteractive={async () => {
              authorizations += 1;
              return "interactive-access";
            }}
          />
        </LocaleProvider>,
      );
    });
    await act(async () => {
      renderer!.root.findByProps({ id: "active-server" }).props.onChange({ target: { value: target } });
    });
    const retry = renderer!.root.findAllByType("button")
      .find((button) => button.children.join("") === "Retry");
    expect(retry).toBeTruthy();

    await act(async () => { retry!.props.onClick(); });

    expect(switches).toBe(2);
    expect(authorizations).toBe(0);
    await act(async () => renderer!.unmount());
  });

});

test("custom servers are persisted only after successful probing", async () => {
  const values = new Map<string, string>();
  const storage: ServerProfileStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const result = await probeAndAddServerProfile(
    storage,
    { label: "Private", origin: "https://party.example.com" },
    async (input) => String(input).endsWith("/api/health")
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({
        oidc: { issuer: "https://id.example.com", client_id: "public-web" },
      }), { status: 200 }),
  );

  expect(result.probe.providers.map((provider) => provider.label)).toEqual([""]);
  expect(result.profiles.at(-1)?.origin).toBe("https://party.example.com");
});
