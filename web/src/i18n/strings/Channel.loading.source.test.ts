// @ts-nocheck -- Bun executes this source regression guard outside web tsconfig.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelStrings } from "./Channel";

const channelSource = readFileSync(resolve(import.meta.dir, "../../pages/Channel.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dir, "../../styles/app.css"), "utf8");

const keys = [
  "Channel.empty.noMessagesHint",
  "Channel.older.loading",
  "Channel.older.failed",
  "Channel.older.retry",
  "Channel.older.end",
  "Channel.charter.retry",
  "Channel.history.loadFailed",
  "Channel.history.retry",
] as const;

describe("Channel loading and recovery surfaces (#344 #345 #346 #354)", () => {
  test("defines every status and recovery label in both locales", () => {
    for (const key of keys) {
      expect(ChannelStrings.en[key], `missing English key: ${key}`).toBeTruthy();
      expect(ChannelStrings.zh[key], `missing Chinese key: ${key}`).toBeTruthy();
      expect(ChannelStrings.zh[key]).not.toBe(ChannelStrings.en[key]);
    }
  });

  test("shows a skeleton before bootstrap and the actionable empty state only afterwards", () => {
    expect(channelSource).toContain('!bootstrapped && q === ""');
    expect(channelSource).toContain('className="stream-skeleton"');
    expect(channelSource).toContain("bootstrapped && state.messages.length === 0");
    expect(channelSource).toContain('t("Channel.empty.noMessagesHint")');
    expect(styles).toContain(".msg-card--skeleton");
  });

  test("renders visible earlier-history loading, retry, and end states", () => {
    expect(channelSource).toContain('useState<"idle" | "loading" | "error" | "end">');
    expect(channelSource).toContain('olderStatus === "loading"');
    expect(channelSource).toContain('olderStatus === "error"');
    expect(channelSource).toContain('olderStatus === "end"');
    expect(channelSource).toContain('t("Channel.older.retry")');
    expect(styles).toContain(".stream-top-note");
  });

  test("shows charter load errors outside edit mode and exposes retry", () => {
    expect(channelSource).toContain("error !== null && !(canModerate && editing)");
    expect(channelSource).toContain("onRetry?: () => void");
    expect(channelSource).toContain('t("Channel.charter.retry")');
    expect(channelSource).toContain("onRetry={() => void loadCharter()}");
  });

  test("background charter updates preserve an active editor draft", () => {
    const loadCharterStart = channelSource.indexOf("const loadCharter = useCallback");
    const loadCharterEnd = channelSource.indexOf("const loadIdentities = useCallback");
    const refreshEffectStart = channelSource.indexOf("setSeenCharterRev(readSeenCharterRev(slug));");
    const refreshEffectEnd = channelSource.indexOf("// IM 式初始加载");
    for (const [label, start, end] of [
      ["loadCharter", loadCharterStart, loadCharterEnd],
      ["refreshEffect", refreshEffectStart, refreshEffectEnd],
    ] as const) {
      expect(start, `${label} start anchor`).toBeGreaterThanOrEqual(0);
      expect(end, `${label} end anchor`).toBeGreaterThan(start);
    }
    const loadCharter = channelSource.slice(loadCharterStart, loadCharterEnd);
    const refreshEffect = channelSource.slice(refreshEffectStart, refreshEffectEnd);
    expect(channelSource).toContain("charterEditingRef.current = editing");
    expect(channelSource).toContain("const charterEditBaseRevRef = useRef<number | null>(null);");
    expect(channelSource).toContain('className="d-btn charter-edit" type="button" disabled={charter === null}');
    expect(channelSource).toContain("const editCharter = useCallback(() => {\n    if (charter === null) {");
    expect(loadCharter).toContain(
      'if (!charterEditingRef.current) setCharterDraft(body.charter ?? "");',
    );
    expect(refreshEffect).toContain("void loadCharter();");
    expect(channelSource).toContain("const expectedRev = charterEditBaseRevRef.current;");
    expect(channelSource).toContain("if (expectedRev === null) {");
    expect(channelSource).toContain("err instanceof ConflictError");
    expect(channelSource).toContain('loadCharter(true)');
    expect(refreshEffect).not.toContain("updateCharterEditing(false)");
  });

  test("reuses an initial-history callback for retry and resets pagination refs", () => {
    expect(channelSource).toContain("const loadInitialPage = useCallback");
    expect(channelSource).toContain("onClick={loadInitialPage}");
    expect(channelSource).toContain("hasMoreRef.current = true");
    // #861：游标**不再**被重置成 0。这条曾断言 `initialCursorRef.current = 0`，而那正是缺陷本身——
    // token 静默续期时 ws effect 会读到清 0 的 ref，以 since=0 建 socket，服务端把整段历史当 live
    // 帧重放。分页 ref 的复位由 hasMoreRef/olderStatus 承担，游标只单调前进。
    expect(channelSource).not.toMatch(/initialCursorRef\.current\s*=\s*0\s*;/);
    expect(channelSource).toContain('setOlderStatus("idle")');
    expect(channelSource).toContain('t("Channel.history.retry")');
    expect(channelSource).toContain('tRef.current("Channel.history.loadFailed")');
  });
});
