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
      console.log(`    channel URL backfilled`);
    }
    const wantTitleRewrite =
      (channelName && existing.name !== channelName) ||
      existing.titleHasInlineLink;
    if (wantTitleRewrite) {
      const finalName = channelName || existing.name;
      await setTitle(existing.pageId, CHANNEL_TITLE_PROP, finalName);
      if (existing.titleHasInlineLink) {
        console.log(`    channel title stripped of inline link`);
      }
      if (channelName && existing.name !== channelName) {
        console.log(`    channel renamed: ${existing.name} → ${channelName}`);
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
          console.log(`    channel icon set`);
        }
        if (existing.coverMissing && cInfo.bannerPath) {
          const coverId = await uploadFile(
            cInfo.bannerPath,
            "banner.jpg",
            "image/jpeg",
          );
          await setCoverFromUpload(existing.pageId, coverId);
          existing.coverMissing = false;
          console.log(`    channel cover set`);
        }
      } catch (err) {
        console.log(`    channel thumb error: ${(err as Error).message}`);
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
  console.log(`    channel created: ${channelName}`);
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

const channelIndex = await loadChannelIndex();
console.log(`Channel index: ${channelIndex.size} channel(s)`);

const videos = await queryAllPages(VIDEOS_DS);
console.log(`Found ${videos.length} video page(s)`);

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
  console.log(`\n→ ${link}\n  fetching (${wants})`);

  let info;
  try {
    info = await fetchVideoInfo(link);
  } catch (err) {
    console.log(`  ${YT_SOURCE} error: ${(err as Error).message}`);
    failed++;
    continue;
  }

  try {
    if (needsTitle && info.title) {
      await setTitle(page.id, TITLE_PROP, info.title);
      console.log(`  title  ← ${info.title}`);
    }
    if (needsCover && info.thumbnail) {
      const uploadId = await uploadFile(
        info.thumbnail.path,
        info.thumbnail.filename,
      );
      await setCoverFromUpload(page.id, uploadId);
      console.log(`  cover  ← ${info.thumbnail.filename}`);
    }
    if (needsChannel && info.channelUrl) {
      const channelPageId = await resolveChannel(
        channelIndex,
        info.channelUrl,
        info.channel,
      );
      await setRelation(page.id, CHANNEL_PAGE_PROP, [channelPageId]);
      console.log(`  channel relation ← ${info.channel || info.channelUrl}`);
    }
    updated++;
  } catch (err) {
    console.log(`  notion error: ${(err as Error).message}`);
    failed++;
  } finally {
    await info.cleanup();
  }
}

const now = new Date();
console.log("Last Run on: " + now.toLocaleString())

for (const info of channelInfoCache.values()) {
  await info.cleanup();
}

console.log(
  `\nDone. updated=${updated} skipped=${skipped} failed=${failed} total=${videos.length}`,
);
