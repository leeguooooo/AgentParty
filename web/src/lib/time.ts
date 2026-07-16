// 时间显示：消息用绝对 HH:MM:SS（mono），presence 用相对时间
const pad = (n: number) => String(n).padStart(2, "0");

function sameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function fmtTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (sameLocalDate(d, new Date(now))) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function fmtRel(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
