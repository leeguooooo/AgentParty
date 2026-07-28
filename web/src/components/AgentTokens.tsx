import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AuthError,
  type ChannelAgentInfo,
  type ChannelCharter,
  ConflictError,
  ForbiddenError,
  type ProjectAgentInvitableBy,
  type ProjectAgentProfile,
  type ProjectAgentRunner,
  type ProjectAgentWorktreeStrategy,
  createProjectAgentProfile,
  inviteProjectAgent,
  listChannelAgents,
  listProjectAgentProfiles,
  deleteChannelAgent,
  rotateChannelAgent,
  setChannelAgentNickname,
  ValidationError,
} from "../lib/api";
import {
  buildMinimalAgentCommand,
  copyText,
  findSavedAgentToken,
  listSavedAgentTokens,
  removeSavedAgentToken,
  saveAgentToken,
} from "../lib/agentTokenVault";
import { apiOrigin } from "../lib/base";
import { desktopAgentAdapter, type DesktopAgentAdapter, type DesktopAgentRunner } from "../lib/desktopAgent";
import { isDesktopRuntime, pickDirectory as pickDirectoryDefault } from "../lib/desktopRuntime";
import { LocalAgentsOverview } from "./LocalAgentsOverview";
import { buildJoinPack, type JoinPackMode } from "../lib/joinPack";
import { useT } from "../i18n/useT";
import { SectionedDialog, type SectionedDialogSection } from "./SectionedDialog";
import "../i18n/strings/AgentTokens";

interface Props {
  slug: string;
  token: string;
  accountKey: string;
  inviterName: string;
  /** 频道公告快照（与 AgentJoin 同源）；复制接入包时嵌入，null 则省略该段。 */
  charter: ChannelCharter | null;
  onAuthFailed(message: string): void;
  active?: boolean;
  onActiveChange?(open: boolean): void;
  focusAgentName?: string | null;
  // 转为常驻（launchd）注入点——测试用；默认走真实桌面适配器 / 目录选择器 / mac 桌面探测。
  dutyAdapter?: Pick<DesktopAgentAdapter, "dutyAdopt">;
  pickDirectory?: (title?: string) => Promise<string | null>;
  // 常驻是 macOS launchd，仅 mac 桌面可用；测试注入覆盖。
  canMakeResident?: boolean;
}

type CopyTarget = `${string}:token` | `${string}:command`;
type AgentManagerSection = "channel" | "projects" | "local";
type ProfileForm = {
  handle: string;
  runner: ProjectAgentRunner;
  repoUrl: string;
  workdir: string;
  baseBranch: string;
  worktree: ProjectAgentWorktreeStrategy;
  invitableBy: ProjectAgentInvitableBy;
  rules: string;
};

const EMPTY_PROFILE_FORM: ProfileForm = {
  handle: "",
  runner: "codex",
  repoUrl: "",
  workdir: "",
  baseBranch: "main",
  worktree: "branch",
  invitableBy: "owner",
  rules: "",
};

