// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(import.meta.dir + "/Channel.tsx", "utf8");

test("permanent member removal clears local channel snapshots only after the API succeeds", () => {
  const callbackStart = source.indexOf("const removeParticipant = useCallback");
  const callbackEnd = source.indexOf("const pauseAgentReception = useCallback", callbackStart);
  expect(callbackStart).toBeGreaterThanOrEqual(0);
  expect(callbackEnd).toBeGreaterThan(callbackStart);

  const callback = source.slice(callbackStart, callbackEnd);
  // #1070 起这段改成 async/await（要逐个 await 附属会话），断言随之从 .then 链改为 await 顺序。
  // #1070 起本地投影收进 applyRemovalResult 助手，主/附属会话共用；助手只在 await 之后被调用。
  const helperDef = callback.indexOf("const applyRemovalResult = (");
  const request = callback.indexOf('applyRemovalResult(name, await kickParticipant(token, slug, name, "remove"))');

  expect(helperDef).toBeGreaterThanOrEqual(0);
  expect(request).toBeGreaterThan(helperDef);
  // 投影只此一处，杜绝「API 还没回就先清本地」
  expect(callback.match(/applyAuthoritativeParticipantRemoval\(result\.removal\)/g)).toHaveLength(1);
  expect(callback).toContain("result?.removal");
  // 附属会话的回包也要投影，否则广播失败时页面还显示着已删的会话（Codex stop-review 第三轮）
  expect(callback).toContain('applyRemovalResult(other, await kickParticipant(token, slug, other, "remove"))');
});

test("only an explicit restored response releases local tombstones and refreshes roster authorities", () => {
  const helperStart = source.indexOf("const restoreParticipantProjection = useCallback");
  const helperEnd = source.indexOf("const loadSquads = useCallback", helperStart);
  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);

  const helper = source.slice(helperStart, helperEnd);
  expect(helper).toContain("removedChannelMembersRef.current.delete(name)");
  expect(helper).toContain('dispatch({ type: "participant_restored", name })');
  expect(helper).toContain("void loadIdentities()");
  expect(helper).toContain("void loadRoles()");

  const callbackStart = source.indexOf("const removeParticipant = useCallback");
  const callbackEnd = source.indexOf("const pauseAgentReception = useCallback", callbackStart);
  const callback = source.slice(callbackStart, callbackEnd);
  const restoredBranch = callback.indexOf("if (result?.restored === true)");
  const restoreCall = callback.indexOf("restoreParticipantProjection(target)", restoredBranch);
  const removalBranch = callback.indexOf("else if (result?.removal", restoreCall);
  const applyRemoval = callback.indexOf("applyAuthoritativeParticipantRemoval(result.removal)", removalBranch);

  expect(restoredBranch).toBeGreaterThanOrEqual(0);
  expect(restoreCall).toBeGreaterThan(restoredBranch);
  expect(removalBranch).toBeGreaterThan(restoreCall);
  expect(applyRemoval).toBeGreaterThan(removalBranch);
  expect(callback.match(/restoreParticipantProjection\(target\)/g)).toHaveLength(1);
});

test("websocket participant removal uses the same role and roster cleanup path", () => {
  const socketStart = source.indexOf("const sock = new ChannelSocket");
  const socketEnd = source.indexOf("onStatus:", socketStart);
  expect(socketStart).toBeGreaterThanOrEqual(0);
  expect(socketEnd).toBeGreaterThan(socketStart);

  const callback = source.slice(socketStart, socketEnd);
  expect(callback).toContain('if (frame.type === "participant_removed")');
  expect(callback).toContain("applyAuthoritativeParticipantRemoval(frame)");
  expect(callback.indexOf("applyAuthoritativeParticipantRemoval(frame)")).toBeLessThan(callback.indexOf('dispatch({ type: "frame", frame })'));
});

