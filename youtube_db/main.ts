import {
  queryAllPages,
  readUrl,
  readTitle,
  readSelect,
  hasCover,
  uploadFile,
  setCoverFromUpload,
  setTitle,
  setSelect,
} from "./lib/notion.ts";
import { fetchVideoInfo } from "./lib/ytdlp.ts";

const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
if (!DATA_SOURCE_ID) throw new Error("NOTION_DATA_SOURCE_ID is required");

const LINK_PROP = process.env.NOTION_LINK_PROP || "Link";
const TITLE_PROP = process.env.NOTION_TITLE_PROP || "Name";
const CHANNEL_PROP = process.env.NOTION_CHANNEL_PROP || "Channel";

const pages = await queryAllPages(DATA_SOURCE_ID);
console.log(`Found ${pages.length} page(s) in data source`);

let updated = 0;
let skipped = 0;
let failed = 0;

for (const page of pages) {
  const link = readUrl(page, LINK_PROP);
  if (!link) {
    skipped++;
    continue;
  }

  const needsCover = !hasCover(page);
  const needsTitle = !readTitle(page, TITLE_PROP);
  const needsChannel = !readSelect(page, CHANNEL_PROP);

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
    console.log(`  yt-dlp error: ${(err as Error).message}`);
    failed++;
    continue;
  }

  try {
    if (needsTitle && info.title) {
      await setTitle(page.id, TITLE_PROP, info.title);
      console.log(`  title  ← ${info.title}`);
    }
    if (needsChannel && info.channel) {
      await setSelect(page.id, CHANNEL_PROP, info.channel);
      console.log(`  channel ← ${info.channel}`);
    }
    if (needsCover && info.thumbnail) {
      const uploadId = await uploadFile(
        info.thumbnail.path,
        info.thumbnail.filename,
      );
      await setCoverFromUpload(page.id, uploadId);
      console.log(`  cover  ← ${info.thumbnail.filename}`);
    }
    updated++;
  } catch (err) {
    console.log(`  notion error: ${(err as Error).message}`);
    failed++;
  } finally {
    await info.cleanup();
  }
}

console.log(
  `\nDone. updated=${updated} skipped=${skipped} failed=${failed} total=${pages.length}`,
);
