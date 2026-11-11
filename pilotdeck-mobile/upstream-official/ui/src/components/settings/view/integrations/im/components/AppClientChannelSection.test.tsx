import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppClientChannelSection, { appClientPairHref } from "./AppClientChannelSection";
import { PILOTV_RELEASES_URL, PILOTV_REPO_URL } from "../../../../../../lib/pilotvLinks";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  delete (window as unknown as { __PILOTV__?: unknown }).__PILOTV__;
});

describe("AppClientChannelSection", () => {
  it("keeps the scan entry visible and links to the gateway pair page", () => {
    render(<AppClientChannelSection />);
    expect(screen.getByText("gateway.appClient.title")).toBeTruthy();
    const open = screen.getByRole("link", { name: /gateway\.appClient\.open/ });
    expect(open.getAttribute("href")).toBe("/pair");
    expect(open.getAttribute("target")).toBe("_blank");
  });

  it("binds the pair page to the device of the current tab", () => {
    (window as unknown as { __PILOTV__?: unknown }).__PILOTV__ = {
      backend: "http://leo-mac-studio:3001",
      device: { name: "leo", origin: "http://leo-mac-studio:3001" },
    };
    render(<AppClientChannelSection />);
    expect(screen.getByRole("link", { name: /gateway\.appClient\.open/ }).getAttribute("href"))
      .toBe("/pair?d=http%3A%2F%2Fleo-mac-studio%3A3001");
  });

  it("points every version and project link at PilotV, never at upstream PilotDeck", () => {
    const { container } = render(<AppClientChannelSection />);
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(PILOTV_RELEASES_URL);
    expect(hrefs).toContain(PILOTV_REPO_URL);
    expect(hrefs.join(" ")).not.toMatch(/OpenBMB|PilotDeck/i);
    expect(screen.getByText("gateway.appClient.releaseLink")).toBeTruthy();
  });

  it("can be collapsed and expanded again", () => {
    render(<AppClientChannelSection />);
    const toggle = screen.getByRole("button", { expanded: true });
    fireEvent.click(toggle);
    expect(screen.queryByRole("link", { name: /gateway\.appClient\.open/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("link", { name: /gateway\.appClient\.open/ })).toBeTruthy();
  });
});

describe("appClientPairHref", () => {
  it("omits the device param when the gateway did not inject a backend", () => {
    expect(appClientPairHref()).toBe("/pair");
    expect(appClientPairHref("")).toBe("/pair");
    expect(appClientPairHref("https://nas.tail2b98e5.ts.net:5186"))
      .toBe("/pair?d=https%3A%2F%2Fnas.tail2b98e5.ts.net%3A5186");
  });
});
