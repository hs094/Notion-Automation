import { $ } from "bun";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TITLE_FMT = "%(title)s";
const CHANNEL_FMT = "%(channel,uploader)s";

export interface Thumbnail {
  path: string;
  filename: string;
}

export interface VideoInfo {
  title: string;
  channel: string;
  thumbnail: Thumbnail | null;
  cleanup: () => Promise<void>;
}

export async function fetchVideoInfo(url: string): Promise<VideoInfo> {
  const dir = await mkdtemp(join(tmpdir(), "yt-info-"));
  try {
    const proc =
      await $`yt-dlp --no-simulate --write-thumbnail --skip-download --convert-thumbnails jpg --print ${TITLE_FMT} --print ${CHANNEL_FMT} -o ${join(dir, "thumb.%(ext)s")} ${url}`.quiet();
    const [title = "", channel = ""] = proc
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
      thumbnail,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
