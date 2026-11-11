/**
 * PilotV 项目对外链接的唯一来源。
 *
 * 设置页、关于页、登录页和客户端扫码入口都必须引用这里，不要再写 vendored
 * 上游 OpenBMB/PilotDeck 的仓库地址：那是代码来源，不是本产品的版本与下载页。
 */
export const PILOTV_REPO_SLUG = "victlink/PilotV";
export const PILOTV_REPO_URL = `https://github.com/${PILOTV_REPO_SLUG}`;
export const PILOTV_RELEASES_URL = `${PILOTV_REPO_URL}/releases/latest`;
