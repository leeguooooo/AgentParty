// 桌面壳原生剪贴板桥（#1102）：桌面 WebView 从 agentparty-ui:// 自定义 scheme 加载，
// 不一定算安全上下文，navigator.clipboard 不可靠；走 tauri-plugin-clipboard-manager 的 read_text。
// capability 只开 clipboard-manager:allow-read-text。
import { isTauriEnvironment } from "./desktopUpdater";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const defaultInvoke: Invoke = async (cmd, args) => {
  const core = await import("@tauri-apps/api/core");
  return core.invoke(cmd, args);
};

// 桌面壳里返回读剪贴板文本的函数；网页里返回 null（调用方退回 Clipboard API）。
export function desktopClipboardReader(
  env: unknown = globalThis,
  invoke: Invoke = defaultInvoke,
): (() => Promise<string>) | null {
  if (!isTauriEnvironment(env)) return null;
  return async () => {
    const text = await invoke("plugin:clipboard-manager|read_text");
    return typeof text === "string" ? text : "";
  };
}
