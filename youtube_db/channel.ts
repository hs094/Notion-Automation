// Backfill script: create a filtered video gallery view inside every
// existing channel page. New channels get this view automatically at
// creation time (see createChannelPage in lib/notion.ts).
import { queryAllPages, readTitle, createChannelVideoView } from "./lib/notion.ts";

const channelsDataSourceId = process.env.NOTION_CHANNELS_DATA_SOURCE_ID;
if (!channelsDataSourceId)
  throw new Error("NOTION_CHANNELS_DATA_SOURCE_ID is required");
const videosDataSourceId = process.env.NOTION_DATA_SOURCE_ID;
if (!videosDataSourceId) throw new Error("NOTION_DATA_SOURCE_ID is required");

const pages = await queryAllPages(channelsDataSourceId);
let cnt = 0;
for (const page of pages) {
  cnt++;
  await createChannelVideoView({
    videosDataSourceId,
    channelPageId: page.id,
    channelPageProp: "Channel Page",
    name: readTitle(page, "Name"),
  });
  console.log("Done: " + cnt + "/" + pages.length);
}

