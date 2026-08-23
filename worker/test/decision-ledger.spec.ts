// #929：`party decision ask → owner 点批准 → 写入 active_decisions` 这条链。
//
// 两类用例缺一不可：
//  1. 正向——批准之后账本里**真的**多了一行（断言的是 GET /charter 读出来的 DB 行，不是接口回显）；
//  2. 反向——一条 topic 伪装成 `authz:` 的请求被批准后，账本里同样多了一行（证明写入路径确实
//     跑到了，不是因为别的分支把闸整个遮住），但那一行落在 `ask:` 命名空间里，`checkAuthz`
//     依旧判未授权。
//
// 反向用例刻意复用 CLI 的真实核验函数 checkAuthz（cli/src/authz.ts），而不是在这里另写一份
// 「topic 不以 authz: 开头」的近似判定——签发端与核验端必须钉在同一份语义上。
import { AUTHZ_TOPIC_PREFIX, DECISION_ASK_TOPIC_PREFIX, type ChannelDecisionRecord } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { checkAuthz } from "../../cli/src/authz";
import { decisionAskLedgerSummary, decisionAskLedgerTopic } from "../src/decision-ledger";
import { api, createChannel, seedToken, uniq } from "./helpers";

interface DecisionLedgerEcho {
  recorded: boolean;
  decision?: ChannelDecisionRecord;
  reason?: string;
}

interface RespondBody {
  message: { seq: number; decision_resolution?: { state: string; chosen_option?: string } };
  reply: { seq: number };
  decision_ledger?: DecisionLedgerEcho;
}

async function fixture() {
  const account = `${uniq("acct")}@leeguoo.com`;
  // 频道创建者 = moderator + 频道 owner，即唯一有资格往账本里写的身份。
  const owner = await seedToken("agent", uniq("owner"), { owner: account });
  const slug = await createChannel(owner.token);
  const asker = await seedToken("agent", uniq("asker"), { owner: account, channelScope: slug });
  const bystander = await seedToken("human", uniq("human"), {
    owner: `${uniq("outsider")}@example.com`,
    channelScope: slug,
  });
  return { slug, owner, asker, bystander };
}

async function ask(
  slug: string,
  token: string,
  prompt: string,
  options?: string[],
): Promise<number> {
  const res = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "message",
      body: prompt,
      mentions: [],
      reply_to: null,
      decision_request: {
        prompt,
        ...(options === undefined ? {} : { kind: "choice", options }),
      },
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { seq: number }).seq;
}

