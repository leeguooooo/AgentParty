const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaudeJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

function directMessageBlocks(
  event: Record<string, unknown>,
  eventType: "assistant" | "user",
  mainSessionOnly: boolean,
): Record<string, unknown>[] {
  if (
    event.type !== eventType ||
    !record(event.message) ||
    !Array.isArray(event.message.content) ||
    (mainSessionOnly && event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) ||
    (mainSessionOnly && event.agent_id !== undefined && event.agent_id !== null)
  ) return [];
  return event.message.content.filter(record);
}

/** Direct tool blocks from Claude's stream-json message envelope, never recursive decoys. */
export function directClaudeToolUseBlocks(
  event: Record<string, unknown>,
  mainSessionOnly = true,
): Record<string, unknown>[] {
  return directMessageBlocks(event, "assistant", mainSessionOnly)
    .filter((block) => block.type === "tool_use");
}

/** Direct tool-result blocks from Claude's stream-json message envelope, never recursive decoys. */
export function directClaudeToolResultBlocks(
  event: Record<string, unknown>,
  mainSessionOnly = true,
): Record<string, unknown>[] {
  return directMessageBlocks(event, "user", mainSessionOnly)
    .filter((block) => block.type === "tool_result");
}

export interface ClaudeStreamInit {
  index: number;
  sessionId: string;
  event: Record<string, unknown>;
}

