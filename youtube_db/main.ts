import { initDoppler } from "./lib/doppler.ts";
import {
  queryAllPages,
  queryPageBatch,
  readUrl,
  readTitle,
  readTitleInlineUrl,
  readRelationIds,
  hasCover,
  hasIcon,
  uploadFile,
  setCoverFromUpload,
  setIconFromUpload,
  setTitle,
  hasPageSummary,
  appendPageSummary,
  setUrlProp,
  setRelation,
  trashPage,
  createChannelPage,
} from "./lib/notion.ts";
import type { PageObjectResponse } from "@notionhq/client";
import { createVideoSource } from "./lib/video-source.ts";
import type { ChannelInfo } from "./lib/video-source.ts";
import { launchBrowser } from "../ai_summary/src/browser.js";
import { openVideo, validateYouTubeUrl } from "../ai_summary/src/youtube.js";
import { summarizeVideo } from "../ai_summary/src/gemini.js";

await initDoppler();

// --- terminal styling (zero-dep ANSI) ---

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const sgr = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const c = {
  bold: sgr("1"),
  dim: sgr("2"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  gray: sgr("90"),
};

// visible length, ignoring ANSI escapes
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const padEnd = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visLen(s)));
const padStart = (s: string, w: number) => " ".repeat(Math.max(0, w - visLen(s))) + s;

function banner(title: string): void {
  const inner = ` ${title} `;
  const line = "─".repeat(visLen(inner));
  console.log(c.cyan(`┌${line}┐`));
  console.log(c.cyan("│") + c.bold(inner) + c.cyan("│"));
  console.log(c.cyan(`└${line}┘`));
}

// two-column key/value table; rows of [label, value, optional color fn]
function summaryTable(
  rows: [string, string, ((s: string) => string)?][],
  ruleBefore?: number,
): void {
  const labelW = Math.max(...rows.map((r) => visLen(r[0])));
  const valueW = Math.max(...rows.map((r) => visLen(r[1])));
  const top = `┌${"─".repeat(labelW + 2)}┬${"─".repeat(valueW + 2)}┐`;
  const mid = `├${"─".repeat(labelW + 2)}┼${"─".repeat(valueW + 2)}┤`;
  const bot = `└${"─".repeat(labelW + 2)}┴${"─".repeat(valueW + 2)}┘`;
  console.log(c.gray(top));
  rows.forEach(([label, value, paint], i) => {
    if (ruleBefore === i) console.log(c.gray(mid));
    const v = paint ? paint(padStart(value, valueW)) : padStart(value, valueW);
    console.log(
      c.gray("│ ") +
        c.bold(padEnd(label, labelW)) +
        c.gray(" │ ") +
        v +
        c.gray(" │"),
    );
  });
  console.log(c.gray(bot));
}

const YT_SOURCE = process.env.YT_SOURCE ?? "ytdlp";
if (YT_SOURCE === "youtube_api" && !process.env.YT_API_KEY) {
  throw new Error("YT_API_KEY is required when using YouTube Data API");
}
const { fetchVideoInfo, fetchChannelInfo } = createVideoSource(YT_SOURCE);

const VIDEOS_DS = process.env.NOTION_DATA_SOURCE_ID;
if (!VIDEOS_DS) throw new Error("NOTION_DATA_SOURCE_ID is required");
const CHANNELS_DS = process.env.NOTION_CHANNELS_DATA_SOURCE_ID;
if (!CHANNELS_DS) throw new Error("NOTION_CHANNELS_DATA_SOURCE_ID is required");

const LINK_PROP = process.env.NOTION_LINK_PROP || "Link";
const TITLE_PROP = process.env.NOTION_TITLE_PROP || "Name";
const CHANNEL_PAGE_PROP =
  process.env.NOTION_CHANNEL_PAGE_PROP || "Channel Page";
const CHANNEL_URL_PROP = "URL";
const CHANNEL_TITLE_PROP = "Name";

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").toLowerCase();
}

interface ChannelRecord {
  pageId: string;
  url: string;
  name: string;
  urlPropEmpty: boolean;
  titleHasInlineLink: boolean;
  iconMissing: boolean;
  coverMissing: boolean;
}

