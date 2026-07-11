// 主题：涂鸦纸底（doodle，默认）↔ 终端暗色（midnight）。两套主题的 CSS 变量早已在
// styles/tokens.css 里按 :root[data-theme] 备好——这里只做「选哪套 + 记住选择」的纯客户端开关，
// 不落后端。切换即在 <html> 上写 data-theme，并存进 localStorage，刷新后仍生效。
export type Theme = "doodle" | "midnight";

export const SUPPORTED_THEMES: { code: Theme; labelKey: string }[] = [
  { code: "doodle", labelKey: "App.settings.theme.paper" },
  { code: "midnight", labelKey: "App.settings.theme.midnight" },
];

export const DEFAULT_THEME: Theme = "doodle";

const STORAGE_KEY = "ap_theme";

export function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "midnight" ? "midnight" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: Theme): void {
  try {
    // guard：测试/SSR 里 document 可能是精简替身；缺 documentElement 时静默跳过。
    document?.documentElement?.setAttribute?.("data-theme", theme);
  } catch {
    // 无 document 时不炸——本次仅持久化，下次带 document 的环境再落地。
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage 不可用（隐私模式）时静默：本会话内切换仍生效，只是刷新不记。
  }
}

export function applyStoredTheme(): void {
  applyTheme(readStoredTheme());
}
