# Architecture (work in progress)

> Living doc capturing the target shape. Today only the **Videos** module exists; the rest is planned.

## Goal

Three views of YouTube consumption in Notion, all kept in sync from one trigger: adding a `Link`.

1. **Videos** — every video I add or watch
2. **Channels** — every channel I've pulled a video from
3. **Playlists** — every playlist I track, with each video's position inside it

## Data model

Three Notion databases, linked by relations.

### Videos DB (exists)

| Property        | Type                 | Filled by         | Notes                                     |
| --------------- | -------------------- | ----------------- | ----------------------------------------- |
| `Name`          | title                | `video-sync`      | from yt-dlp                               |
| `Link`          | url                  | **me**            | required trigger — everything keys off it |
| `Channel Page`  | relation → Channels  | `channel-sync`    | canonical link to the Channel page; the only place channel info lives on a video |
| `Tags`          | multi_select         | me                | untouched by scripts                      |
| `cover`         | file                 | `video-sync`      | uploaded thumbnail                        |

### Channels DB

One page per channel. Intentionally thin. The relation between Channels and Videos is **one-way**: it lives on the Videos side (`Channel Page`). Channels just store metadata + a count.

| Property / field | Type            | Notes                                                                                            |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `Name`           | title           | plain text channel name (no inline link)                                                         |
| `URL`            | url             | channel URL                                                                                      |
| `Videos`         | number          | count of Video pages whose `Channel Page` points here; recomputed each run                       |
| `Description`    | rich_text       | unused for now                                                                                   |
| `Tags`           | multi_select    | unused for now                                                                                   |
| page `icon`      | file (uploaded) | channel **avatar** (`avatar_uncropped` or largest square)                                        |
| page `cover`     | file (uploaded) | channel **banner** (`banner_uncropped` or largest landscape); skipped if the channel has none    |

Inside each channel page: a **linked view of Videos DB filtered by `Channel Page == self`**, configured manually in Notion. The page exists so the view has a home; the script does not create or maintain that view.

**Upsert key:** channel URL — read from the `URL` rich_text property, falling back to the inline link embedded in `Name` for any legacy rows. The script backfills `URL` from the inline link and strips the link from the title, migrating legacy rows on first touch.

**Name reconciliation:** yt-dlp's `channel` (with `uploader` fallback) is the canonical name. If an existing channel page's `Name` differs, the script rewrites the title to match. Drift flows one way: yt-dlp → Notion.

**Count maintenance:** after the per-video loop finishes, the script tallies every video's resolved `Channel Page` and writes the count back to each channel's `Videos` number — but only when it differs from what's already there, to avoid no-op writes.

### Playlists DB (planned)

Playlists are many-to-many with videos and carry an order, so they need a join.

**Playlists DB**

| Property | Type | Notes |
| --- | --- | --- |
| `Name`   | title | playlist title |
| `URL`    | url   | playlist URL |
| `Channel Page` | relation → Channels | owning channel (optional) |

**PlaylistEntries DB** (join: a row per video-in-playlist)

| Property | Type | Notes |
| --- | --- | --- |
| `Playlist` | relation → Playlists | |
| `Video`    | relation → Videos    | |
| `Index`    | number               | `playlist_index` from yt-dlp |

Same video can appear in multiple playlists with different indices — that's why this is a separate DB rather than a property on Videos.

## Modules

Each module is its own entrypoint under `youtube_db/`, sharing `lib/`. A module only writes to the DBs it owns; reads from others are read-only.

### `video-sync` — `main.ts` (exists)

Trigger: any Videos page that has a `Link`.
For each such page, if `cover` or `Name` is missing, fetch via yt-dlp and fill it in. Idempotent — re-runs only touch incomplete pages.

Channel info is intentionally **not** written here; it's resolved by `channel-sync` (which also fetches yt-dlp). Both modules share the same fetch when run together by `sync:all`.

### `channel-sync` (planned)

Trigger: any Videos page with a `Link` whose `Channel Page` relation is empty.

Steps per page:
1. Get the canonical channel URL + name from yt-dlp (`channel_url`, `channel` / `uploader`).
2. Look up the Channel in Channels DB:
   - first by `URL` property
   - then by URL embedded in the title's inline link (legacy rows)
3. If found:
   - if `URL` is empty, backfill it from the inline link
   - if `Name` differs from yt-dlp's, **or** the title still carries an inline link, rewrite the title as plain text
   - if page `icon` is empty, fill it with the channel avatar (see below)
   - if page `cover` is empty, fill it with the channel banner (see below)
4. If not found, create a new Channel page with plain-text `Name`, `URL`, avatar icon, and banner cover.
5. Set `Channel Page` on the Video to point at the resolved page.

After all videos are processed, recount every channel's videos (by tallying `Channel Page` across the Videos DB plus any relations we set this run) and write the result to `Videos` (number) on each Channel page whose count drifted.

**Channel thumbnails:** a separate yt-dlp call against the channel URL
(`yt-dlp --playlist-items 0 --write-thumbnail --skip-download --convert-thumbnails jpg <channel_url>`)
yields multiple thumbnails. Pick the highest-resolution `avatar*` for the icon and
`banner*` for the cover (banner is optional — some channels don't have one).
Both get uploaded to Notion via `lib/notion.ts`'s `uploadFile` and attached via
`pages.update({ icon: …, cover: … })`.

**Cache discipline:** channel-thumbnail fetches are per-channel, not per-video.
Resolve channels once per run, keyed by URL, so a popular channel's avatar isn't
re-downloaded for every video it owns.

Decoupled from `video-sync` so adding the Channels DB doesn't force a rewrite of the video flow.

### `playlist-sync` (planned)

Input: a watchlist of playlist URLs (env / config / a "Playlists" seed DB — TBD).
Steps per playlist URL:
1. `yt-dlp --flat-playlist --dump-json <url>` → entries with `id`, `title`, `url`, `playlist_index`.
2. Upsert the Playlist page.
3. For each entry:
   - Upsert a Video page (just `Link` if it's new — `video-sync` will fill the rest on its next pass).
   - Upsert a PlaylistEntry row (`Playlist`, `Video`, `Index`).

## Orchestration

Run order matters because modules feed each other:

```
sync:videos     →  fills metadata for any video that has a Link
sync:channels   →  resolves Channel relation for videos with a channel name
sync:playlists  →  ingests playlist URLs, seeds Video pages, links entries
sync:all        →  runs the three above, in order
```

Cron runs `sync:all`. Modules are individually invokable for debugging.

## Shared `lib/`

- `lib/notion.ts` — client, paginated query, typed read/write helpers per property type. Extend with `setRelation`, `findPageByTitle`, `createPage` as channel/playlist modules need them.
- `lib/ytdlp.ts` — yt-dlp wrappers. Today: `fetchVideoInfo(url)`. Add `fetchChannelInfo(channelUrl)` (returns avatar + banner paths) and `fetchPlaylistEntries(url)` for playlists; all share the same temp-dir + cleanup discipline.
- `lib/retry.ts` — shared backoff for Notion 429/5xx; no module-specific logic here.

## Open questions

- **Video seeding:** today I add videos manually. Should `playlist-sync` be the only auto-creator, or is there a "watch later" feed to pull from too?
- **Channel-owned playlists:** worth filling `Playlists.Channel Page`, or is that noise?
- **Folder name:** `youtube_db/` made sense when it was one DB. Once channels/playlists land, rename to `youtube/` with `videos/`, `channels/`, `playlists/` subfolders, or keep modules flat? Lean: flat until it hurts.