async function loadChannelIndex(): Promise<Map<string, ChannelRecord>> {
  const pages = await queryAllPages(CHANNELS_DS!);
  const idx = new Map<string, ChannelRecord>();
  for (const page of pages) {
    const urlProp = readUrl(page, CHANNEL_URL_PROP);
    const inlineUrl = readTitleInlineUrl(page, CHANNEL_TITLE_PROP);
    const url = urlProp || inlineUrl;
    if (!url) continue;
    idx.set(normalizeUrl(url), {
      pageId: page.id,
      url,
      name: readTitle(page, CHANNEL_TITLE_PROP),
      urlPropEmpty: !urlProp,
      titleHasInlineLink: !!inlineUrl,
      iconMissing: !hasIcon(page),
      coverMissing: !hasCover(page),
    });
  }
  return idx;
}

const channelInfoCache = new Map<string, ChannelInfo>();

async function getChannelInfoCached(channelUrl: string): Promise<ChannelInfo> {
  const key = normalizeUrl(channelUrl);
  let info = channelInfoCache.get(key);
  if (!info) {
    info = await fetchChannelInfo(channelUrl);
    channelInfoCache.set(key, info);
  }
  return info;
}

// Set a channel page's cover: the banner if the channel has one, otherwise
// fall back to the channel logo. Assumes the page has no cover yet (callers
// guard on coverMissing) so we never override an existing cover. Returns the
// source actually used. Flips rec.coverMissing on success.
async function ensureChannelCover(
  rec: ChannelRecord,
): Promise<"banner" | "logo"> {
  const cInfo = await getChannelInfoCached(rec.url);
  const useBanner = cInfo.bannerPath != null;
  const coverId = useBanner
    ? await uploadFile(cInfo.bannerPath!, "banner.jpg", "image/jpeg")
    : await uploadFile(cInfo.avatarPath, "avatar.jpg", "image/jpeg");
  await setCoverFromUpload(rec.pageId, coverId);
  rec.coverMissing = false;
  return useBanner ? "banner" : "logo";
}

async function resolveChannel(
  index: Map<string, ChannelRecord>,
  channelUrl: string,
  channelName: string,
): Promise<string> {
  const key = normalizeUrl(channelUrl);
  const existing = index.get(key);

  if (existing) {
    if (existing.urlPropEmpty) {
      await setUrlProp(existing.pageId, CHANNEL_URL_PROP, channelUrl);
      existing.urlPropEmpty = false;
      console.log(c.gray(`    ↳ channel URL backfilled`));
    }
    const wantTitleRewrite =
      (channelName && existing.name !== channelName) ||
      existing.titleHasInlineLink;
    if (wantTitleRewrite) {
      const finalName = channelName || existing.name;
      await setTitle(existing.pageId, CHANNEL_TITLE_PROP, finalName);
      if (existing.titleHasInlineLink) {
        console.log(c.gray(`    ↳ channel title stripped of inline link`));
      }
      if (channelName && existing.name !== channelName) {
        console.log(c.gray(`    ↳ channel renamed: ${existing.name} → ${channelName}`));
      }
      existing.name = finalName;
      existing.titleHasInlineLink = false;
    }
    if (existing.iconMissing || existing.coverMissing) {
      try {
        if (existing.iconMissing) {
          const cInfo = await getChannelInfoCached(channelUrl);
          const iconId = await uploadFile(
            cInfo.avatarPath,
            "avatar.jpg",
            "image/jpeg",
          );
          await setIconFromUpload(existing.pageId, iconId);
          existing.iconMissing = false;
          console.log(c.gray(`    ↳ channel icon set`));
        }
        if (existing.coverMissing) {
          const src = await ensureChannelCover(existing);
          console.log(
            c.gray(`    ↳ channel cover set${src === "logo" ? " from logo" : ""}`),
          );
        }
      } catch (err) {
        console.log(`    ${c.red("✗")} channel thumb error: ${(err as Error).message}`);
      }
    }
    return existing.pageId;
  }

  const cInfo = await getChannelInfoCached(channelUrl);
  const iconId = await uploadFile(cInfo.avatarPath, "avatar.jpg", "image/jpeg");
  // Always give the page a cover: banner if the channel has one, else the logo.
  const coverId = cInfo.bannerPath
    ? await uploadFile(cInfo.bannerPath, "banner.jpg", "image/jpeg")
    : await uploadFile(cInfo.avatarPath, "avatar.jpg", "image/jpeg");
  const newId = await createChannelPage({
    channelsDataSourceId: CHANNELS_DS!,
    videosDataSourceId: VIDEOS_DS!,
    titleProp: CHANNEL_TITLE_PROP,
    urlProp: CHANNEL_URL_PROP,
    channelPageProp: CHANNEL_PAGE_PROP,
    name: channelName || channelUrl,
    url: channelUrl,
    iconUploadId: iconId,
    coverUploadId: coverId,
  });
  console.log(`    ${c.green("✓")} channel created: ${channelName}`);
  index.set(key, {
    pageId: newId,
    url: channelUrl,
    name: channelName,
    urlPropEmpty: false,
    titleHasInlineLink: false,
    iconMissing: false,
    coverMissing: false,
  });
  return newId;
}

