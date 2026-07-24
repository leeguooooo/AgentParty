import { useT } from "../i18n/useT";
import { desktopAgentAdapter, type DesktopAgentAdapter } from "../lib/desktopAgent";
import { DesktopAgentPanel } from "./DesktopAgentPanel";
import { LocalAgentsOverview } from "./LocalAgentsOverview";
import { ResidentDutyLogs } from "./ResidentDutyLogs";
import { SectionedDialog, type SectionedDialogSection } from "./SectionedDialog";
import "../i18n/strings/LocalAgentCenter";

export type LocalAgentCenterSection = "overview" | "launcher" | "logs";

interface Props {
  onClose(): void;
  adapter?: DesktopAgentAdapter;
  initialSection?: LocalAgentCenterSection;
}

/**
 * Cross-channel local-agent operations belong to a dedicated control center,
 * not to personal/global settings. Only the active module is mounted, so
 * opening Preferences no longer starts agent-status and log polling.
 */
export function LocalAgentCenter({
  onClose,
  adapter = desktopAgentAdapter,
  initialSection = "overview",
}: Props) {
  const t = useT();
  const sections: readonly SectionedDialogSection<LocalAgentCenterSection>[] = [
    {
      id: "overview",
      label: t("LocalAgentCenter.section.overview"),
      content: <LocalAgentsOverview t={t} adapter={adapter} />,
    },
    {
      id: "launcher",
      label: t("LocalAgentCenter.section.launcher"),
      content: <DesktopAgentPanel t={t} adapter={adapter} />,
    },
    {
      id: "logs",
      label: t("LocalAgentCenter.section.logs"),
      content: <ResidentDutyLogs t={t} adapter={adapter} />,
    },
  ];

  return (
    <SectionedDialog
      idPrefix="local-agent-center"
      title={t("LocalAgentCenter.title")}
      closeLabel={t("LocalAgentCenter.close")}
      navigationLabel={t("LocalAgentCenter.navigation")}
      sections={sections}
      initialSection={initialSection}
      onClose={onClose}
      keepMounted={false}
      panelClassName="settings-panel--agent-center"
    />
  );
}
