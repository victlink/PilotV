import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { authenticatedFetch } from "../../../../utils/api";
import { getPilotVRuntime } from "../../../app-shell/pilotvRuntime";
import {
  PILOTV_RELEASES_URL,
  PILOTV_REPO_URL,
} from "../../../../lib/pilotvLinks";
import { SettingsCard } from "../../shared/view";

/** 客户端安装包：由网关从 <repo>/downloads 直发，不随每次前端构建重建。 */
const PILOTV_ANDROID_APK = "/download/pilotv-android-latest.apk";

const PAIR_NEW = "/api/pilotv/pair/new";
const PAIR_RENDER = "/api/pilotv/pair/render.svg";
const PAIR_STATUS = "/api/pilotv/pair/status";

/** 独立扫码页要带 ?d= 绑定当前设备，否则手机可能连到另一台机器。 */
export function appClientPairHref(backend?: string | null): string {
  if (!backend) return "/pair";
  return `/pair?d=${encodeURIComponent(backend)}`;
}

type PairReady = {
  status: "ready";
  qrUrl: string;
  code: string;
  uri: string;
  expiresAt: number;
  left: number;
  alternates: string[];
  paired: boolean;
};
type PairView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | PairReady;

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null) as
    | (Record<string, unknown> & { error?: string })
    | null;
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  if (!payload || typeof payload !== "object") throw new Error("响应格式错误");
  return payload;
}

/**
 * 「关于」里的实时扫码卡片。
 *
 * 之前设置 → 消息渠道只放了一个 /pair 链接，用户既找不到入口，也看不到二维码；
 * 现在二维码、配对码、有效期与客户端下载都集中在这里。签发与渲染都走
 * authenticatedFetch（自动带 JWT 和 X-PilotV-Device），SVG 用 blob URL 显示，
 * 一次性密钥不会出现在图片 URL 或访问日志里。
 */
