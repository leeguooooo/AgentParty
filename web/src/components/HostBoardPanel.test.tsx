// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { HostBoard, RecommendedAction } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { HostBoardPanel } from "./HostBoardPanel";

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer!.unmount());
    renderer = null;
  }
});

const action = (overrides: Partial<RecommendedAction> = {}): RecommendedAction => ({
  kind: "assign-host",
  reason: "no visible host role in channel presence",
  target: null,
  command: "party channel role set <agent-name> host demo",
  requires_human: true,
  ...overrides,
});

const board = (recommendedActions: RecommendedAction[]): HostBoard => ({
  schema: "agentparty.v1",
  type: "host_board",
  channel: "demo",
  generated_at: 1,
  last_seq: 42,
  hosts: [],
  open_claims: [],
  blockers: [],
  conflicts: [],
  decisions: [],
  unlinked_claims: [],
  recommended_actions: recommendedActions,
});

describe("HostBoardPanel", () => {
  test("turns a missing-host warning into a direct assignment flow", async () => {
    const assigned: string[] = [];
    act(() => {
      renderer = create(
        <LocaleProvider>
          <HostBoardPanel
            board={board([action()])}
            candidates={[
              { name: "offline-agent", label: "Mina · offline-agent", online: false },
              { name: "live-agent", label: "Leo · live-agent", online: true },
            ]}
            canAssignHost
            onAssignHost={async (name) => {
              assigned.push(name);
              return true;
            }}
          />
        </LocaleProvider>,
      );
    });

    const select = renderer!.root.findByType("select");
    expect(select.props.value).toBe("live-agent");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Choose the channel Host");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("no visible host role in channel presence");

    const assign = renderer!.root.findByProps({ className: "d-btn d-btn--primary" });
    await act(async () => {
      await assign.props.onClick();
    });

    expect(assigned).toEqual(["live-agent"]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("live-agent is now the Host");
  });

  test("explains the permission boundary instead of exposing a dead control", () => {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <HostBoardPanel
            board={board([action()])}
            candidates={[{ name: "agent", label: "Owner · agent", online: true }]}
          />
        </LocaleProvider>,
      );
    });

    expect(renderer!.root.findAllByType("select")).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ className: "d-btn d-btn--primary" })).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Only the channel owner or moderator");
  });

  test("keeps non-assignment recommendations visible", () => {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <HostBoardPanel
            board={board([
              action({
                kind: "review-blockers",
                reason: "2 blocked claims need host triage",
                target: "agent",
                command: null,
                requires_human: false,
              }),
            ])}
          />
        </LocaleProvider>,
      );
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("review-blockers");
    expect(JSON.stringify(renderer!.toJSON())).toContain("2 blocked claims need host triage");
  });
});