test("account-scoped removal refreshes full authorities so same-owner siblings cannot remain projected", () => {
  const helperStart = source.indexOf("const applyAuthoritativeParticipantRemoval = useCallback");
  const helperEnd = source.indexOf("const restoreParticipantProjection = useCallback", helperStart);
  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);

  const helper = source.slice(helperStart, helperEnd);
  const immediateTarget = helper.indexOf("applyParticipantRemoval(removal)");
  const refreshIdentities = helper.indexOf("void loadIdentities()", immediateTarget);
  const refreshRoles = helper.indexOf("void loadRoles()", refreshIdentities);
  expect(immediateTarget).toBeGreaterThanOrEqual(0);
  expect(refreshIdentities).toBeGreaterThan(immediateTarget);
  expect(refreshRoles).toBeGreaterThan(refreshIdentities);

  // The full REST snapshots replace local projections. If an account
  // tombstone also removed a sibling not named by the frame, its omission
  // from either authority therefore removes the stale Team/@ entry.
  const identitiesStart = source.indexOf("const loadIdentities = useCallback");
  const rolesStart = source.indexOf("const loadRoles = useCallback", identitiesStart);
  const helperBoundary = source.indexOf("const applyAuthoritativeParticipantRemoval = useCallback", rolesStart);
  const identities = source.slice(identitiesStart, rolesStart);
  const roles = source.slice(rolesStart, helperBoundary);
  expect(identities).toContain("setChannelIdentities(");
  expect(identities).toContain("identities.filter(");
  expect(roles).toContain("setChannelRoles(currentRoles)");
});

test("late identity and role responses are invalidated and filtered through one tombstone authority", () => {
  const identitiesStart = source.indexOf("const loadIdentities = useCallback");
  const rolesStart = source.indexOf("const loadRoles = useCallback", identitiesStart);
  const loadEnd = source.indexOf("const loadSquads = useCallback", rolesStart);
  expect(identitiesStart).toBeGreaterThanOrEqual(0);
  expect(rolesStart).toBeGreaterThan(identitiesStart);
  expect(loadEnd).toBeGreaterThan(rolesStart);

  const identities = source.slice(identitiesStart, rolesStart);
  const roles = source.slice(rolesStart, loadEnd);
  expect(identities).toContain("channelIdentitiesRequestRef.current");
  expect(identities).toContain("removedChannelMembersRef.current.has(identity.name)");
  expect(roles).toContain("channelRolesRequestRef.current");
  expect(roles).toContain("removedChannelMembersRef.current.has(role.name)");
});

test("authoritative welcome clears member tombstones before refreshing identities and roles", () => {
  const socketStart = source.indexOf("const sock = new ChannelSocket");
  const socketEnd = source.indexOf("onStatus:", socketStart);
  const callback = source.slice(socketStart, socketEnd);
  const welcome = callback.indexOf('if (frame.type === "welcome")');
  const clear = callback.indexOf("removedChannelMembersRef.current.delete(participant.name)", welcome);
  const refreshIdentities = callback.indexOf("void loadIdentities()", welcome);
  const refreshRoles = callback.indexOf("void loadRoles()", welcome);

  expect(welcome).toBeGreaterThanOrEqual(0);
  expect(clear).toBeGreaterThan(welcome);
  expect(refreshIdentities).toBeGreaterThan(clear);
  expect(refreshRoles).toBeGreaterThan(refreshIdentities);
});

test("authoritative participant roster clears a member tombstone for live same-name rejoin", () => {
  const socketStart = source.indexOf("const sock = new ChannelSocket");
  const socketEnd = source.indexOf("onStatus:", socketStart);
  const callback = source.slice(socketStart, socketEnd);
  const participants = callback.indexOf('if (frame.type === "participants")');
  const clear = callback.indexOf("removedChannelMembersRef.current.delete(participant.name)", participants);
  const restored = callback.indexOf("if (restoredMember)", participants);
  const refreshIdentities = callback.indexOf("void loadIdentities()", restored);
  const refreshRoles = callback.indexOf("void loadRoles()", restored);

  expect(participants).toBeGreaterThanOrEqual(0);
  expect(clear).toBeGreaterThan(participants);
  expect(restored).toBeGreaterThan(clear);
  expect(refreshIdentities).toBeGreaterThan(restored);
  expect(refreshRoles).toBeGreaterThan(refreshIdentities);
});

test("mention and Team projections use current roster authority instead of historical resurrection", () => {
  const mentionStart = source.indexOf("const mentionOptions = useMemo");
  const mentionEnd = source.indexOf("const mentionNames = useMemo", mentionStart);
  const mentionProjection = source.slice(mentionStart, mentionEnd);

  expect(mentionProjection).toContain("removedMemberNames");
  expect(mentionProjection).toContain("authoritativeMemberNames");
  expect(source).toContain("memberNames: authoritativeMemberNames");
});

