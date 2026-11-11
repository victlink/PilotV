import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppClientPairCard, { appClientPairHref } from "./AppClientPairCard";
import { PILOTV_RELEASES_URL, PILOTV_REPO_URL } from "../../../../lib/pilotvLinks";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../../../../utils/api", () => ({ authenticatedFetch: mockFetch }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (name: string) => name }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const issued = {
  code: "AB12CD",
  uri: "pilotv://pair?v=1&h=https%3A%2F%2Fnas%3A5186&c=AB12CD&s=secret",
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  alternates: ["http://192.168.1.5:5187"],
};

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:pair-qr"), writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/pilotv/pair/new")) return jsonResponse(issued);
    if (url.startsWith("/api/pilotv/pair/render.svg")) {
      return new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
        status: 200, headers: { "content-type": "image/svg+xml" },
      });
    }
    if (url.startsWith("/api/pilotv/pair/status")) return jsonResponse({ state: "pending" });
    return jsonResponse({}, 404);
  });
});

afterEach(() => {
  cleanup();
  mockFetch.mockReset();
  delete (window as unknown as { __PILOTV__?: unknown }).__PILOTV__;
});

describe("AppClientPairCard", () => {
  it("renders a live QR code and the pairing code from the gateway", async () => {
    render(<AppClientPairCard />);
    const qr = await screen.findByAltText("settingsPage.about.appClient.qrAlt");
    expect(qr.getAttribute("src")).toBe("blob:pair-qr");
    expect(screen.getByText("AB12CD")).toBeTruthy();
    const [, newCall] = mockFetch.mock.calls[0];
    expect(newCall.method).toBe("POST");
    expect(JSON.parse(newCall.body).origin).toBe(window.location.origin);
  });

  it("renders the QR SVG with an authenticated request, never an unauthenticated img", async () => {
    render(<AppClientPairCard />);
    await screen.findByAltText("settingsPage.about.appClient.qrAlt");
    const renderCall = mockFetch.mock.calls.find(([url]) => String(url).startsWith("/api/pilotv/pair/render.svg"));
    expect(renderCall).toBeTruthy();
    expect(String(renderCall![0])).toContain("?d=");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("points every version and project link at PilotV only", async () => {
    const { container } = render(<AppClientPairCard />);
    await screen.findByAltText("settingsPage.about.appClient.qrAlt");
    const hrefs = Array.from(container.querySelectorAll("a")).map(a => a.getAttribute("href"));
    expect(hrefs).toContain(PILOTV_RELEASES_URL);
    expect(hrefs).toContain(PILOTV_REPO_URL);
    expect(hrefs).toContain("/pair");
    expect(hrefs.join(" ")).not.toMatch(/OpenBMB|PilotDeck/i);
  });

  it("binds the standalone pairing page to the current device", async () => {
    (window as unknown as { __PILOTV__?: unknown }).__PILOTV__ = {
      backend: "http://leo-mac-studio:3001",
      device: { name: "leo", origin: "http://leo-mac-studio:3001" },
    };
    const { container } = render(<AppClientPairCard />);
    await screen.findByAltText("settingsPage.about.appClient.qrAlt");
    expect(container.querySelector("a")?.getAttribute("href"))
      .toBe("/pair?d=http%3A%2F%2Fleo-mac-studio%3A3001");
    await waitFor(() => {
      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toBe("/api/pilotv/pair/new");
      expect(JSON.parse(init.body).deviceOrigin).toBe("http://leo-mac-studio:3001");
    });
  });

  it("shows a readable error instead of an endless spinner", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ error: "未登录" }, 401));
    render(<AppClientPairCard />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("未登录");
    expect(screen.getByText("settingsPage.about.appClient.generating")).toBeTruthy();
  });
});

describe("appClientPairHref", () => {
  it("omits the device param when no backend was injected", () => {
    expect(appClientPairHref()).toBe("/pair");
    expect(appClientPairHref("")).toBe("/pair");
    expect(appClientPairHref("https://nas.tail2b98e5.ts.net:5186"))
      .toBe("/pair?d=https%3A%2F%2Fnas.tail2b98e5.ts.net%3A5186");
  });
});
