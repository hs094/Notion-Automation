
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { launchBrowser } from "./browser.js";
import { openVideo, validateYouTubeUrl } from "./youtube.js";
import { summarizeVideo } from "./gemini.js";

async function waitForEnter(message: string) {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

async function main() {
  const [mode, input] = process.argv.slice(2);

  if (!["login", "open"].includes(mode)) {
    throw new Error(
      "Usage: pnpm exec tsx src/index.ts <login|open> [url]"
    );
  }

  // Validate before launching the browser.
  const url =
    mode === "open" ? validateYouTubeUrl(input) : undefined;

  if (mode === "open" && !url) {
    throw new Error("YouTube URL required");
  }

  const context = await launchBrowser();

  try {
    const page = context.pages()[0] ?? await context.newPage();

    if (mode === "login") {
      await page.goto("https://accounts.google.com/");

      await waitForEnter(
        "Complete Google login, then press Enter..."
      );

      return;
    }

    if (!url) throw new Error("YouTube URL required");

    await openVideo(page, url);

    const summary = await summarizeVideo(page, context);

    console.log("\n--- Gemini Summary ---\n");
    console.log(summary);

    // Browser will exit after logging, no file storage
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

