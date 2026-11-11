import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AboutSections from ".";
import type { DesktopVersionCheckResult } from "../../version";
import { PILOTV_RELEASES_URL } from "../../../../lib/pilotvLinks";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../../../../utils/api", () => ({ authenticatedFetch: mockFetch }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:pair-qr"), writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).startsWith("/api/pilotv/pair/new")) {
      return jsonResponse({
        code: "AB12CD", uri: "pilotv://pair?v=1&c=AB12CD&s=secret",
        expiresAt: new Date(Date.now() + 300000).toISOString(), alternates: [],
      });
    }
    if (String(url).startsWith("/api/pilotv/pair/render.svg")) {
      return new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
    }
    return jsonResponse({ state: "pending" });
  });
});

afterEach(() => { cleanup(); mockFetch.mockReset(); });

describe("Web About page", () => {
  const versionInfo: DesktopVersionCheckResult = {
    mode: "web",
    hasUpdate: false,
    checkUnavailable: false,
    currentVersion: "v2026.09.23",
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  };

  it("shows the local version and pilotv pilotv link without an update action", () => {
    render(<AboutSections title="About" versionInfo={versionInfo} checkingVersion={false} />);
    expect(screen.getByText("v2026.09.23")).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map(link => link.getAttribute("href"));
    expect(hrefs).toContain(PILOTV_RELEASES_URL);
    expect(hrefs.join(" ")).not.toMatch(/OpenBMB|PilotDeck/i);
    expect(screen.queryByRole("button", { name: /desktopUpdate/ })).toBeNull();
  });

  it("puts the app-client QR code and downloads in About", async () => {
    render(<AboutSections title="About" versionInfo={versionInfo} checkingVersion={false} />);
    expect(await screen.findByAltText("settingsPage.about.appClient.qrAlt")).toBeTruthy();
    expect(screen.getByText("settingsPage.about.appClient.title")).toBeTruthy();
    expect(screen.getByText("settingsPage.about.appClient.releaseLink")).toBeTruthy();
  });
});