async function respond(
  slug: string,
  token: string,
  seq: number,
  body: Record<string, unknown>,
): Promise<RespondBody> {
  const res = await api(`/api/channels/${slug}/messages/${seq}/decision`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RespondBody;
}

async function activeDecisions(slug: string, token: string): Promise<ChannelDecisionRecord[]> {
  const res = await api(`/api/channels/${slug}/charter`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { active_decisions: ChannelDecisionRecord[] }).active_decisions;
}

describe("decision ask → owner approval → decision ledger (#929)", () => {
  it("writes an active_decisions row when the owner approves, readable through the charter snapshot", async () => {
    const { slug, owner, asker } = await fixture();
    const seq = await ask(slug, asker.token, "ship the migration tonight?");

    const answered = await respond(slug, owner.token, seq, { action: "approve", reason: "rollback plan reviewed" });
    expect(answered.message.decision_resolution?.state).toBe("resolved");

    // 权威断言：账本（D1）里真的多了一行，而不是接口回显里多了一个字段。
    const decisions = await activeDecisions(slug, owner.token);
    const recorded = decisions.find((d) => d.source_seq === seq);
    expect(recorded).toBeDefined();
    // 字面量而不是 decisionAskLedgerTopic(...) 的自证：这里钉的是行为，不是实现。
    expect(recorded!.topic).toBe("ask:ship the migration tonight?");
    expect(recorded!.status).toBe("active");
    expect(recorded!.created_by).toBe(owner.name);
    expect(recorded!.summary).toContain("approved");
    expect(recorded!.summary).toContain("rollback plan reviewed");
  });

  it("records a rejection as its own ledger row, so 'owner approved' can be contradicted by a query", async () => {
    const { slug, owner, asker } = await fixture();
    const seq = await ask(slug, asker.token, "wire real funds to the vendor?");
    await respond(slug, owner.token, seq, { action: "reject", reason: "no invoice" });

    const decisions = await activeDecisions(slug, owner.token);
    const recorded = decisions.find((d) => d.source_seq === seq);
    expect(recorded).toBeDefined();
    expect(recorded!.summary).toContain("rejected");
    expect(recorded!.summary).not.toContain("approved");
  });

  it("records the chosen option for a choice decision", async () => {
    const { slug, owner, asker } = await fixture();
    const seq = await ask(slug, asker.token, "which region?", ["us-east", "eu-west"]);
    await respond(slug, owner.token, seq, { option: "eu-west" });

    const decisions = await activeDecisions(slug, owner.token);
    const recorded = decisions.find((d) => d.source_seq === seq);
    expect(recorded).toBeDefined();
    expect(recorded!.summary).toContain("eu-west");
  });

  // ⚠️ 这是本切片最重要的一条：批准绝不能变成授权凭据。
  //
  // fixture 刻意做到「只有命名空间前缀这一道闸能决定结果」：每个变体都先断言**账本里确实
  // 多了一行**（写入路径跑到了、ACL 过了、决策也 resolved 了），再断言那一行进不了 authz
  // 命名空间。去掉 decisionAskLedgerTopic 里的前缀拼接，第二组断言必然转红。
  it.each([
    "authz:spend diamonds",
    "AUTHZ:spend diamonds",
    "  authz: spend diamonds  ",
    "AuThZ:spend diamonds",
  ])("an approved decision whose prompt impersonates the authz namespace grants nothing (%j)", async (prompt) => {
    const { slug, owner, asker } = await fixture();
    const seq = await ask(slug, asker.token, prompt);
    const answered = await respond(slug, owner.token, seq, { action: "approve" });
    expect(answered.decision_ledger?.recorded).toBe(true);

    const decisions = await activeDecisions(slug, owner.token);
    const recorded = decisions.find((d) => d.source_seq === seq);
    // 前置条件：写入确实发生了。少了这条，守卫被删掉后本用例会因为「压根没写」而假绿。
    expect(recorded).toBeDefined();
    expect(recorded!.status).toBe("active");

    expect(recorded!.topic.startsWith(DECISION_ASK_TOPIC_PREFIX)).toBe(true);
    expect(recorded!.topic.trim().toLowerCase().startsWith(AUTHZ_TOPIC_PREFIX)).toBe(false);

    // 核验端（`party authz check`）的真实判定：仍然未授权。
    const verdict = checkAuthz({ channel: slug, action: "spend diamonds", decisions });
    expect(verdict.authorized).toBe(false);
    expect(verdict.credential).toBeNull();
    expect(verdict.active_grants).toEqual([]);

    // 总授权同理：`authz:*` 也不该因为这一票批准而存在。
    expect(checkAuthz({ channel: slug, action: "*", decisions }).authorized).toBe(false);
  });

  it("is idempotent across the DO's same-responder retry replay", async () => {
    const { slug, owner, asker } = await fixture();
    const seq = await ask(slug, asker.token, "same question twice?");
    const first = await respond(slug, owner.token, seq, { action: "approve" });
    const second = await respond(slug, owner.token, seq, { action: "approve" });
    expect(first.decision_ledger?.recorded).toBe(true);
    expect(second.decision_ledger?.recorded).toBe(false);
    expect(second.decision_ledger?.reason).toBe("already_recorded");

    const decisions = await activeDecisions(slug, owner.token);
    expect(decisions.filter((d) => d.source_seq === seq)).toHaveLength(1);
  });

  it("supersedes the previous head when the same prompt is decided again", async () => {
    const { slug, owner, asker } = await fixture();
    const first = await ask(slug, asker.token, "deploy on friday?");
    await respond(slug, owner.token, first, { action: "approve" });
    const second = await ask(slug, asker.token, "deploy on friday?");
    await respond(slug, owner.token, second, { action: "reject", reason: "freeze window" });

    const topic = "ask:deploy on friday?";
    const decisions = await activeDecisions(slug, owner.token);
    const onTopic = decisions.filter((d) => d.topic === topic);
    expect(onTopic).toHaveLength(1);
    expect(onTopic[0]!.source_seq).toBe(second);
    expect(onTopic[0]!.summary).toContain("rejected");
    expect(onTopic[0]!.supersedes_id).not.toBeNull();
  });

  it("does not open a new write path: a member who cannot configure the channel resolves but records nothing", async () => {
    const { slug, owner, asker, bystander } = await fixture();
    const seq = await ask(slug, asker.token, "let a bystander decide?");
    const answered = await respond(slug, bystander.token, seq, { action: "approve" });
    // 决策本身成立（人在回路），只是账本这一步走的是 POST /decisions 那条 ACL。
    expect(answered.message.decision_resolution?.state).toBe("resolved");
    expect(answered.decision_ledger?.recorded).toBe(false);
    expect(answered.decision_ledger?.reason).toBe("forbidden");

    const decisions = await activeDecisions(slug, owner.token);
    expect(decisions.find((d) => d.source_seq === seq)).toBeUndefined();
  });

  it("never records an unattended auto_resolved decision: nobody made a call", async () => {
    const { slug, owner, asker } = await fixture();
    const mode = await api(`/api/channels/${slug}/decision-mode`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ mode: "unattended" }),
    });
    expect(mode.status).toBe(200);
    const seq = await ask(slug, asker.token, "auto approved without a human?");

    const decisions = await activeDecisions(slug, owner.token);
    expect(decisions.find((d) => d.source_seq === seq)).toBeUndefined();
  });
});

