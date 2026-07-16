// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");

/** Extracts one balanced media block, including nested rule braces. */
function mediaBlockAt(start: number): string {
  const openingBrace = css.indexOf("{", start);
  if (openingBrace < 0) throw new Error(`Missing media block at ${start}`);

  let depth = 0;
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`Unclosed media block at ${start}`);
}

/** Finds the media block for a breakpoint that owns a specific selector. */
function mediaBlockContaining(query: string, selector: string, from = 0): string {
  let cursor = from;
  while (cursor < css.length) {
    const start = css.indexOf(query, cursor);
    if (start < 0) break;
    const block = mediaBlockAt(start);
    if (block.includes(selector)) return block;
    cursor = start + query.length;
  }
  throw new Error(`No ${query} block contains ${selector}`);
}

describe("responsive product-shell polish", () => {
  test("the invite panel keeps a viewport-bound layout after the base popover rule", () => {
    const inviteSection = css.indexOf("/* ---- 邀请链接");
    const baseRule = css.indexOf(".joinlink-panel {", inviteSection);
    const mediumRule = css.indexOf("@media (min-width: 761px) and (max-width: 1759px)", baseRule);

    expect(inviteSection).toBeGreaterThan(-1);
    expect(baseRule).toBeGreaterThan(-1);
    expect(mediumRule).toBeGreaterThan(baseRule);
    expect(mediaBlockAt(mediumRule)).toMatch(/\.joinlink-panel\s*\{[^}]*position:\s*fixed;[^}]*top:\s*auto;[^}]*bottom:\s*12px;/s);
  });

  test("mobile invite generation gives fields stable columns and the command a full row", () => {
    const mobileInvite = mediaBlockContaining("@media (max-width: 760px)", ".joinlink-gen-row");

    expect(mobileInvite).toMatch(/\.joinlink-gen-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s);
    expect(mobileInvite).toMatch(/\.joinlink-expiry\s*\{[^}]*display:\s*grid;[^}]*min-width:\s*0;/s);
    expect(mobileInvite).toMatch(/\.joinlink-expiry select\s*\{[^}]*width:\s*100%;/s);
    expect(mobileInvite).toMatch(/\.joinlink-gen-row\s*>\s*\.d-btn\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*width:\s*100%;/s);
  });

  test("mobile task cards reserve a full first row for their title", () => {
    const mobileTasks = mediaBlockContaining("@media (max-width: 760px)", ".task-ledger-panel .task-card-main");

    expect(mobileTasks).toMatch(/\.task-ledger-panel \.task-card-main\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(mobileTasks).toMatch(/\.task-ledger-panel \.task-card-title\s*\{[^}]*order:\s*-1;[^}]*flex:\s*1 0 100%;/s);
  });

  test("agent cards can align inward instead of widening the message stream", () => {
    const desktopCards = mediaBlockContaining("@media (min-width: 761px)", ".msg-agent-popover--align-end");
    const mobileCards = mediaBlockContaining("@media (max-width: 760px)", ".msg-agent-card");

    expect(css).toMatch(/\.msg-agent-card\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.msg-agent-popover--hover-open \.msg-agent-card,\s*\.msg-agent-popover:not\(\.msg-agent-popover--closed\):focus-within \.msg-agent-card,\s*\.msg-agent-popover--open \.msg-agent-card\s*\{[^}]*display:\s*block;/s);
    expect(desktopCards).toMatch(/\.msg-agent-popover--hover-open::after,[\s\S]*\.msg-agent-popover--open::after\s*\{[^}]*width:\s*min\(360px,\s*calc\(100vw - 32px\)\);[^}]*height:\s*7px;/s);
    expect(desktopCards).toMatch(/\.msg-agent-popover--align-end::after\s*\{[^}]*left:\s*auto;[^}]*right:\s*0;/s);
    expect(desktopCards).toMatch(/\.msg-agent-popover--align-end \.msg-agent-card\s*\{[^}]*left:\s*auto;[^}]*right:\s*0;/s);
    expect(mobileCards).toMatch(/\.msg-agent-card\s*\{[^}]*inset:\s*auto 10px/s);
  });

  test("visibility help opens inward and settings language controls hug their content", () => {
    expect(css).toMatch(/\.vis-toggle > \.feature-tip \.feature-tip-bubble\s*\{[^}]*left:\s*auto;[^}]*right:\s*0;[^}]*transform:\s*none;/s);
    expect(css).toMatch(/\.settings-panel \.lang-switch\s*\{[^}]*display:\s*inline-flex;[^}]*width:\s*max-content;[^}]*max-width:\s*100%;/s);
  });

  test("compact channel settings do not stretch to the full mobile viewport", () => {
    const mobileSettings = mediaBlockContaining("@media (max-width: 760px)", ".channel-panel-card:has(.guard-settings)");
    expect(mobileSettings).toMatch(/\.channel-panel-card:has\(\.guard-settings\)\s*\{[^}]*align-self:\s*flex-start;/s);
  });

  test("the medium header stays on one row after removing secondary identity copy", () => {
    const mediumHeader = mediaBlockContaining("@media (min-width: 761px) and (max-width: 1100px)", ".app-head");

    expect(mediumHeader).toMatch(/\.app-head\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(mediumHeader).toMatch(/\.app-tag\s*\{[^}]*display:\s*none;/s);
    expect(mediumHeader).toMatch(/\.app-me-prefix,[\s\S]*\.app-me-owner\s*\{[^}]*display:\s*none;/s);
  });
});
