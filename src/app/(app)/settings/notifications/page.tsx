"use client";

import { NotificationPreferences } from "@/components/notifications/NotificationPreferences";
import { useInstallFlow } from "@/components/notifications/InstallSheet";

// The settings content column (layout): where focus goes when the card's Install button is gone.
const settingsContent = () => document.getElementById("settings-content");

/** Settings › Notifications (spec 011, criterion 6): what the Notices "Preferences" tab showed — push, one switch per
 *  notice type and the "App on home screen" card — with the same install flow as the Notices banner. */
export default function NotificationSettingsPage() {
  const { install, startInstall, sheet } = useInstallFlow(settingsContent);

  return (
    <>
      <NotificationPreferences installState={install.cardState} onInstall={() => void startInstall()} />
      {sheet}
    </>
  );
}
