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
    const loadCharter = channelSource.slice(
      channelSource.indexOf("const loadCharter = useCallback"),
      channelSource.indexOf("const loadIdentities = useCallback"),
    );
    const refreshEffect = channelSource.slice(
      channelSource.indexOf("setSeenCharterRev(readSeenCharterRev(slug));"),
      channelSource.indexOf("// IM 式初始加载"),
    );
    const syncDivision = channelSource.slice(
      channelSource.indexOf("const syncDivisionToCharter = useCallback"),
      channelSource.indexOf("const openAgentRulesFromDivision = useCallback"),
    );
    expect(channelSource).toContain("charterEditingRef.current = editing");
    expect(loadCharter).toContain(
      'if (!charterEditingRef.current) setCharterDraft(body.charter ?? "");',
    );
    expect(syncDivision).toContain("if (!charterEditingRef.current) {");
    expect(syncDivision).toContain('setCharterDraft(body.charter ?? "");');
    expect(syncDivision).toContain("updateCharterEditing(false);");
    expect(refreshEffect).not.toContain("updateCharterEditing(false)");
  });

  test("reuses an initial-history callback for retry and resets pagination refs", () => {
    expect(channelSource).toContain("const loadInitialPage = useCallback");
    expect(channelSource).toContain("onClick={loadInitialPage}");
    expect(channelSource).toContain("hasMoreRef.current = true");
    expect(channelSource).toContain("initialCursorRef.current = 0");
    expect(channelSource).toContain('t("Channel.history.retry")');
    expect(channelSource).toContain('tRef.current("Channel.history.loadFailed")');
  });
});