// A video is fully processed once the sync has filled everything it owns:
// title, cover, and the channel relation.
function videoProcessed(page: PageObjectResponse): boolean {
  return (
    hasCover(page) &&
    !!readTitle(page, TITLE_PROP) &&
    readRelationIds(page, CHANNEL_PAGE_PROP).length > 0
  );
}

// Trash duplicate video pages that share a Link. Keep the processed page(s);
// a freshly added, not-yet-processed duplicate is the one that gets removed.
// If a URL has no processed page at all, keep the first and trash the rest so
// we never leave duplicates behind. Returns the surviving pages.
async function dedupeVideos(
  pages: PageObjectResponse[],
): Promise<PageObjectResponse[]> {
  const groups = new Map<string, PageObjectResponse[]>();
  for (const page of pages) {
    const link = readUrl(page, LINK_PROP);
    if (!link) continue;
    const key = normalizeUrl(link);
    const group = groups.get(key);
    if (group) group.push(page);
    else groups.set(key, [page]);
  }

  const trashed = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const processed = group.filter(videoProcessed);
    const keep = processed.length > 0 ? processed : group.slice(0, 1);
    const keepIds = new Set(keep.map((p) => p.id));
    for (const page of group) {
      if (keepIds.has(page.id)) continue;
      try {
        await trashPage(page.id);
        trashed.add(page.id);
        console.log(
          `  ${c.yellow("⌫")} duplicate trashed  ${c.dim(readUrl(page, LINK_PROP))}`,
        );
      } catch (err) {
        console.log(`  ${c.red("✗")} trash error: ${(err as Error).message}`);
      }
    }
  }
  return pages.filter((p) => !trashed.has(p.id));
}

async function findPendingVideos(): Promise<PageObjectResponse[]> {
  const pending: PageObjectResponse[] = [];
  let cursor: string | undefined;

  for (;;) {
    const batch = await queryPageBatch(VIDEOS_DS!, 10, cursor);
    const eligible = batch.pages.filter((page) => readUrl(page, LINK_PROP));
    const unprocessed = eligible.filter((page) => !videoProcessed(page));
    pending.push(...unprocessed);

    if (unprocessed.length === 0 || unprocessed.length < eligible.length) {
      return pending;
    }
    if (!batch.nextCursor) return pending;
    cursor = batch.nextCursor;
  }
}

// --- run ---

banner("YouTube → Notion Sync");
console.log(c.dim(`  source: ${YT_SOURCE}`));
console.log();

const channelIndex = await loadChannelIndex();
console.log(`${c.cyan("●")} Channel index  ${c.bold(String(channelIndex.size))} channel(s)`);

// Backfill covers: any channel lacking a cover gets one (banner if available,
// else its logo). Idempotent — after the first pass nothing is missing, so
// later runs do no work and never override an existing cover.
let coversSet = 0;
for (const rec of channelIndex.values()) {
  if (!rec.coverMissing) continue;
  try {
    const src = await ensureChannelCover(rec);
    coversSet++;
    console.log(
      `  ${c.green("✓")} cover ${c.dim("←")} ${rec.name} ${c.gray(`(${src})`)}`,
    );
  } catch (err) {
    console.log(
      `  ${c.red("✗")} cover error (${rec.name}): ${(err as Error).message}`,
    );
  }
}
if (coversSet > 0) {
  console.log(`${c.cyan("●")} Channel covers ${c.bold(String(coversSet))} backfilled`);
}

const allVideos = await findPendingVideos();
console.log(`${c.cyan("●")} New video pages ${c.bold(String(allVideos.length))} found`);

const videos = await dedupeVideos(allVideos);
const duplicates = allVideos.length - videos.length;
if (duplicates > 0) {
  console.log(`${c.yellow("●")} Duplicates     ${c.bold(String(duplicates))} trashed`);
}

