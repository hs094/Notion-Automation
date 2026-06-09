import {
  fetchVideoInfo as ytFetchVideoInfo,
  fetchChannelInfo as ytFetchChannelInfo,
} from "./ytdlp.ts";
import {
  fetchVideoInfo as apiFetchVideoInfo,
  fetchChannelInfo as apiFetchChannelInfo,
} from "./youtube-api.ts";

// Auto-detect GitHub Actions (GITHUB_ACTIONS=true is set by the runner).
// Override with YT_SOURCE=ytdlp to force yt-dlp even in CI.
const inGitHubActions = process.env.GITHUB_ACTIONS === "true";
const source = process.env.YT_SOURCE ?? (inGitHubActions ? "youtube_api" : "ytdlp");

const useApi = source === "youtube_api";

export const fetchVideoInfo = useApi ? apiFetchVideoInfo : ytFetchVideoInfo;
export const fetchChannelInfo = useApi ? apiFetchChannelInfo : ytFetchChannelInfo;

export type { VideoInfo, ChannelInfo, Thumbnail } from "./ytdlp.ts";
