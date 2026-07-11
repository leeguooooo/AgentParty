import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "highlight.js/styles/github.css";
import "./styles/tokens.css";
import "./styles/doodle.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./i18n/locale";
import { synchronizeDesktopStorage } from "./lib/desktopStorage";
import { applyStoredTheme } from "./lib/theme";

async function startApplication() {
  // custom protocol 会切换 WebView origin；先恢复非敏感偏好，再读取主题和服务器配置。
  await synchronizeDesktopStorage();
  // 主题在首帧前就落到 <html data-theme>，避免刷新时先闪一下默认主题再切（#273）。
  applyStoredTheme();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </StrictMode>,
  );
}

void startApplication();