// Channel pages whose videos we touched this run; their Notion "Last edited
// time" is bumped to now after the loop (one write per channel).
const touchedChannels = new Set<string>();

let updated = 0;
let skipped = 0;
let failed = 0;
let summaryContext: Awaited<ReturnType<typeof launchBrowser>> | undefined;

for (const page of videos) {
  const link = readUrl(page, LINK_PROP);
  if (!link) {
    skipped++;
    continue;
  }

  const needsCover = !hasCover(page);
  const needsTitle = !readTitle(page, TITLE_PROP);
  const needsSummary = !(await hasPageSummary(page.id));
  const existingChannel = readRelationIds(page, CHANNEL_PAGE_PROP);
  const needsChannel = existingChannel.length === 0;

  if (!needsCover && !needsTitle && !needsChannel && !needsSummary) {
    skipped++;
    continue;
  }

  const wants = [
    needsCover && "cover",
    needsTitle && "title",
    needsChannel && "channel",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`\n${c.blue("→")} ${c.bold(link)}`);
  console.log(c.dim(`  fetching (${wants})`));

  let info;
  try {
    info = await fetchVideoInfo(link);
  } catch (err) {
    console.log(`  ${c.red("✗")} ${YT_SOURCE} error: ${(err as Error).message}`);
    failed++;
    continue;
  }

  let channelPageId = existingChannel[0];
  try {
    if (needsSummary) {
      summaryContext ??= await launchBrowser();
      const summaryPage = summaryContext.pages()[0] ?? await summaryContext.newPage();
      await openVideo(summaryPage, validateYouTubeUrl(link));
      const summary = await summarizeVideo(summaryPage, summaryContext);
      await appendPageSummary(page.id, summary);
      console.log(`  ${c.green("✓")} AI summary saved`);
    }
    if (needsTitle && info.title) {
      await setTitle(page.id, TITLE_PROP, info.title);
      console.log(`  ${c.green("✓")} title    ${c.dim("←")} ${info.title}`);
    }
    if (needsCover && info.thumbnail) {
      const uploadId = await uploadFile(
        info.thumbnail.path,
        info.thumbnail.filename,
      );
      await setCoverFromUpload(page.id, uploadId);
      console.log(`  ${c.green("✓")} cover    ${c.dim("←")} ${info.thumbnail.filename}`);
    }
    if (needsChannel && info.channelUrl) {
      channelPageId = await resolveChannel(
        channelIndex,
        info.channelUrl,
        info.channel,
      );
      await setRelation(page.id, CHANNEL_PAGE_PROP, [channelPageId]);
      console.log(`  ${c.green("✓")} channel  ${c.dim("←")} ${info.channel || info.channelUrl}`);
    }
    if (channelPageId) touchedChannels.add(channelPageId);
    updated++;
  } catch (err) {
    console.log(`  ${c.red("✗")} processing error: ${(err as Error).message}`);
    failed++;
  } finally {
    await info.cleanup();
  }
}

if (summaryContext) await summaryContext.close();

for (const info of channelInfoCache.values()) {
  await info.cleanup();
}

// Bump "Last edited time" to now for every channel we processed a video from.
// Re-writing the URL property to its current value is the cheapest real edit
// that updates the page's last_edited_time.
const urlByChannelId = new Map<string, string>();
for (const rec of channelIndex.values()) urlByChannelId.set(rec.pageId, rec.url);

let touched = 0;
for (const id of touchedChannels) {
  const url = urlByChannelId.get(id);
  if (!url) continue; // channel page not URL-indexed; nothing to re-write
  try {
    await setUrlProp(id, CHANNEL_URL_PROP, url);
    touched++;
  } catch (err) {
    console.log(`  ${c.red("✗")} channel touch error: ${(err as Error).message}`);
  }
}

const now = new Date();
console.log();
summaryTable(
  [
    ["Updated", String(updated), updated > 0 ? c.green : c.gray],
    ["Skipped", String(skipped), c.yellow],
    ["Duplicates", String(duplicates), duplicates > 0 ? c.yellow : c.gray],
    ["Failed", String(failed), failed > 0 ? c.red : c.gray],
    ["Channels bumped", String(touched), touched > 0 ? c.green : c.gray],
    ["Total", String(videos.length), c.bold],
  ],
  5,
);
console.log(c.dim(`  last run: ${now.toLocaleString()}`));
