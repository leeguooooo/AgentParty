// 时间显示：消息始终带日期，避免跨天回看时把旧消息误认成今天；presence 用相对时间。
const pad = (n: number) => String(n).padStart(2, "0");

export function fmtTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const current = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === current.getFullYear()
    ? `${date} ${time}`
    : `${d.getFullYear()}-${date} ${time}`;
}

export function fmtRel(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
