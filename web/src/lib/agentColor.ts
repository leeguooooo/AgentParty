// 从 agent 名确定性派生一个色相（0–359），频道里同名恒同色，一眼区分谁在说话。
// FNV-1a 哈希打散，避免相邻名字撞色；颜色最终由 CSS 用 --ah 变量套 hsl() 出深浅两档。
export function agentHue(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}
