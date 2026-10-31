import { fileURLToPath } from "node:url";

export const config = {
  profileDir: fileURLToPath(new URL("../../browser-data", import.meta.url)),
  browser: {
    headless: true,
    executablePath: process.env.CHROME_PATH,
    viewport: { width: 1440, height: 900 },
  },

  selectors: {
    geminiButton:
      'button-view-model.you-chat-entrypoint-button > button[aria-label="Ask"]:visible',

    copyButton: [
      'button[aria-label*="Copy" i]:visible',
      'button[title*="Copy" i]:visible',
      '[role="button"][aria-label*="Copy" i]:visible',
      '[role="button"][title*="Copy" i]:visible',
    ].join(", "),
  },

  timeout: {
    navigation: 30000,
    element: 20000,
    summary: 120000,
    polling: 2000,
  },
};
