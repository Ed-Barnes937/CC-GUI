// Boot the real frontend with the backend faked. Two init scripts run before any
// page script (Playwright preserves add order): first the seed, then the bundled
// simulator that reads it and installs mockIPC. Then navigate and wait for the
// seeded sidebar to paint, which also confirms get_groups was answered. The
// group-by bar renders unconditionally (even with zero projects/sessions —
// see onboarding/firstRun.iwft.ts), so it's the readiness signal rather than
// a session row.

import type { Page } from "@playwright/test";
import { SIMULATOR_BUNDLE } from "./paths.testHelper";
import type { Seed } from "../network/types.testHelper";

export async function launchApp(page: Page, seed: Seed): Promise<void> {
  await page.addInitScript((s) => {
    (window as unknown as { __CC_IWFT_SEED__: unknown }).__CC_IWFT_SEED__ = s;
    // View mode is GUI-owned (localStorage), so seed it before the app boots.
    if (s.viewMode) localStorage.setItem("cc-view-mode", s.viewMode);
  }, seed as unknown as Record<string, never>);
  await page.addInitScript({ path: SIMULATOR_BUNDLE });
  await page.goto("/");
  await page.waitForSelector("#sessions .group-by-bar");
}