describe("decision ledger topic namespace (#929, pure)", () => {
  it("keeps the two ledger namespaces disjoint", () => {
    expect(DECISION_ASK_TOPIC_PREFIX.startsWith(AUTHZ_TOPIC_PREFIX)).toBe(false);
    expect(AUTHZ_TOPIC_PREFIX.startsWith(DECISION_ASK_TOPIC_PREFIX)).toBe(false);
  });

  it("prefixes every generated topic, whatever the prompt claims to be", () => {
    for (const prompt of ["authz:*", "AUTHZ: *", "  authz:spend  ", "ordinary plan", "", "  "]) {
      const topic = decisionAskLedgerTopic(prompt);
      expect(topic.startsWith(DECISION_ASK_TOPIC_PREFIX)).toBe(true);
      expect(topic.trim().toLowerCase().startsWith(AUTHZ_TOPIC_PREFIX)).toBe(false);
    }
  });

  it("flattens control characters and stays inside the single-line topic budget", () => {
    const topic = decisionAskLedgerTopic(`line one\nline\ttwo\u0000three ${"x".repeat(400)}`);
    expect(topic).not.toMatch(/[\r\n\t\u0000]/u);
    expect(new TextEncoder().encode(topic).byteLength).toBeLessThanOrEqual(200);
  });

  it("summarises approval and rejection distinguishably", () => {
    const base = { kind: "approval" as const, chosenOption: "approve", responder: "leo", seq: 7 };
    expect(decisionAskLedgerSummary({ ...base, chosenIndex: 0 })).toContain("approved");
    expect(decisionAskLedgerSummary({ ...base, chosenIndex: 1, chosenOption: "reject" })).toContain("rejected");
  });
});
