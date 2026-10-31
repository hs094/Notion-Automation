import type { Page } from "playwright";
import { config } from "./config.js";

export function validateYouTubeUrl(input: string): URL {
  const url = new URL(input);

  const allowedHosts = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
  ];

  if (
    url.protocol !== "https:" ||
    !allowedHosts.includes(url.hostname)
  ) {
    throw new Error("Invalid YouTube URL");
  }

  return url;
}

export function getVideoId(url: URL): string {
  const id =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : url.searchParams.get("v");

  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new Error("Invalid YouTube video ID");
  }

  return id;
}

export async function openVideo(page: Page, url: URL) {
  console.log(`Opening: ${url.href}`);

  await page.goto(url.href, {
    waitUntil: "domcontentloaded",
    timeout: config.timeout.navigation,
  });
}
