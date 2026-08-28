// 接入引导的步骤机（issue #988，epic #987）。
//
// 从前 `party join` 收尾是一坨自检：把所有格子一次性判完再挑第一个 ✗ 给修法。分步引导把它改成
// **顺序执行、逐步打印、不过就停**：
//
//   第 0 步  版本 · CLI 0.2.216 ✓ · claude 插件 0.2.214 → 已更新到 0.2.216（需重开会话）
//   第 1 步  身份 · #ludo 上以 server 报到 ✓
//   第 2 步  接收方式 · 你选：交互式 Claude 会话（可选：常驻 party serve ludo --runner claude）
//   第 3 步  起一个可唤醒的会话 · 本机没有会接 @ 的 Claude 会话 ✗
//            修法（做完重跑同一条 party join）：
//              party claude ludo
//
// 这个文件只管「机器」：一步一条 check、过/不过、不过时**恰一条**修法命令然后停（退出码非 0），
// 全部过才轮到调用方印 ✅。每一步该查什么、修法是哪条，由调用方（join.ts）按 harness 组装——
// 这里不认识 claude / codex。
//
// 设计约束：
//  - **只给一条修法**（#926 / wake-checklist 同一纪律）：列三件等于没给，用户会挑最容易的做完就停。
//    所以 fix.do 是一个字符串，不是数组；notes 是「做这条之前必须知道的话」，不是第二件待办。
//  - **停在该步**：后面的步骤一概不跑——它们的修法在前一步没过时没有意义（监听闸放最后的老规矩）。
//  - **幂等**：机器本身无状态；每一步的 run 由调用方保证可重跑（先探后加、替换式绑定……）。
//  - **不交互**：机器只打印。要问用户的（第 2 步选接收方式）由那一步的 run 自己决定问不问，
//    `--yes` / 无 TTY 时按默认走并把所选印出来。

/** 一步跑完的结果。 */
export interface StepResult {
  ok: boolean;
  /** 跟在「第 N 步  标题 · 」后面的一句摘要；机器会在末尾补 ✓ / ✗。 */
  summary: string;
  /** 摘要之外要给人看的补充行（缩进印在步骤行下方）：所选默认、要跑的命令、原因……过/不过都可有。 */
  detail?: string[];
  /** 不过时的修法：do 是**恰一条**可跑的命令；notes 是做它之前必须知道的话。ok=true 时忽略。 */
  fix?: { do: string; notes?: string[] };
}

export interface Step<Ctx> {
  id: string;
  /** 「第 N 步」后面的标题：版本 / 身份 / 接收方式 / 起一个可唤醒的会话 / 真发一条 @ 验证。 */
  title: string;
  run(ctx: Ctx): Promise<StepResult> | StepResult;
}

export interface StepRecord {
  index: number;
  id: string;
  title: string;
  result: StepResult;
}

export type StepsOutcome =
  | { ok: true; records: StepRecord[] }
  | { ok: false; records: StepRecord[]; stoppedAt: StepRecord };

/** 步骤行下方补充行的缩进——与「第 N 步  」对齐（两个全角字符宽度按 9 列算，够用即可）。 */
export const STEP_INDENT = "         ";

/** 「第 N 步  标题 · 摘要 ✓」这一行。 */
export function formatStepLine(index: number, title: string, result: StepResult): string {
  return `第 ${index} 步  ${title} · ${result.summary} ${result.ok ? "✓" : "✗"}`;
}

/**
 * 一步的完整输出：步骤行 + 补充行 + （不过时）恰一条修法。修法的形态固定：
 *   `修法（做完重跑同一条 party join）：` 一行，下一行缩进印命令，再下面是 notes。
 * 测试就靠这个形态数「印了几条修法」。
 */
export function formatStep(index: number, title: string, result: StepResult, rerun: string): string[] {
  const lines = [formatStepLine(index, title, result)];
  for (const d of result.detail ?? []) lines.push(`${STEP_INDENT}${d}`);
  if (!result.ok) {
    const fix = result.fix ?? { do: rerun };
    for (const n of fix.notes ?? []) lines.push(`${STEP_INDENT}${n}`);
    lines.push(`${STEP_INDENT}修法（做完重跑同一条 ${rerun}）：`);
    lines.push(`${STEP_INDENT}  ${fix.do}`);
  }
  return lines;
}

export interface RunStepsInput<Ctx> {
  steps: Step<Ctx>[];
  ctx: Ctx;
  log: (line: string) => void;
  /** 「做完重跑」时该跑的命令，缺省 `party join`。 */
  rerun?: string;
  /** 第一步的编号（epic 从第 0 步「版本」数起）。 */
  firstIndex?: number;
}

/**
 * 顺序跑步骤：每步跑完立刻打印；任一步不过 ⇒ 印修法、**停**（后续步骤不跑）。
 * run 抛异常按「不过」处理（异常文本进摘要），绝不因探活炸了就假定过了。
 */
export async function runSteps<Ctx>(input: RunStepsInput<Ctx>): Promise<StepsOutcome> {
  const rerun = input.rerun ?? "party join";
  const first = input.firstIndex ?? 0;
  const records: StepRecord[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]!;
    const index = first + i;
    let result: StepResult;
    try {
      result = await step.run(input.ctx);
    } catch (e) {
      result = { ok: false, summary: `这一步炸了：${e instanceof Error ? e.message : String(e)}` };
    }
    const record: StepRecord = { index, id: step.id, title: step.title, result };
    records.push(record);
    for (const line of formatStep(index, step.title, result, rerun)) input.log(line);
    if (!result.ok) return { ok: false, records, stoppedAt: record };
  }
  return { ok: true, records };
}
