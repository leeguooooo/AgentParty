// 接入引导的着色（#1073 第 1 点）。
//
// 引导输出是一屏纯文本，「哪一步过了、卡在哪、要跑哪条命令」全靠人逐行读。加色不是好看：
// ✗ 和修法命令要在一眼扫下来时先跳出来。
//
// 纪律：**只给本地生成的结构元素上色**——步骤序号、✓/✗/!/· 符号、修法命令。摘要与补充行里
// 可能混进服务端可控文本（身份、频道名、错误消息），给它们套色码等于把 reset 序列的控制权
// 交给远端：一个 \x1b[0m 就能提前收色、后面的伪造文本继承我们的样式。那类文本一律不着色。
// （同理，这里绝不 strip——清洗是 format.ts 的职责，重复实现只会两边漂移。）

/** 一组着色函数；关闭着色时全部是恒等函数。 */
export interface Style {
  ok(text: string): string;
  bad(text: string): string;
  warn(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
  cmd(text: string): string;
}

const PLAIN: Style = {
  ok: (t) => t,
  bad: (t) => t,
  warn: (t) => t,
  dim: (t) => t,
  bold: (t) => t,
  cmd: (t) => t,
};

const wrap = (code: string) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;

const COLOR: Style = {
  ok: wrap("32"),
  bad: wrap("31"),
  warn: wrap("33"),
  dim: wrap("2"),
  bold: wrap("1"),
  cmd: wrap("36"),
};

/**
 * 该不该着色。优先级照通行约定：NO_COLOR（只看有没有设，空串也算设了）> FORCE_COLOR >
 * TERM=dumb > 输出是不是 TTY。管道重定向到文件默认不带色，所以贴日志给别人看不会一堆乱码。
 */
export function colorEnabled(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return isTty;
}

export function styleFor(enabled: boolean): Style {
  return enabled ? COLOR : PLAIN;
}

/** 进程默认：按当前 env 与 stdout 是否 TTY 决定。 */
export function processStyle(): Style {
  return styleFor(colorEnabled(process.env, process.stdout.isTTY === true));
}
