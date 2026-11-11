import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, QrCode, Smartphone } from "lucide-react";
import { getPilotVRuntime } from "../../../../../../components/app-shell/pilotvRuntime";
import { cn } from "../../../../../../lib/utils";
import {
  PILOTV_RELEASES_URL,
  PILOTV_REPO_URL,
} from "../../../../../../lib/pilotvLinks";

/**
 * 扫码页由 PilotV 网关自己渲染，并按 ?d= 绑定当前设备。不带这个参数时网关
 * 会按 Cookie 选设备，多标签页各连一台机器时手机可能连到另一台，扫完报 401。
 */
export function appClientPairHref(backend?: string | null): string {
  if (!backend) return "/pair";
  return `/pair?d=${encodeURIComponent(backend)}`;
}

/** 设置 → 消息渠道：PilotV App 客户端扫码连接入口。默认展开，避免入口被藏起来。 */
export default function AppClientChannelSection() {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(true);
  const pairHref = appClientPairHref(getPilotVRuntime()?.backend);

  return (
    <section
      className={cn("integration-channel", expanded && "expanded")}
      aria-labelledby="app-client-channel-title"
    >
      <button
        type="button"
        className="integration-channel-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="integration-platform-icon app-client" aria-hidden="true">
          <Smartphone size={20} />
        </span>
        <span className="integration-channel-copy">
          <strong id="app-client-channel-title">{t("gateway.appClient.title")}</strong>
          <small>{t("gateway.appClient.summary")}</small>
        </span>
        <span className="integration-status connected">
          <i />
          {t("gateway.appClient.badge")}
        </span>
        <span className="integration-channel-toggle">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {expanded ? (
        <div className="integration-channel-detail">
          <div className="integration-detail-heading">
            <strong>{t("gateway.appClient.detailTitle")}</strong>
            <span>{t("gateway.appClient.deviceHint")}</span>
          </div>

          <div className="integration-channel-guide">
            <QrCode size={15} aria-hidden="true" />
            <div>
              <p>{t("gateway.appClient.guide")}</p>
              <ol className="app-client-steps">
                <li>{t("gateway.appClient.step1")}</li>
                <li>{t("gateway.appClient.step2")}</li>
                <li>{t("gateway.appClient.step3")}</li>
              </ol>
            </div>
          </div>

          <div className="app-client-actions">
            <a
              className="app-client-link primary"
              href={pairHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <QrCode size={15} aria-hidden="true" />
              {t("gateway.appClient.open")}
            </a>
            <a
              className="app-client-link"
              href={PILOTV_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("gateway.appClient.releaseLink")}
            </a>
            <a
              className="app-client-link"
              href={PILOTV_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("gateway.appClient.projectLink")}
            </a>
          </div>

          <p className="app-client-footnote">{t("gateway.appClient.footnote")}</p>
        </div>
      ) : null}
    </section>
  );
}
