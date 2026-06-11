import {
  queryAllPages,
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
  setUrlProp,
  setRelation,
  createChannelPage,
} from "./lib/notion.ts";
import { createVideoSource } from "./lib/video-source.ts";
import type { ChannelInfo } from "./lib/video-source.ts";

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
        const cInfo = await getChannelInfoCached(channelUrl);
        if (existing.iconMissing) {
          const iconId = await uploadFile(
            cInfo.avatarPath,
            "avatar.jpg",
            "image/jpeg",
          );
          await setIconFromUpload(existing.pageId, iconId);
          existing.iconMissing = false;
          console.log(c.gray(`    ↳ channel icon set`));
        }
        if (existing.coverMissing && cInfo.bannerPath) {
          const coverId = await uploadFile(
            cInfo.bannerPath,
            "banner.jpg",
            "image/jpeg",
          );
          await setCoverFromUpload(existing.pageId, coverId);
          existing.coverMissing = false;
          console.log(c.gray(`    ↳ channel cover set`));
        }
      } catch (err) {
        console.log(`    ${c.red("✗")} channel thumb error: ${(err as Error).message}`);
      }
    }
    return existing.pageId;
  }

  const cInfo = await getChannelInfoCached(channelUrl);
  const iconId = await uploadFile(cInfo.avatarPath, "avatar.jpg", "image/jpeg");
  const coverId = cInfo.bannerPath
    ? await uploadFile(cInfo.bannerPath, "banner.jpg", "image/jpeg")
    : null;
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
    name: channelName,
    urlPropEmpty: false,
    titleHasInlineLink: false,
    iconMissing: false,
    coverMissing: !coverId,
  });
  return newId;
}

// --- run ---

banner("YouTube → Notion Sync");
console.log(c.dim(`  source: ${YT_SOURCE}`));
console.log();

const channelIndex = await loadChannelIndex();
console.log(`${c.cyan("●")} Channel index  ${c.bold(String(channelIndex.size))} channel(s)`);

const videos = await queryAllPages(VIDEOS_DS);
console.log(`${c.cyan("●")} Video pages    ${c.bold(String(videos.length))} found`);

let updated = 0;
let skipped = 0;
let failed = 0;

for (const page of videos) {
  const link = readUrl(page, LINK_PROP);
  if (!link) {
    skipped++;
    continue;
  }

  const needsCover = !hasCover(page);
  const needsTitle = !readTitle(page, TITLE_PROP);
  const needsChannel = readRelationIds(page, CHANNEL_PAGE_PROP).length === 0;

  if (!needsCover && !needsTitle && !needsChannel) {
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

  try {
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
      const channelPageId = await resolveChannel(
        channelIndex,
        info.channelUrl,
        info.channel,
      );
      await setRelation(page.id, CHANNEL_PAGE_PROP, [channelPageId]);
      console.log(`  ${c.green("✓")} channel  ${c.dim("←")} ${info.channel || info.channelUrl}`);
    }
    updated++;
  } catch (err) {
    console.log(`  ${c.red("✗")} notion error: ${(err as Error).message}`);
    failed++;
  } finally {
    await info.cleanup();
  }
}

for (const info of channelInfoCache.values()) {
  await info.cleanup();
}

const now = new Date();
console.log();
summaryTable(
  [
    ["Updated", String(updated), updated > 0 ? c.green : c.gray],
    ["Skipped", String(skipped), c.yellow],
    ["Failed", String(failed), failed > 0 ? c.red : c.gray],
    ["Total", String(videos.length), c.bold],
  ],
  3,
);
console.log(c.dim(`  last run: ${now.toLocaleString()}`));
