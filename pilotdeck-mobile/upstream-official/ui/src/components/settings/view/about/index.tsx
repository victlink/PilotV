import { useTranslation } from "react-i18next";
import type { DesktopVersionCheckResult } from "../../version";
import DesktopAboutSections from "./DesktopAboutSections";
import { SettingsCard } from "../../shared/view";
import { PILOTV_RELEASES_URL } from "../../../../lib/pilotvLinks";
import AppClientPairCard from "./AppClientPairCard";

export type AboutSectionsProps = {
  title: string;
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
  onCheckUpdates?: () => Promise<void>;
  onRestartConfirmed?: () => void;
};

export default function AboutSections(props: AboutSectionsProps) {
  // 客户端扫码与下载属于「关于 / 版本」信息，桌面版和网页版都要能看到。
  return (
    <div className="space-y-6">
      {props.versionInfo.mode === "desktop"
        ? <DesktopAboutSections {...props} />
        : <WebAboutSections versionInfo={props.versionInfo} />}
      <AppClientPairCard />
    </div>
  );
}

function WebAboutSections({ versionInfo }: { versionInfo: DesktopVersionCheckResult }) {
  const { t } = useTranslation("settings");
  const currentVersion = versionInfo.currentVersion === "unknown" ? "-" : versionInfo.currentVersion;

  return (
    <div className="about-page-content">
      <SettingsCard className="overflow-hidden">
        <div className="px-5 py-4 text-sm">
          <span className="font-medium">{t("settingsPage.about.currentVersion")}</span>
          <span className="ml-2 text-muted-foreground">{currentVersion}</span>
        </div>
        <div className="space-y-3 border-t border-border px-5 py-4 text-sm text-muted-foreground">
          <p>{t("settingsPage.about.webReleaseHint")}</p>
          <a
            href={PILOTV_RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-medium text-[var(--pd-accent-strong,#2563eb)] underline-offset-2 hover:underline"
          >
            {t("settingsPage.about.webReleaseLink")}
          </a>
        </div>
      </SettingsCard>
    </div>
  );
}