test("participant removal immediately clears identity, role and open detail projections", () => {
  const start = source.indexOf("const applyParticipantRemoval = useCallback");
  const end = source.indexOf("const loadCharter = useCallback", start);
  const callback = source.slice(start, end);

  expect(callback).toContain("setChannelIdentities");
  expect(callback).toContain("identity.name !== removal.name");
  expect(callback).toContain("setChannelRoles");
  expect(callback).toContain("role.name !== removal.name");
  expect(callback).toContain("current?.name === removal.name ? null : current");
});

test("historical delivery targets cannot reopen removed member details", () => {
  const openStart = source.indexOf("const openTeamMember = useCallback");
  const openEnd = source.indexOf("const openAdminMember = useCallback", openStart);
  expect(openStart).toBeGreaterThanOrEqual(0);
  expect(openEnd).toBeGreaterThan(openStart);

  const callback = source.slice(openStart, openEnd);
  expect(callback).toContain("authoritativeMemberNamesRef.current.has(name)");
  expect(callback.indexOf("authoritativeMemberNamesRef.current.has(name)"))
    .toBeLessThan(callback.indexOf("setMemberDetailRoute"));
  expect(source).toContain("canOpenAgentDetail={canOpenTeamMember}");
});

test("authoritative removal retains only a session-local account and name snapshot for re-add", () => {
  const removalStart = source.indexOf("const applyParticipantRemoval = useCallback");
  const removalEnd = source.indexOf("const loadCharter = useCallback", removalStart);
  const removal = source.slice(removalStart, removalEnd);
  expect(removal).toContain("channelAdminMemberRowsRef.current.get(removal.name)");
  expect(removal).toContain("setRemovedChannelMemberSnapshots");
  expect(removal).toContain("account: member.account!");

  const rosterStart = source.indexOf("const activeChannelAdminMembers = useMemo");
  const rosterEnd = source.indexOf("const selectedTeamMember = useMemo", rosterStart);
  const roster = source.slice(rosterStart, rosterEnd);
  expect(roster).toContain("Object.values(removedChannelMemberSnapshots)");
  expect(roster).toContain("removedMemberNames.has(member.name)");
  expect(roster).toContain("canRestore: canModerate && !state.archived");
});

test("admin re-add sends the removed row account and name before releasing local guards", () => {
  const restoreStart = source.indexOf("const restoreRemovedParticipant = useCallback");
  const restoreEnd = source.indexOf("const removeParticipant = useCallback", restoreStart);
  expect(restoreStart).toBeGreaterThanOrEqual(0);
  expect(restoreEnd).toBeGreaterThan(restoreStart);

  const callback = source.slice(restoreStart, restoreEnd);
  const request = callback.indexOf(
    "addChannelMember(token, slug, member.account, member.name)",
  );
  const success = callback.indexOf(".then(() => {", request);
  const release = callback.indexOf("restoreParticipantProjection(member.name)", success);
  const failure = callback.indexOf(".catch((err: unknown) => {", release);

  expect(request).toBeGreaterThanOrEqual(0);
  expect(success).toBeGreaterThan(request);
  expect(release).toBeGreaterThan(success);
  expect(failure).toBeGreaterThan(release);
  expect(callback.slice(failure)).not.toContain("restoreParticipantProjection(member.name)");
  expect(source).toContain("onRestoreMember={restoreRemovedParticipant}");
  expect(source).toContain("restoringMember={restoringName}");
});

// #1070：名单一行 = 一个人。踢一个人要把他名下全部会话都移除；附属会话失败不能吞掉，
// 否则 UI 在谎报「全部移除」（Codex stop-review 两轮）。
test("bulk kick awaits every extra session and reports leftovers instead of swallowing failures", () => {
  const start = source.indexOf("const removeParticipant = useCallback((name: string, alsoNames");
  const end = source.indexOf("const restoreParticipant", start) >= 0
    ? source.indexOf("const restoreParticipant", start)
    : start + 4000;
  const body = source.slice(start, end);

  expect(start).toBeGreaterThanOrEqual(0);
  // 附属会话逐个 await，并把失败收进 leftovers
  expect(body).toContain('applyRemovalResult(other, await kickParticipant(token, slug, other, "remove"))');
  expect(body).toContain("leftovers.push(other)");
  // 绝不能再出现「静默吞掉」的写法
  expect(body).not.toContain(".catch(() => undefined)");
  // 有残留时必须报出来
  expect(body).toContain("Channel.kick.partial");
  // 确认框要说清楚会一起移除几个会话
  expect(body).toContain("Channel.kick.confirmSessions");
});