export default function AppClientPairCard() {
  const { t } = useTranslation("settings");
  const key = (name: string) => `settingsPage.about.appClient.${name}`;
  const [round, setRound] = useState(0);
  const [view, setView] = useState<PairView>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const pairHref = appClientPairHref(getPilotVRuntime()?.backend);

  useEffect(() => {
    let active = true;
    let qrUrl: string | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let issuedCode = "";

    const poll = async () => {
      if (!active || !issuedCode) return;
      try {
        const response = await authenticatedFetch(
          `${PAIR_STATUS}?code=${encodeURIComponent(issuedCode)}`,
          { suppressServerErrorToast: true },
        );
        if (!active) return;
        if (response.ok) {
          const state = await response.json().catch(() => null) as { state?: string } | null;
          if (state?.state === "used") {
            setView(prev => prev.status === "ready" ? { ...prev, paired: true } : prev);
            pollTimer = setTimeout(() => { if (active) setRound(value => value + 1); }, 2500);
            return;
          }
        }
      } catch { /* 轮询失败不打扰用户，下次继续 */ }
      if (active) pollTimer = setTimeout(() => { void poll(); }, 2500);
    };

    const issue = async () => {
      setView({ status: "loading" });
      try {
        const backend = getPilotVRuntime()?.backend || "";
        const issued = await readPayload(await authenticatedFetch(PAIR_NEW, {
          method: "POST",
          body: JSON.stringify({ origin: window.location.origin, deviceOrigin: backend }),
          suppressServerErrorToast: true,
        }));
        const uri = String(issued.uri || "");
        if (!uri) throw new Error("签发结果里没有连接串");
        const svgResponse = await authenticatedFetch(
          `${PAIR_RENDER}?d=${base64url(uri)}`,
          { suppressServerErrorToast: true },
        );
        if (!svgResponse.ok) {
          const detail = await svgResponse.json().catch(() => null) as { error?: string } | null;
          throw new Error(detail?.error || `HTTP ${svgResponse.status}`);
        }
        const svg = await svgResponse.text();
        if (!active) return;
        const nextQr = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        if (qrUrl) URL.revokeObjectURL(qrUrl);
        qrUrl = nextQr;
        issuedCode = String(issued.code || "");
        const expiresAt = Date.parse(String(issued.expiresAt || "")) || Date.now() + 300000;
        setView({
          status: "ready",
          qrUrl: nextQr,
          code: issuedCode,
          uri,
          expiresAt,
          left: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
          alternates: Array.isArray(issued.alternates) ? issued.alternates.map(String) : [],
          paired: false,
        });
        tick = setInterval(() => {
          setView(prev => prev.status === "ready"
            ? { ...prev, left: Math.max(0, Math.round((prev.expiresAt - Date.now()) / 1000)) }
            : prev);
        }, 1000);
        void poll();
      } catch (error) {
        if (active) {
          setView({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    void issue();
    return () => {
      active = false;
      if (tick) clearInterval(tick);
      if (pollTimer) clearTimeout(pollTimer);
      if (qrUrl) URL.revokeObjectURL(qrUrl);
    };
  }, [round]);

  const copy = async () => {
    if (view.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(view.uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* 剪贴板不可用时忽略，用户还能用独立扫码页 */ }
  };

  const left = view.status === "ready" ? view.left : 0;
  const countdown = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;

  return (
    <SettingsCard className="app-client-pair-card">
      <header className="app-client-pair-header">
        <span className="app-client-pair-icon" aria-hidden="true"><Smartphone size={19} /></span>
        <div>
          <h2>{t(key("title"))}</h2>
          <p>{t(key("summary"))}</p>
        </div>
      </header>

      <div className="app-client-pair-grid">
        <div className="app-client-pair-qr">
          <div className="app-client-qrbox">
            {view.status === "ready" ? (
              <img src={view.qrUrl} alt={t(key("qrAlt"))} />
            ) : (
              <span className="app-client-qr-hint">{t(key("generating"))}</span>
            )}
          </div>
          <div className="app-client-code">
            <small>{t(key("codeLabel"))}</small>
            <strong>{view.status === "ready" ? view.code : "······"}</strong>
          </div>
          <div className="app-client-meta">
            <span>{t(key("deviceHint"))}</span>
            <span>{view.status !== "ready" ? "—" : left > 0 ? countdown : t(key("expired"))}</span>
          </div>
          <div className="app-client-pair-actions">
            <button type="button" onClick={() => setRound(value => value + 1)}>
              <RefreshCw size={14} aria-hidden="true" />{t(key("refresh"))}
            </button>
            <button type="button" disabled={view.status !== "ready"} onClick={() => void copy()}>
              <Copy size={14} aria-hidden="true" />{copied ? t(key("copied")) : t(key("copy"))}
            </button>
          </div>
          {view.status === "error" ? (
            <p className="app-client-error" role="alert">{t(key("error"))} {view.message}</p>
          ) : null}
          {view.status === "ready" && view.paired ? (
            <p className="app-client-paired" role="status">{t(key("paired"))}</p>
          ) : null}
        </div>

        <div className="app-client-pair-copy">
          <p>{t(key("guide"))}</p>
          <ol className="app-client-steps">
            <li>{t(key("step1"))}</li>
            <li>{t(key("step2"))}</li>
            <li>{t(key("step3"))}</li>
          </ol>
          {view.status === "ready" && view.alternates.length ? (
            <p className="app-client-alts">{t(key("alternatesLabel"))}：{view.alternates.join(" · ")}</p>
          ) : null}
          <div className="app-client-actions">
            <a className="app-client-link primary" href={pairHref} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={15} aria-hidden="true" />{t(key("open"))}
            </a>
            <a className="app-client-link primary" href={PILOTV_ANDROID_APK} download>
              <Smartphone size={15} aria-hidden="true" />{t(key("downloadApk"))}
            </a>
            <a className="app-client-link" href={PILOTV_RELEASES_URL} target="_blank" rel="noopener noreferrer">
              <QrCode size={15} aria-hidden="true" />{t(key("releaseLink"))}
            </a>
            <a className="app-client-link" href={PILOTV_REPO_URL} target="_blank" rel="noopener noreferrer">
              {t(key("projectLink"))}
            </a>
          </div>
          <p className="app-client-footnote">{t(key("footnote"))}</p>
        </div>
      </div>
    </SettingsCard>
  );
}