export function AgentTokens({
  slug,
  token,
  accountKey,
  inviterName,
  charter,
  onAuthFailed,
  active,
  onActiveChange,
  focusAgentName = null,
  dutyAdapter = desktopAgentAdapter,
  pickDirectory = pickDirectoryDefault,
  canMakeResident = isDesktopRuntime() && /mac/i.test(globalThis.navigator?.userAgent ?? ""),
}: Props) {
  const t = useT();
  // 转为常驻状态：busy 名 / 已完成集 / 错误。residentBusyRef 是同步锁（state 更新晚于 await，见 makeResident）。
  const [residentBusy, setResidentBusy] = useState<string | null>(null);
  const residentBusyRef = useRef<string | null>(null);
  const [residentDone, setResidentDone] = useState<Set<string>>(() => new Set());
  const [residentError, setResidentError] = useState<string | null>(null);
  // #725：转常驻要能选 codex/claude(默认 codex,与本机 agent 默认一致)。按 agent 名各记一份。
  const [residentRunnerByName, setResidentRunnerByName] = useState<Record<string, DesktopAgentRunner>>({});
  const residentRunnerFor = (name: string): DesktopAgentRunner => residentRunnerByName[name] ?? "codex";
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<AgentManagerSection>("channel");
  const [agents, setAgents] = useState<ChannelAgentInfo[] | null>(null);
  const [profiles, setProfiles] = useState<ProjectAgentProfile[] | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileForm>(EMPTY_PROFILE_FORM);
  const [agentQuery, setAgentQuery] = useState("");
  const [profileQuery, setProfileQuery] = useState("");
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [selectedProfileKey, setSelectedProfileKey] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [editingNickname, setEditingNickname] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [savingNickname, setSavingNickname] = useState<string | null>(null);
  const [busyProfile, setBusyProfile] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [editingRules, setEditingRules] = useState<string | null>(null);
  const [rulesDraft, setRulesDraft] = useState("");
  const [savingRules, setSavingRules] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const agentRefreshSeqRef = useRef(0);
  const profileRefreshSeqRef = useRef(0);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const isOpen = active ?? open;
  const savedTokensByName = useMemo(
    () => new Map(listSavedAgentTokens(accountKey, slug).map((record) => [record.name, record])),
    [accountKey, agents, slug],
  );
  const localOnly = useMemo(() => {
    const serverNames = new Set((agents ?? []).map((agent) => agent.name));
    return [...savedTokensByName.values()].filter((record) => !serverNames.has(record.name));
  }, [agents, savedTokensByName]);

  const filteredAgents = useMemo(() => {
    const query = agentQuery.trim().toLocaleLowerCase();
    if (query === "") return agents ?? [];
    return (agents ?? []).filter((agent) =>
      `${agent.name} ${agent.nickname ?? ""}`.toLocaleLowerCase().includes(query)
    );
  }, [agentQuery, agents]);
  const selectedAgent = filteredAgents.find((agent) => agent.name === selectedAgentName)
    ?? filteredAgents[0]
    ?? null;
  const selectedAgentSaved = selectedAgent === null
    ? null
    : savedTokensByName.get(selectedAgent.name) ?? null;

  const filteredProfiles = useMemo(() => {
    const query = profileQuery.trim().toLocaleLowerCase();
    if (query === "") return profiles ?? [];
    return (profiles ?? []).filter((profile) =>
      [
        profile.handle,
        profile.runner,
        profile.repo_url ?? "",
        profile.workdir ?? "",
        profile.base_branch,
        profile.rules ?? "",
      ].join(" ").toLocaleLowerCase().includes(query)
    );
  }, [profileQuery, profiles]);
  const selectedProfile = filteredProfiles.find(
    (profile) => `${profile.owner_account}/${profile.handle}` === selectedProfileKey,
  ) ?? filteredProfiles[0] ?? null;
  const selectedProfileId = selectedProfile === null
    ? null
    : `${selectedProfile.owner_account}/${selectedProfile.handle}`;

  const refreshAgents = useCallback(async () => {
    const seq = ++agentRefreshSeqRef.current;
    setAgentError(null);
    try {
      const nextAgents = await listChannelAgents(token, slug);
      if (seq !== agentRefreshSeqRef.current) return;
      setAgents(nextAgents);
    } catch (err) {
      if (seq !== agentRefreshSeqRef.current) return;
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setAgentError(t("AgentTokens.errForbidden"));
      else setAgentError(t("AgentTokens.errLoad"));
    }
  }, [onAuthFailed, slug, t, token]);

  const refreshProfiles = useCallback(async () => {
    const seq = ++profileRefreshSeqRef.current;
    setProfileError(null);
    try {
      const nextProfiles = await listProjectAgentProfiles(token);
      if (seq !== profileRefreshSeqRef.current) return;
      setProfiles(nextProfiles);
    } catch (err) {
      if (seq !== profileRefreshSeqRef.current) return;
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setProfileError(t("AgentTokens.errProfileForbidden"));
      else setProfileError(t("AgentTokens.errProfileLoad"));
    }
  }, [onAuthFailed, t, token]);

  const close = useCallback(() => {
    if (active === undefined) setOpen(false);
    onActiveChange?.(false);
  }, [active, onActiveChange]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    if (active === undefined) setOpen(true);
    onActiveChange?.(true);
  }, [active, close, isOpen, onActiveChange]);

  useEffect(() => {
    if (!isOpen) return;
    if (agents === null) void refreshAgents();
    if (profiles === null) void refreshProfiles();
  }, [agents, isOpen, profiles, refreshAgents, refreshProfiles]);

  useEffect(() => {
    if (!isOpen || focusAgentName === null) return;
    setActiveSection("channel");
    setAgentQuery("");
    setSelectedAgentName(focusAgentName);
  }, [focusAgentName, isOpen]);

  useEffect(() => {
    if (isOpen) return;
    setActiveSection("channel");
    setProfileForm(EMPTY_PROFILE_FORM);
    setCreatingProfile(false);
    setEditingRules(null);
    setRulesDraft("");
    setEditingNickname(null);
    setNicknameDraft("");
    setAgentQuery("");
    setProfileQuery("");
    setAgentError(null);
    setProfileError(null);
    setCopied(null);
    setRevealed(new Set());
  }, [isOpen]);

  const toggleReveal = useCallback((key: string) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const tokenField = (key: string, tokenValue: string) => {
    const isRevealed = revealed.has(key);
    return (
      <div className="agenttokens-tokenrow">
        <input
          className="agenttokens-token t-mono"
          type={isRevealed ? "text" : "password"}
          value={tokenValue}
          readOnly
          aria-label={t("AgentTokens.tokenField")}
        />
        <button type="button" className="d-btn agenttokens-reveal" onClick={() => toggleReveal(key)}>
          {isRevealed ? t("AgentTokens.hideToken") : t("AgentTokens.showToken")}
        </button>
      </div>
    );
  };

  // #584：vault 里存的 command 是生成时刻的冻结文本，会带着旧世界观（TMPDIR 配置路径、
  // 旧 MIN_CLI、无 MCP 步骤）继续流通。复制永远现场重建，存量 command 字段只留作兼容不再读。
  // 重建走 buildFullJoinPack——与「＋ 让 agent 加入」同一份 builder，产物逐字节同构，
  // 含 charter 快照与待命/唤醒指引（只发最小包的话，新 agent 报到完就不知道怎么挂 watch/serve）。
  // #612：unattended 记录重建同款无人值守包（serve --runner claude），别把值守机脚本换成交互包。
  function freshCommand(record: { name: string; token: string; mode?: JoinPackMode; runner?: DesktopAgentRunner }): string {
    return buildJoinPack(record.mode ?? "interactive", {
      slug,
      agentName: record.name,
      agentToken: record.token,
      // #530：桌面版 location.origin 是 tauri://localhost，接入包会报错；优先真实后端 apiBase，同源 web 回退 origin。
      server: apiOrigin(),
      inviterName,
      charter,
      // #749：按生成时选的 runner 重建 unattended 脚本；旧记录无此字段 → buildJoinPack 内落 codex 默认。
      runner: record.runner,
      t,
    });
  }

  async function copy(name: string, kind: "token" | "command", text: string) {
    const ok = await copyText(text);
    if (!ok) {
      setAgentError(t("AgentTokens.errCopy"));
      return;
    }
    const key = `${name}:${kind}` as CopyTarget;
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
  }

  // #605：删除自己的 agent——撤 token、断连、清本地 vault 记录。不可逆，二次确认。
  async function removeAgent(name: string) {
    const ok = window.confirm(t("AgentTokens.deleteConfirm", { name }));
    if (!ok) return;
    setBusyName(name);
    setAgentError(null);
    try {
      await deleteChannelAgent(token, slug, name);
      removeSavedAgentToken(accountKey, slug, name);
      await refreshAgents();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ValidationError) {
        // 404 = 服务端早已没有这个 agent（别处已删/已撤销）——本地清理照做，幂等收尾。
        removeSavedAgentToken(accountKey, slug, name);
        await refreshAgents();
      } else setAgentError(t("AgentTokens.errDelete"));
    } finally {
      setBusyName(null);
    }
  }

  // rotate token + 重建接入命令 + 存回 vault 的共享流程（rotate 与转常驻都用）。返回新明文 token。
  // #612：换 token 不换接入方式——沿用旧记录的 mode，让「复制接入包」仍是同款脚本。
  // #530：桌面版 location.origin 是 tauri://localhost，接入包会报错；优先真实后端 apiBase，同源 web 回退 origin。
  async function regenerateAndSaveToken(name: string): Promise<string> {
    const next = await rotateChannelAgent(token, slug, name);
    const command = buildMinimalAgentCommand({
      server: apiOrigin(),
      slug,
      name: next.name,
      token: next.token,
      inviterName,
      checkinMessage: t("AgentTokens.checkinMessage", { name: next.name }),
    });
    saveAgentToken({
      account: accountKey,
      slug,
      name: next.name,
      token: next.token,
      command,
      mode: findSavedAgentToken(accountKey, slug, name)?.mode,
      // #749：轮换 token 也要保留已选 runner,否则已选 claude 的 unattended 记录轮换后复制包会回退 codex。
      runner: findSavedAgentToken(accountKey, slug, name)?.runner,
      savedAt: Date.now(),
    });
    return next.token;
  }

  async function rotate(name: string) {
    const ok = window.confirm(t("AgentTokens.rotateConfirm", { name }));
    if (!ok) return;
    setBusyName(name);
    setAgentError(null);
    try {
      await regenerateAndSaveToken(name);
      await refreshAgents();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setAgentError(t("AgentTokens.errRotateForbidden"));
      else setAgentError(t("AgentTokens.errRotate"));
    } finally {
      setBusyName(null);
    }
  }

  // 拿到该 agent 可用的明文 token：本地 vault 有就用（不动线上）；没有则征得同意后 rotate
  // 生成新 token（旧 token 立即失效——若在别处正跑会掉线），并存回 vault 供复制/后续复用。
  async function tokenForResidency(name: string): Promise<string | null> {
    const saved = findSavedAgentToken(accountKey, slug, name);
    if (saved) return saved.token;
    if (!window.confirm(t("AgentTokens.residentRegenConfirm", { name }))) return null;
    return regenerateAndSaveToken(name);
  }

  // 把某个 agent 身份转成本机 launchd 常驻：先选工作目录（必选，不手填），再 dutyAdopt 落地。
  // #721 评审：用 ref 同步上锁——residentBusy 是 state，要等 await pickDirectory 后才生效，
  // 连点会绕过 state 守卫并发触发 rotate/dutyAdopt（第二次 rotate 作废第一次的 token）。
  async function makeResident(name: string) {
    if (!canMakeResident || residentBusyRef.current !== null) return;
    residentBusyRef.current = name;
    setResidentBusy(name);
    setResidentError(null);
    try {
      const dir = await pickDirectory(t("AgentTokens.residentPickTitle", { name }));
      if (dir === null) return; // 取消选目录 = 放弃整个操作
      const agentToken = await tokenForResidency(name);
      if (agentToken === null) return; // 未同意重新生成
      await dutyAdapter.dutyAdopt({
        server: apiOrigin(),
        token: agentToken,
        name,
        channel: slug,
        runner: residentRunnerFor(name),
        workdir: dir,
      });
      setResidentDone((s) => new Set(s).add(name));
      await refreshAgents();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else setResidentError(err instanceof Error ? err.message : String(err));
    } finally {
      residentBusyRef.current = null;
      setResidentBusy(null);
    }
  }

  function startEditNickname(agent: ChannelAgentInfo) {
    setEditingNickname(agent.name);
    setNicknameDraft(agent.nickname ?? "");
    setAgentError(null);
  }

  function cancelEditNickname() {
    setEditingNickname(null);
    setNicknameDraft("");
  }

  async function saveNickname(agent: ChannelAgentInfo) {
    const nickname = nicknameDraft.trim();
    if (nickname === "") {
      setAgentError(t("AgentTokens.errNicknameInvalid"));
      return;
    }
    setSavingNickname(agent.name);
    setAgentError(null);
    try {
      const saved = await setChannelAgentNickname(token, slug, agent.name, nickname);
      setAgents((current) => current?.map((entry) => entry.name === agent.name ? { ...entry, nickname: saved.nickname } : entry) ?? null);
      cancelEditNickname();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setAgentError(t("AgentTokens.errNicknameForbidden"));
      else if (err instanceof ConflictError) setAgentError(t("AgentTokens.errNicknameConflict"));
      else if (err instanceof ValidationError) setAgentError(t("AgentTokens.errNicknameInvalid"));
      else setAgentError(t("AgentTokens.errNicknameSave"));
    } finally {
      setSavingNickname(null);
    }
  }

  async function createProfile() {
    const handle = profileForm.handle.trim();
    if (handle === "") {
      setProfileError(t("AgentTokens.errProfileInvalid"));
      return;
    }
    setSavingProfile(true);
    setProfileError(null);
    try {
      const created = await createProjectAgentProfile(token, {
        handle,
        runner: profileForm.runner,
        ...(profileForm.repoUrl.trim() === "" ? {} : { repo_url: profileForm.repoUrl.trim() }),
        ...(profileForm.workdir.trim() === "" ? {} : { workdir: profileForm.workdir.trim() }),
        ...(profileForm.baseBranch.trim() === "" ? {} : { base_branch: profileForm.baseBranch.trim() }),
        worktree_strategy: profileForm.worktree,
        invitable_by: profileForm.invitableBy,
        ...(profileForm.rules.trim() === "" ? {} : { rules: profileForm.rules.trim() }),
      });
      setProfileForm((current) => ({ ...current, handle: "", repoUrl: "", workdir: "", rules: "" }));
      setSelectedProfileKey(`${created.owner_account}/${created.handle}`);
      setCreatingProfile(false);
      await refreshProfiles();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setProfileError(t("AgentTokens.errProfileForbidden"));
      else if (err instanceof ValidationError) setProfileError(t("AgentTokens.errProfileInvalid"));
      else setProfileError(t("AgentTokens.errProfileSave"));
    } finally {
      setSavingProfile(false);
    }
  }

  function startEditRules(profile: ProjectAgentProfile) {
    setEditingRules(`${profile.owner_account}/${profile.handle}`);
    setRulesDraft(profile.rules ?? "");
    setProfileError(null);
  }

  function cancelEditRules() {
    setEditingRules(null);
    setRulesDraft("");
  }

  // 编辑已有 profile 的规则：worker 没有独立的 PATCH，POST /api/agent-profiles 走 ON CONFLICT
  // DO UPDATE 做 upsert，缺省字段会被写成 null——所以这里必须把整份 profile 的字段带回去，
  // 只替换 rules，否则重存会把 repo/workdir 等抹掉。
  async function saveProfileRules(profile: ProjectAgentProfile) {
    const key = `${profile.owner_account}/${profile.handle}`;
    setSavingRules(key);
    setProfileError(null);
    try {
      await createProjectAgentProfile(token, {
        handle: profile.handle,
        runner: profile.runner,
        ...(profile.repo_url === null ? {} : { repo_url: profile.repo_url }),
        ...(profile.workdir === null ? {} : { workdir: profile.workdir }),
        base_branch: profile.base_branch,
        worktree_strategy: profile.worktree_strategy,
        invitable_by: profile.invitable_by,
        rules: rulesDraft.trim(),
      });
      setEditingRules(null);
      setRulesDraft("");
      await refreshProfiles();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setProfileError(t("AgentTokens.errProfileForbidden"));
      else if (err instanceof ValidationError) setProfileError(t("AgentTokens.errProfileInvalid"));
      else setProfileError(t("AgentTokens.errProfileSave"));
    } finally {
      setSavingRules(null);
    }
  }

  async function inviteProfile(profile: ProjectAgentProfile) {
    const key = `${profile.owner_account}/${profile.handle}`;
    setBusyProfile(key);
    setProfileError(null);
    try {
      await inviteProjectAgent(token, slug, profile);
      await refreshProfiles();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setProfileError(t("AgentTokens.errInviteForbidden"));
      else setProfileError(t("AgentTokens.errInvite"));
    } finally {
      setBusyProfile(null);
    }
  }

  const plaintextCount = (agents ?? []).filter((agent) => savedTokensByName.has(agent.name)).length;
  const worktreeLabel = (strategy: ProjectAgentWorktreeStrategy) => {
    if (strategy === "shared") return t("AgentTokens.worktreeShared");
    if (strategy === "none") return t("AgentTokens.worktreeNone");
    return t("AgentTokens.worktreeBranch");
  };
  const invitableLabel = (value: ProjectAgentInvitableBy) => {
    if (value === "org") return t("AgentTokens.invitableOrg");
    if (value === "anyone") return t("AgentTokens.invitableAnyone");
    return t("AgentTokens.invitableOwner");
  };

  const channelSection = (
    <>
      <header className="agentmanager-module-head">
        <div>
          <h3 className="settings-module-title">{t("AgentTokens.channelTitle")}</h3>
          <p className="agentmanager-module-hint">{t("AgentTokens.channelHint", { slug })}</p>
        </div>
        <button type="button" className="d-btn" onClick={() => void refreshAgents()}>
          {t("AgentTokens.refresh")}
        </button>
      </header>

      <div className="agentmanager-summary" aria-label={t("AgentTokens.channelSummary")}>
        <div>
          <strong>{agents?.length ?? "—"}</strong>
          <span>{t("AgentTokens.identityCount")}</span>
        </div>
        <div>
          <strong>{agents === null ? "—" : plaintextCount}</strong>
          <span>{t("AgentTokens.plaintextCount")}</span>
        </div>
        <div>
          <strong>{agents === null ? "—" : localOnly.length}</strong>
          <span>{t("AgentTokens.staleCount")}</span>
        </div>
      </div>

      {agentError !== null && <p className="agenttokens-error" role="alert">{agentError}</p>}
      {residentError !== null && <p className="agenttokens-error" role="alert">{residentError}</p>}

      <label className="agentmanager-search">
        <span className="agentmanager-sr-only">{t("AgentTokens.searchAgents")}</span>
        <input
          className="agenttokens-input"
          type="search"
          value={agentQuery}
          onChange={(event) => setAgentQuery(event.target.value)}
          placeholder={t("AgentTokens.searchAgents")}
        />
      </label>

      {agents === null && agentError === null ? (
        <p className="agenttokens-empty">{t("AgentTokens.loading")}</p>
      ) : (
        <div className="agentmanager-workspace">
          <div className="agentmanager-list" aria-label={t("AgentTokens.channelList")}>
            {filteredAgents.map((agent) => {
              const saved = savedTokensByName.get(agent.name);
              const selected = selectedAgent?.name === agent.name;
              return (
                <button
                  key={agent.name}
                  type="button"
                  className={`agentmanager-list-item${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedAgentName(agent.name);
                    cancelEditNickname();
                    setAgentError(null);
                  }}
                >
                  <span className="agentmanager-list-name">
                    {agent.nickname ?? agent.name}
                    {agent.nickname && <small>{agent.name}</small>}
                  </span>
                  <span className={`agentmanager-status${saved ? " is-ready" : " is-warning"}`}>
                    {saved ? t("AgentTokens.plaintextReady") : t("AgentTokens.plaintextMissing")}
                  </span>
                </button>
              );
            })}
            {agents !== null && filteredAgents.length === 0 && (
              <p className="agentmanager-list-empty">
                {agentQuery.trim() === "" ? t("AgentTokens.empty") : t("AgentTokens.noAgentMatches")}
              </p>
            )}

            {localOnly.length > 0 && (
              <details className="agentmanager-local-only">
                <summary>
                  {t("AgentTokens.localOnlyTitle")} · {localOnly.length}
                </summary>
                <div className="agentmanager-local-only-list">
                  {localOnly.map((record) => (
                    <div key={record.name} className="agentmanager-local-only-item">
                      <strong>{record.name}</strong>
                      <span>{t("AgentTokens.localOnlyMeta")}</span>
                      {tokenField(`local:${record.name}`, record.token)}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          <section className="agentmanager-detail" aria-live="polite">
            {selectedAgent === null ? (
              <div className="agentmanager-empty-state">
                <strong>{t("AgentTokens.noAgentSelected")}</strong>
                <p>{t("AgentTokens.noAgentSelectedHint")}</p>
              </div>
            ) : (
              <>
                <header className="agentmanager-detail-head">
                  <div>
                    <span className="agentmanager-eyebrow">{t("AgentTokens.channelIdentity")}</span>
                    <h4>{selectedAgent.nickname ?? selectedAgent.name}</h4>
                    {selectedAgent.nickname && <p className="t-mono">{selectedAgent.name}</p>}
                  </div>
                  <span className={`agentmanager-status${selectedAgentSaved ? " is-ready" : " is-warning"}`}>
                    {selectedAgentSaved ? t("AgentTokens.plaintextReady") : t("AgentTokens.plaintextMissing")}
                  </span>
                </header>

                {selectedAgentSaved ? (
                  <section className="agentmanager-detail-section">
                    <div className="agentmanager-section-head">
                      <strong>{t("AgentTokens.credentialTitle")}</strong>
                      <span>{t("AgentTokens.hasPlaintext")}</span>
                    </div>
                    {tokenField(`server:${selectedAgent.name}`, selectedAgentSaved.token)}
                    <div className="agenttokens-actions">
                      <button
                        type="button"
                        className="d-btn d-btn--primary"
                        onClick={() => copy(selectedAgent.name, "command", freshCommand(selectedAgentSaved))}
                      >
                        {copied === `${selectedAgent.name}:command`
                          ? t("AgentTokens.copied")
                          : t("AgentTokens.copyPack")}
                      </button>
                      <button
                        type="button"
                        className="d-btn"
                        onClick={() => copy(selectedAgent.name, "token", selectedAgentSaved.token)}
                      >
                        {copied === `${selectedAgent.name}:token`
                          ? t("AgentTokens.copied")
                          : t("AgentTokens.copyToken")}
                      </button>
                    </div>
                  </section>
                ) : (
                  <section className="agentmanager-detail-section agentmanager-callout">
                    <strong>{t("AgentTokens.noPlaintextTitle")}</strong>
                    <p>{t("AgentTokens.noPlaintextHint")}</p>
                    <button
                      type="button"
                      className="d-btn d-btn--primary"
                      disabled={busyName === selectedAgent.name}
                      onClick={() => void rotate(selectedAgent.name)}
                    >
                      {busyName === selectedAgent.name ? t("AgentTokens.rotating") : t("AgentTokens.rotateAndRecover")}
                    </button>
                  </section>
                )}

                <section className="agentmanager-detail-section">
                  <div className="agentmanager-section-head">
                    <strong>{t("AgentTokens.identityTitle")}</strong>
                    {editingNickname !== selectedAgent.name && (
                      <button
                        type="button"
                        className="agentmanager-text-action agenttokens-edit-nickname"
                        onClick={() => startEditNickname(selectedAgent)}
                      >
                        {selectedAgent.nickname ? t("AgentTokens.changeNickname") : t("AgentTokens.setNickname")}
                      </button>
                    )}
                  </div>
                  <dl className="agentmanager-facts">
                    <div><dt>{t("AgentTokens.handleLabel")}</dt><dd>{selectedAgent.name}</dd></div>
                    <div>
                      <dt>{t("AgentTokens.nicknameLabel")}</dt>
                      <dd>{selectedAgent.nickname ?? t("AgentTokens.nicknameUnset")}</dd>
                    </div>
                  </dl>
                  {editingNickname === selectedAgent.name && (
                    <div className="agenttokens-nickname-edit">
                      <input
                        className="agenttokens-input agenttokens-nickname-input"
                        value={nicknameDraft}
                        maxLength={64}
                        autoFocus
                        onChange={(event) => setNicknameDraft(event.target.value)}
                        placeholder={t("AgentTokens.nicknamePlaceholder")}
                        aria-label={t("AgentTokens.nicknameLabel")}
                      />
                      <button
                        type="button"
                        className="d-btn d-btn--primary agenttokens-save-nickname"
                        disabled={savingNickname === selectedAgent.name}
                        onClick={() => void saveNickname(selectedAgent)}
                      >
                        {savingNickname === selectedAgent.name
                          ? t("AgentTokens.savingNickname")
                          : t("AgentTokens.saveNickname")}
                      </button>
                      <button
                        type="button"
                        className="d-btn agenttokens-cancel-nickname"
                        disabled={savingNickname === selectedAgent.name}
                        onClick={cancelEditNickname}
                      >
                        {t("AgentTokens.cancelNickname")}
                      </button>
                    </div>
                  )}
                </section>

                {canMakeResident && (
                  <section className="agentmanager-detail-section">
                    <div className="agentmanager-section-head">
                      <strong>{t("AgentTokens.runtimeTitle")}</strong>
                      <span>{t("AgentTokens.runtimeHint")}</span>
                    </div>
                    <div className="agenttokens-actions">
                      <select
                        className="d-input agenttokens-resident-runner"
                        aria-label={t("AgentTokens.residentRunnerLabel", { name: selectedAgent.name })}
                        value={residentRunnerFor(selectedAgent.name)}
                        disabled={residentBusy !== null}
                        onChange={(event) =>
                          setResidentRunnerByName((current) => ({
                            ...current,
                            [selectedAgent.name]: event.target.value as DesktopAgentRunner,
                          }))
                        }
                      >
                        <option value="codex">codex</option>
                        <option value="claude">claude</option>
                      </select>
                      <button
                        type="button"
                        className="d-btn agenttokens-resident"
                        disabled={residentBusy !== null}
                        onClick={() => void makeResident(selectedAgent.name)}
                      >
                        {residentBusy === selectedAgent.name
                          ? t("AgentTokens.residentBusy")
                          : residentDone.has(selectedAgent.name)
                            ? t("AgentTokens.residentDone")
                            : t("AgentTokens.resident")}
                      </button>
                    </div>
                  </section>
                )}

                <section className="agentmanager-detail-section agentmanager-danger">
                  <div className="agentmanager-section-head">
                    <strong>{t("AgentTokens.dangerTitle")}</strong>
                    <span>{t("AgentTokens.dangerHint")}</span>
                  </div>
                  <div className="agenttokens-actions">
                    {selectedAgentSaved && (
                      <button
                        type="button"
                        className="d-btn agenttokens-rotate"
                        disabled={busyName === selectedAgent.name}
                        onClick={() => void rotate(selectedAgent.name)}
                      >
                        {busyName === selectedAgent.name ? t("AgentTokens.rotating") : t("AgentTokens.rotate")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="d-btn agenttokens-delete"
                      disabled={busyName === selectedAgent.name}
                      onClick={() => void removeAgent(selectedAgent.name)}
                    >
                      {t("AgentTokens.delete")}
                    </button>
                  </div>
                </section>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );

  const profileFormContent = (
    <form
      className="agentmanager-profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        void createProfile();
      }}
    >
      <div className="agentmanager-form-intro">
        <span className="agentmanager-eyebrow">{t("AgentTokens.newProfileEyebrow")}</span>
        <h4>{t("AgentTokens.newProfileTitle")}</h4>
        <p>{t("AgentTokens.newProfileHint")}</p>
      </div>
      <label>
        <span>{t("AgentTokens.profileHandle")}</span>
        <input
          className="agenttokens-input t-mono"
          value={profileForm.handle}
          required
          aria-label={t("AgentTokens.profileHandle")}
          onChange={(event) => setProfileForm((current) => ({ ...current, handle: event.target.value }))}
        />
      </label>
      <label>
        <span>{t("AgentTokens.profileRunner")}</span>
        <select
          className="agenttokens-input"
          value={profileForm.runner}
          onChange={(event) => setProfileForm((current) => ({
            ...current,
            runner: event.target.value as ProjectAgentRunner,
          }))}
        >
          <option value="codex">codex</option>
          <option value="claude">claude</option>
          <option value="codex-sdk">codex-sdk</option>
          <option value="shell">shell</option>
        </select>
      </label>
      <label className="agentmanager-field-wide">
        <span>{t("AgentTokens.profileRepo")}</span>
        <input
          className="agenttokens-input"
          value={profileForm.repoUrl}
          onChange={(event) => setProfileForm((current) => ({ ...current, repoUrl: event.target.value }))}
          placeholder="https://github.com/owner/repo"
        />
      </label>
      <label className="agentmanager-field-wide">
        <span>{t("AgentTokens.profileWorkdir")}</span>
        <input
          className="agenttokens-input t-mono"
          value={profileForm.workdir}
          aria-label={t("AgentTokens.profileWorkdir")}
          onChange={(event) => setProfileForm((current) => ({ ...current, workdir: event.target.value }))}
          placeholder="/path/to/project"
        />
      </label>
      <label>
        <span>{t("AgentTokens.profileBase")}</span>
        <input
          className="agenttokens-input t-mono"
          value={profileForm.baseBranch}
          aria-label={t("AgentTokens.profileBase")}
          onChange={(event) => setProfileForm((current) => ({ ...current, baseBranch: event.target.value }))}
        />
      </label>
      <label>
        <span>{t("AgentTokens.profileWorktree")}</span>
        <select
          className="agenttokens-input"
          value={profileForm.worktree}
          onChange={(event) => setProfileForm((current) => ({
            ...current,
            worktree: event.target.value as ProjectAgentWorktreeStrategy,
          }))}
        >
          <option value="branch">{t("AgentTokens.worktreeBranch")}</option>
          <option value="shared">{t("AgentTokens.worktreeShared")}</option>
          <option value="none">{t("AgentTokens.worktreeNone")}</option>
        </select>
      </label>
      <label className="agentmanager-field-wide">
        <span>{t("AgentTokens.profileInvitableBy")}</span>
        <select
          className="agenttokens-input"
          value={profileForm.invitableBy}
          onChange={(event) => setProfileForm((current) => ({
            ...current,
            invitableBy: event.target.value as ProjectAgentInvitableBy,
          }))}
        >
          <option value="owner">{t("AgentTokens.invitableOwner")}</option>
          <option value="org">{t("AgentTokens.invitableOrg")}</option>
          <option value="anyone">{t("AgentTokens.invitableAnyone")}</option>
        </select>
      </label>
      <label className="agentmanager-field-wide">
        <span>{t("AgentTokens.profileRules")}</span>
        <textarea
          className="agenttokens-input agentmanager-rules-input"
          value={profileForm.rules}
          onChange={(event) => setProfileForm((current) => ({ ...current, rules: event.target.value }))}
          placeholder={t("AgentTokens.profileRulesHint")}
        />
      </label>
      <div className="agentmanager-form-actions">
        {profiles !== null && profiles.length > 0 && (
          <button type="button" className="d-btn" disabled={savingProfile} onClick={() => setCreatingProfile(false)}>
            {t("AgentTokens.cancelRules")}
          </button>
        )}
        <button type="submit" className="d-btn d-btn--primary" disabled={savingProfile}>
          {savingProfile ? t("AgentTokens.creatingProfile") : t("AgentTokens.createProfile")}
        </button>
      </div>
    </form>
  );

  const projectsSection = (
    <>
      <header className="agentmanager-module-head">
        <div>
          <h3 className="settings-module-title">{t("AgentTokens.projectTitle")}</h3>
          <p className="agentmanager-module-hint">{t("AgentTokens.projectHint")}</p>
        </div>
        <div className="agenttokens-actions">
          <button type="button" className="d-btn" onClick={() => void refreshProfiles()}>
            {t("AgentTokens.refresh")}
          </button>
          {!creatingProfile && profiles !== null && profiles.length > 0 && (
            <button
              type="button"
              className="d-btn d-btn--primary"
              onClick={() => {
                setCreatingProfile(true);
                setProfileError(null);
              }}
            >
              {t("AgentTokens.newProfile")}
            </button>
          )}
        </div>
      </header>

      {profileError !== null && <p className="agenttokens-error" role="alert">{profileError}</p>}

      <label className="agentmanager-search">
        <span className="agentmanager-sr-only">{t("AgentTokens.searchProfiles")}</span>
        <input
          className="agenttokens-input"
          type="search"
          value={profileQuery}
          onChange={(event) => setProfileQuery(event.target.value)}
          placeholder={t("AgentTokens.searchProfiles")}
        />
      </label>

      {profiles === null && profileError === null ? (
        <p className="agenttokens-empty">{t("AgentTokens.loading")}</p>
      ) : (
        <div className="agentmanager-workspace agentmanager-workspace--profiles">
          <div className="agentmanager-list" aria-label={t("AgentTokens.projectList")}>
            {filteredProfiles.map((profile) => {
              const key = `${profile.owner_account}/${profile.handle}`;
              const selected = !creatingProfile && selectedProfileId === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`agentmanager-list-item${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedProfileKey(key);
                    setCreatingProfile(false);
                    cancelEditRules();
                    setProfileError(null);
                  }}
                >
                  <span className="agentmanager-list-name">{profile.handle}</span>
                  <span className="agentmanager-profile-meta">
                    {profile.runner} · {profile.base_branch}
                  </span>
                </button>
              );
            })}
            {profiles !== null && filteredProfiles.length === 0 && (
              <div className="agentmanager-list-empty">
                <p>
                  {profileQuery.trim() === ""
                    ? t("AgentTokens.noProfiles")
                    : t("AgentTokens.noProfileMatches")}
                </p>
              </div>
            )}
          </div>

          <section className="agentmanager-detail">
            {creatingProfile || (profiles !== null && profiles.length === 0)
              ? profileFormContent
              : selectedProfile === null
                ? (
                    <div className="agentmanager-empty-state">
                      <strong>{t("AgentTokens.noProfileSelected")}</strong>
                      <p>{t("AgentTokens.noProfileSelectedHint")}</p>
                    </div>
                  )
                : (
                    <>
                      <header className="agentmanager-detail-head">
                        <div>
                          <span className="agentmanager-eyebrow">{t("AgentTokens.projectProfile")}</span>
                          <h4>{selectedProfile.handle}</h4>
                          <p>{selectedProfile.owner_account}</p>
                        </div>
                        <span className="agentmanager-runner-chip">{selectedProfile.runner}</span>
                      </header>

                      <section className="agentmanager-detail-section">
                        <strong>{t("AgentTokens.profileConfiguration")}</strong>
                        <dl className="agentmanager-facts">
                          <div><dt>{t("AgentTokens.profileRepo")}</dt><dd>{selectedProfile.repo_url ?? "—"}</dd></div>
                          <div><dt>{t("AgentTokens.profileWorkdir")}</dt><dd>{selectedProfile.workdir ?? "—"}</dd></div>
                          <div><dt>{t("AgentTokens.profileBase")}</dt><dd>{selectedProfile.base_branch}</dd></div>
                          <div>
                            <dt>{t("AgentTokens.profileWorktree")}</dt>
                            <dd>{worktreeLabel(selectedProfile.worktree_strategy)}</dd>
                          </div>
                          <div>
                            <dt>{t("AgentTokens.profileInvitableBy")}</dt>
                            <dd>{invitableLabel(selectedProfile.invitable_by)}</dd>
                          </div>
                        </dl>
                      </section>

                      <section className="agentmanager-detail-section">
                        <div className="agentmanager-section-head">
                          <strong>{t("AgentTokens.profileRules")}</strong>
                          {editingRules !== selectedProfileId && (
                            <button
                              type="button"
                              className="agentmanager-text-action agenttokens-edit-rules"
                              onClick={() => startEditRules(selectedProfile)}
                            >
                              {t("AgentTokens.editRules")}
                            </button>
                          )}
                        </div>
                        {editingRules === selectedProfileId ? (
                          <div className="agenttokens-rules-edit-wrap">
                            <textarea
                              className="agenttokens-input agenttokens-rules-edit"
                              value={rulesDraft}
                              onChange={(event) => setRulesDraft(event.target.value)}
                              placeholder={t("AgentTokens.profileRules")}
                              aria-label={t("AgentTokens.rulesLabel")}
                            />
                            <div className="agenttokens-actions">
                              <button
                                type="button"
                                className="d-btn d-btn--primary agenttokens-save-rules"
                                disabled={savingRules === selectedProfileId}
                                onClick={() => void saveProfileRules(selectedProfile)}
                              >
                                {savingRules === selectedProfileId
                                  ? t("AgentTokens.savingRules")
                                  : t("AgentTokens.saveRules")}
                              </button>
                              <button
                                type="button"
                                className="d-btn agenttokens-cancel-rules"
                                disabled={savingRules === selectedProfileId}
                                onClick={cancelEditRules}
                              >
                                {t("AgentTokens.cancelRules")}
                              </button>
                            </div>
                          </div>
                        ) : selectedProfile.rules !== null && selectedProfile.rules !== "" ? (
                          <pre className="agenttokens-rules" aria-label={t("AgentTokens.rulesLabel")}>
                            {selectedProfile.rules}
                          </pre>
                        ) : (
                          <span className="agenttokens-rules-empty">{t("AgentTokens.noRules")}</span>
                        )}
                      </section>

                      <section className="agentmanager-detail-section agentmanager-callout">
                        <strong>{t("AgentTokens.inviteTitle")}</strong>
                        <p>{t("AgentTokens.inviteHint", { slug })}</p>
                        <button
                          type="button"
                          className="d-btn d-btn--primary"
                          disabled={busyProfile === selectedProfileId}
                          onClick={() => void inviteProfile(selectedProfile)}
                        >
                          {busyProfile === selectedProfileId
                            ? t("AgentTokens.invitingProfile")
                            : t("AgentTokens.inviteProfile")}
                        </button>
                      </section>
                    </>
                  )}
          </section>
        </div>
      )}
    </>
  );

  const sections: SectionedDialogSection<AgentManagerSection>[] = [
    { id: "channel", label: t("AgentTokens.sectionChannel"), content: channelSection },
    { id: "projects", label: t("AgentTokens.sectionProjects"), content: projectsSection },
  ];
  if (isDesktopRuntime()) {
    sections.push({
      id: "local",
      label: t("AgentTokens.sectionLocal"),
      content: (
        <>
          <header className="agentmanager-module-head">
            <div>
              <h3 className="settings-module-title">{t("AgentTokens.localRuntimeTitle")}</h3>
              <p className="agentmanager-module-hint">{t("AgentTokens.localRuntimeHint", { slug })}</p>
            </div>
          </header>
          <LocalAgentsOverview
            t={t}
            scopeChannel={slug}
            active={isOpen && activeSection === "local"}
          />
        </>
      ),
    });
  }

  return (
    <div className="agenttokens">
      <button type="button" className="d-btn agenttokens-btn" onClick={toggle} aria-expanded={isOpen}>
        {t("AgentTokens.open")}
      </button>
      {isOpen && (
        <SectionedDialog<AgentManagerSection>
          idPrefix="agent-manager"
          title={t("AgentTokens.managerTitle")}
          closeLabel={t("AgentTokens.close")}
          navigationLabel={t("AgentTokens.navigation")}
          sections={sections}
          initialSection="channel"
          onClose={close}
          onActiveSectionChange={setActiveSection}
          panelClassName="settings-panel--agent-center agentmanager-dialog"
        />
      )}
    </div>
  );
}
