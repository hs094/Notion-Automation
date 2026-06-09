import {
  fetchVideoInfo as ytFetchVideoInfo,
  fetchChannelInfo as ytFetchChannelInfo,
} from "./ytdlp.ts";
import {
  fetchVideoInfo as apiFetchVideoInfo,
  fetchChannelInfo as apiFetchChannelInfo,
} from "./youtube-api.ts";

const source = process.env.YT_SOURCE ?? "ytdlp";

const useApi = source === "youtube_api";

export const fetchVideoInfo = useApi ? apiFetchVideoInfo : ytFetchVideoInfo;
export const fetchChannelInfo = useApi ? apiFetchChannelInfo : ytFetchChannelInfo;

export type { VideoInfo, ChannelInfo, Thumbnail } from "./ytdlp.ts";
