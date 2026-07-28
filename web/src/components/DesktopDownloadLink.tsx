import { useT } from "../i18n/useT";
import "../i18n/strings/App";
import { DesktopInstallButton } from "./DesktopInstall";

interface Props {
  desktop: boolean;
}

export function DesktopDownloadLink({ desktop }: Props) {
  const t = useT();
  if (desktop) return null;

  return <DesktopInstallButton label={t("App.desktop.download")} />;
}
