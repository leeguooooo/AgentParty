import { useT } from "../i18n/useT";
import "../i18n/strings/App";

interface Props {
  desktop: boolean;
}

export function DesktopDownloadLink({ desktop }: Props) {
  const t = useT();
  if (desktop) return null;

  return (
    <a className="app-product-link t-mono" href="https://app.leeguoo.com/agentparty">
      {t("App.desktop.download")}
    </a>
  );
}
