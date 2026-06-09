import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = process.env.YT_API_KEY;
const API_BASE = "https://www.googleapis.com/youtube/v3";

export interface Thumbnail {
  path: string;
  filename: string;
}

export interface VideoInfo {
  title: string;
  channel: string;
  channelUrl: string;
  thumbnail: Thumbnail | null;
  cleanup: () => Promise<void>;
}

interface YtThumbEntry {
  url: string;
  width?: number;
  height?: number;
}

interface ChannelInfoResult {
  avatarPath: string;
  bannerPath: string | null;
  cleanup: () => Promise<void>;
}

function extractVideoId(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  throw new Error(`could not extract video ID from: ${url}`);
}

function extractChannelId(url: string): string {
  const m = url.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error(`could not extract channel ID from: ${url}`);
  return m[1];
}

export async function fetchVideoInfo(url: string): Promise<VideoInfo> {
  if (!API_KEY) throw new Error("YT_API_KEY is required for YouTube API mode");

  const videoId = extractVideoId(url);
  const dir = await mkdtemp(join(tmpdir(), "yt-info-"));
  try {
    const apiUrl = `${API_BASE}/videos?part=snippet&id=${videoId}&key=${API_KEY}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
    const data = (await res.json()) as {
      items?: { snippet?: { title?: string; channelTitle?: string; channelId?: string; thumbnails?: Record<string, YtThumbEntry> } }[];
    };
    const item = data.items?.[0];
    if (!item?.snippet) throw new Error(`video not found: ${videoId}`);

    const s = item.snippet;
    const title = s.title ?? "";
    const channel = s.channelTitle ?? "";
    const channelUrl = `https://www.youtube.com/channel/${s.channelId ?? ""}`;

    const thumbs = s.thumbnails ?? {};
    const thumbUrl = thumbs.maxres?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url;

    let thumbnail: Thumbnail | null = null;
    if (thumbUrl) {
      const thumbPath = join(dir, "thumb.jpg");
      const img = await fetch(thumbUrl);
      if (img.ok) {
        await writeFile(thumbPath, new Uint8Array(await img.arrayBuffer()));
        thumbnail = { path: thumbPath, filename: "thumb.jpg" };
      }
    }

    return {
      title,
      channel,
      channelUrl,
      thumbnail,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function fetchChannelInfo(channelUrl: string): Promise<ChannelInfoResult> {
  if (!API_KEY) throw new Error("YT_API_KEY is required for YouTube API mode");

  const channelId = extractChannelId(channelUrl);
  const dir = await mkdtemp(join(tmpdir(), "yt-channel-"));
  try {
    const apiUrl = `${API_BASE}/channels?part=snippet,brandingSettings&id=${channelId}&key=${API_KEY}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
    const data = (await res.json()) as {
      items?: { snippet?: { thumbnails?: Record<string, YtThumbEntry> }; brandingSettings?: { image?: { bannerExternalUrl?: string } } }[];
    };
    const item = data.items?.[0];
    if (!item) throw new Error(`channel not found: ${channelId}`);

    const thumbs = item.snippet?.thumbnails ?? {};
    const avatarUrl = thumbs.high?.url ?? thumbs.default?.url;
    if (!avatarUrl) throw new Error("no avatar thumbnail found");

    const avatarPath = join(dir, "avatar.jpg");
    const avatarRes = await fetch(avatarUrl);
    if (!avatarRes.ok) throw new Error(`avatar download ${avatarRes.status}`);
    await writeFile(avatarPath, new Uint8Array(await avatarRes.arrayBuffer()));

    let bannerPath: string | null = null;
    const bannerUrl = item.brandingSettings?.image?.bannerExternalUrl;
    if (bannerUrl) {
      bannerPath = join(dir, "banner.jpg");
      const bannerRes = await fetch(bannerUrl);
      if (bannerRes.ok) {
        await writeFile(bannerPath, new Uint8Array(await bannerRes.arrayBuffer()));
      } else {
        bannerPath = null;
      }
    }

    return {
      avatarPath,
      bannerPath,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}
