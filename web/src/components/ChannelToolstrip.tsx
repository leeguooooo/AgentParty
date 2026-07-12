import { useState, type ReactNode } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/Channel";

const EXPANDED_STORAGE_KEY = "ap_channel_tools_expanded";

function readExpandedPreference(): boolean {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function writeExpandedPreference(expanded: boolean): void {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // Storage can be unavailable in private browsing; the in-memory state still works.
  }
}

interface ChannelToolstripProps {
  buttons: ReactNode;
  actions: ReactNode;
}

export function ChannelToolstrip({ buttons, actions }: ChannelToolstripProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(readExpandedPreference);

  const toggle = () => {
    setExpanded((current) => {
      const next = !current;
      writeExpandedPreference(next);
      return next;
    });
  };

  return (
    <div
      className={`chan-toolstrip chan-toolstrip--${expanded ? "expanded" : "collapsed"}`}
      aria-label={t("Channel.tools.label")}
    >
      <button
        type="button"
        className="d-btn chan-toolstrip-toggle"
        aria-expanded={expanded}
        aria-controls="channel-toolstrip-content"
        aria-label={t(expanded ? "Channel.tools.collapse" : "Channel.tools.expand")}
        title={t(expanded ? "Channel.tools.collapse" : "Channel.tools.expand")}
        onClick={toggle}
      >
        <span className="ap-sprite ap-sprite--tools" aria-hidden="true" />
        <span className="chan-toolstrip-toggle-label">{t("Channel.tools.label")}</span>
        <span className="chan-toolstrip-toggle-arrow" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      <div id="channel-toolstrip-content" className="chan-toolstrip-content">
        <div className="chan-tool-buttons">{buttons}</div>
        <div className="chan-tool-actions">{actions}</div>
      </div>
    </div>
  );
}
