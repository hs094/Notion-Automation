import { $ } from "bun";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TITLE_FMT = "%(title)s";
const CHANNEL_FMT = "%(channel,uploader)s";
const CHANNEL_URL_FMT = "%(channel_url,uploader_url)s";

export interface Thumbnail {
  path: string;
  filename: string;
}

interface ShellError {
  exitCode?: number;
  stderr?: Buffer;
  message: string;
}

function ytdlpError(err: unknown): Error {
  const e = err as ShellError;
  const stderr = e.stderr?.toString().trim();
  if (stderr) {
    const lastLine = stderr.split("\n").filter(Boolean).at(-1) ?? stderr;
    return new Error(lastLine);
  }
  return new Error(e.message ?? String(err));
}

export interface VideoInfo {
  title: string;
  channel: string;
  channelUrl: string;
  thumbnail: Thumbnail | null;
  cleanup: () => Promise<void>;
}

export async function fetchVideoInfo(url: string): Promise<VideoInfo> {
  const dir = await mkdtemp(join(tmpdir(), "yt-info-"));
  try {
    let proc;
    try {
      proc =
        await $`yt-dlp --no-simulate --write-thumbnail --skip-download --convert-thumbnails jpg --print ${TITLE_FMT} --print ${CHANNEL_FMT} --print ${CHANNEL_URL_FMT} -o ${join(dir, "thumb.%(ext)s")} ${url}`.quiet();
    } catch (err) {
      throw ytdlpError(err);
    }
    const [title = "", channel = "", channelUrl = ""] = proc
      .text()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const files = await readdir(dir);
    const thumb = files.find((f) => f.startsWith("thumb."));
    const thumbnail: Thumbnail | null = thumb
      ? { path: join(dir, thumb), filename: thumb }
      : null;

    return {
      title,
      channel,
      channelUrl,
      thumbnail,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

// --- channel thumbnails ---

interface YtThumb {
  id?: string;
  url: string;
  width?: number;
  height?: number;
}

function area(t: YtThumb): number {
  return (t.width ?? 0) * (t.height ?? 0);
}

function pickByIdOrShape(
  thumbs: YtThumb[],
  idMarker: string,
  shape: (t: YtThumb) => boolean,
): YtThumb | undefined {
  const exact = thumbs.find((t) => t.id === idMarker);
  if (exact) return exact;
  return thumbs.filter(shape).sort((a, b) => area(b) - area(a))[0];
}

async function downloadTo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`thumbnail download ${res.status}`);
  await writeFile(outPath, new Uint8Array(await res.arrayBuffer()));
}

export interface ChannelInfo {
  avatarPath: string;
  bannerPath: string | null;
  cleanup: () => Promise<void>;
}

export async function fetchChannelInfo(channelUrl: string): Promise<ChannelInfo> {
  const dir = await mkdtemp(join(tmpdir(), "yt-channel-"));
  try {
    let proc;
    try {
      proc =
        await $`yt-dlp --playlist-items 0 --dump-single-json ${channelUrl}`.quiet();
    } catch (err) {
      throw ytdlpError(err);
    }
    const meta = JSON.parse(proc.text()) as { thumbnails?: YtThumb[] };
    const thumbs = meta.thumbnails ?? [];

    const avatar = pickByIdOrShape(
      thumbs,
      "avatar_uncropped",
      (t) =>
        typeof t.width === "number" &&
        typeof t.height === "number" &&
        t.width === t.height,
    );
    if (!avatar) throw new Error("no avatar thumbnail found");

    const banner = pickByIdOrShape(
      thumbs,
      "banner_uncropped",
      (t) =>
        typeof t.width === "number" &&
        typeof t.height === "number" &&
        t.width > t.height * 2,
    );

    const avatarPath = join(dir, "avatar.jpg");
    await downloadTo(avatar.url, avatarPath);

    let bannerPath: string | null = null;
    if (banner) {
      bannerPath = join(dir, "banner.jpg");
      await downloadTo(banner.url, bannerPath);
    }

    return {
      avatarPath,
      bannerPath,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
