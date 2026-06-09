import {
  fetchVideoInfo as ytFetchVideoInfo,
  fetchChannelInfo as ytFetchChannelInfo,
} from "./ytdlp.ts";
import {
  fetchVideoInfo as apiFetchVideoInfo,
  fetchChannelInfo as apiFetchChannelInfo,
} from "./youtube-api.ts";

export function createVideoSource(source: string) {
  const useApi = source === "youtube_api";
  return {
    fetchVideoInfo: useApi ? apiFetchVideoInfo : ytFetchVideoInfo,
    fetchChannelInfo: useApi ? apiFetchChannelInfo : ytFetchChannelInfo,
  };
}

export type { VideoInfo, ChannelInfo, Thumbnail } from "./ytdlp.ts";