export function uniqueClaudeStreamInit(
  events: readonly Record<string, unknown>[],
): ClaudeStreamInit | null {
  const matches = events.flatMap((event, index) =>
    event.type === "system" &&
      event.subtype === "init" &&
      typeof event.session_id === "string" &&
      SESSION_ID_RE.test(event.session_id)
      ? [{ index, sessionId: event.session_id, event }]
      : []
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function sameSessionEventsAfterUniqueInit(
  events: readonly Record<string, unknown>[],
): Record<string, unknown>[] | null {
  const init = uniqueClaudeStreamInit(events);
  if (init === null) return null;
  // Preserve original indexes so the caller's order checks remain exact. An
  // event outside the armed session becomes inert, while callers can still
  // count tool calls over the unmasked full stream to reject duplicates.
  return events.map((event, index) =>
    index > init.index && event.session_id === init.sessionId ? event : {}
  );
}

/**
 * Locate one successful direct tool result in the unique top-level stream
 * session. A matching result in a child/foreign session, duplicate result, or
 * explicit error cannot prove that the requested tool completed.
 */
export function uniqueSuccessfulClaudeToolResultIndex(
  events: readonly Record<string, unknown>[],
  toolUseId: string | null,
  afterIndex: number,
): number | null {
  if (toolUseId === null || toolUseId === "" || afterIndex < 0) return null;
  const sessionEvents = sameSessionEventsAfterUniqueInit(events);
  if (sessionEvents === null) return null;
  const allMatches = events.flatMap((event) =>
    directClaudeToolResultBlocks(event, false).filter((result) => result.tool_use_id === toolUseId)
  );
  if (allMatches.length !== 1 || allMatches[0]!.is_error === true) return null;
  const index = sessionEvents.findIndex((event, currentIndex) => {
    if (currentIndex <= afterIndex) return false;
    const results = directClaudeToolResultBlocks(event);
    return results.length === 1 &&
      results[0]!.tool_use_id === toolUseId &&
      results[0]!.is_error !== true;
  });
  return index < 0 ? null : index;
}

/**
 * Prove that one exact tool call completed successfully before a unique inbound
 * marker, with no other tool inserted from an optional earlier boundary.
 */
export function completedClaudeToolBoundaryBeforeMarker(
  events: readonly Record<string, unknown>[],
  toolName: string,
  markerIndex: number | null,
  afterIndex: number = -1,
): boolean {
  if (toolName === "" || markerIndex === null) return false;
  const sessionEvents = sameSessionEventsAfterUniqueInit(events);
  if (sessionEvents === null) return false;
  const allUses = events.flatMap((event) =>
    directClaudeToolUseBlocks(event, false).filter((use) => use.name === toolName)
  );
  if (allUses.length !== 1) return false;
  const useIndex = sessionEvents.findIndex((event, currentIndex) => {
    if (currentIndex <= afterIndex) return false;
    const uses = directClaudeToolUseBlocks(event);
    return uses.length === 1 && uses[0]!.name === toolName;
  });
  const use = useIndex < 0 ? null : directClaudeToolUseBlocks(sessionEvents[useIndex]!)[0] ?? null;
  const useId = typeof use?.id === "string" && use.id !== "" ? use.id : null;
  const resultIndex = uniqueSuccessfulClaudeToolResultIndex(events, useId, useIndex);
  const noToolBetween = (start: number, end: number): boolean =>
    start >= -1 && end > start && sessionEvents.slice(start + 1, end)
      .every((event) => directClaudeToolUseBlocks(event).length === 0);
  return useIndex > afterIndex &&
    resultIndex !== null &&
    markerIndex > resultIndex &&
    noToolBetween(afterIndex, useIndex) &&
    noToolBetween(useIndex, resultIndex) &&
    noToolBetween(resultIndex, markerIndex);
}

/**
 * Release a process-level wait only after one exact main-session SendMessage
 * emits one non-error direct result. Final evidence must still inspect the
 * complete streams; this helper coordinates timing and cannot prove delivery.
 */
export function createClaudeSendMessageResultBarrier(
  expectedMessage: string,
  release: () => void,
): (line: string) => void {
  let sessionId: string | null = null;
  let toolUseId: string | null = null;
  let invalid = false;
  let released = false;
  return (line: string): void => {
    const event = parseClaudeJsonLine(line);
    if (event === null) return;
    if (event.type === "system" && event.subtype === "init") {
      const init = uniqueClaudeStreamInit([event]);
      if (init === null || sessionId !== null) invalid = true;
      else sessionId = init.sessionId;
      return;
    }
    if (sessionId === null || event.session_id !== sessionId) return;
    const uses = directClaudeToolUseBlocks(event);
    const matchingUses = uses.filter((use) =>
      use.name === "SendMessage" && record(use.input) && use.input.message === expectedMessage
    );
    if (matchingUses.length > 0) {
      const id = matchingUses.length === 1 && uses.length === 1 && typeof matchingUses[0]!.id === "string"
        ? matchingUses[0]!.id as string
        : "";
      if (toolUseId !== null || id === "") invalid = true;
      else toolUseId = id;
    }
    const results = directClaudeToolResultBlocks(event);
    if (
      !invalid &&
      !released &&
      toolUseId !== null &&
      results.length === 1 &&
      results[0]!.tool_use_id === toolUseId &&
      results[0]!.is_error !== true
    ) {
      released = true;
      release();
    }
  };
}

function inboundUserTextContains(event: Record<string, unknown>, marker: string): boolean {
  if (
    event.type !== "user" ||
    !record(event.message) ||
    (event.isReplay !== undefined && event.isReplay !== false) ||
    event.tool_use_result !== undefined ||
    (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) ||
    (event.agent_id !== undefined && event.agent_id !== null)
  ) return false;
  const content = event.message.content;
  if (typeof content === "string") return content.includes(marker);
  if (!Array.isArray(content) || content.length === 0) return false;
  // Agent SDK tool results are also type=user. Cross-session payloads are
  // plain text, so mixed or tool_result content cannot prove delivery.
  const textBlocks = content.flatMap((item) =>
    record(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []
  );
  return textBlocks.length === content.length && textBlocks.some((text) => text.includes(marker));
}

export function uniqueInboundTextMarkerIndex(
  events: readonly Record<string, unknown>[],
  marker: string,
): number | null {
  const init = uniqueClaudeStreamInit(events);
  if (init === null) return null;
  const matches = events.flatMap((event, index) =>
    index > init.index &&
      event.session_id === init.sessionId &&
      inboundUserTextContains(event, marker)
      ? [index]
      : []
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function receiverObservedTextMarker(
  events: readonly Record<string, unknown>[],
  marker: string,
): boolean {
  return uniqueInboundTextMarkerIndex(events, marker) !== null;
}
