
import type { Page, BrowserContext } from "playwright";
import { config } from "./config.js";

export async function openGemini(page: Page): Promise<void> {
  const button = page.locator(config.selectors.geminiButton);

  await button.waitFor({
    state: "visible",
    timeout: config.timeout.element,
  });

  const count = await button.count();

  if (count !== 1) {
    throw new Error(`Expected one Gemini button, found ${count}`);
  }

  await button.click();

  await page.getByText("Ask about this video", {
    exact: true,
  }).waitFor({
    state: "visible",
    timeout: config.timeout.element,
  });

  console.log("Gemini panel opened");
}

export async function requestSummary(page: Page): Promise<void> {
  const button = page.getByText("Summarize the video", {
    exact: true,
  });

  await button.click({
    timeout: config.timeout.element,
  });

  console.log("Summary requested");
}

export async function copySummary(
  page: Page,
  context: BrowserContext
): Promise<string> {
  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: "https://www.youtube.com" }
  );

  const deadline = Date.now() + config.timeout.summary;
  let previous = "";
  let stableReads = 0;

  console.log("Waiting for the summary response...");

  while (Date.now() < deadline) {
    const buttons = page.locator(config.selectors.copyButton);
    const count = await buttons.count();

    if (count > 1) {
      throw new Error(
        `Found ${count} Copy buttons; selector is ambiguous`
      );
    }

    if (count === 1) {
      await page.evaluate(() =>
        navigator.clipboard.writeText("")
      );

      await buttons.click({ timeout: 5000 });

      const text = (
        await page.evaluate(() => navigator.clipboard.readText())
      ).trim();

      if (text.length > 40 && text === previous) {
        stableReads++;
      } else {
        stableReads = 0;
      }

      previous = text;

      if (stableReads >= 3) {
        return text;
      }
    }

    await page.waitForTimeout(config.timeout.polling);
  }

  throw new Error("Timed out waiting for Gemini summary");
}

export async function summarizeVideo(
  page: Page,
  context: BrowserContext
): Promise<string> {
  await openGemini(page);
  await requestSummary(page);

  return copySummary(page, context);
}

