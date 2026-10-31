import { chromium } from "playwright";
import { config } from "./config.js";

export async function launchBrowser() {
  return chromium.launchPersistentContext(config.profileDir, {
    headless: config.browser.headless,
    ...(config.browser.executablePath
      ? { executablePath: config.browser.executablePath }
      : {}),
    viewport: config.browser.viewport,
  });
}
