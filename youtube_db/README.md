# youtube_db

Sync a Notion database of YouTube videos with metadata pulled from yt-dlp. For every video page whose `Link` is set, the script fills in:

- **video title** (`Name`)
- **video cover** (thumbnail upload)
- **channel relation** (`Channel Page`) — looks up the channel in a separate Channels DB, creating it if missing, with the channel's **avatar as page icon** and **banner as page cover**

Idempotent: re-runs only touch fields that are still empty.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the broader plan (channels, planned playlists, module boundaries).

## Layout

```
youtube_db/
├── main.ts             # entrypoint — Notion orchestration
├── lib/
│   ├── notion.ts       # Notion client + typed read/write helpers
│   ├── ytdlp.ts        # yt-dlp metadata + channel thumbnails
│   └── retry.ts        # shared backoff/retry helpers
├── ARCHITECTURE.md
├── .env.example
└── README.md
```

`main.ts` is the only file that knows the workflow. `lib/` modules expose small, reusable helpers — extend by adding new read/write helpers and a new check in the main loop.

## Requirements

- [Bun](https://bun.sh) — `bun --version`
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on `PATH`
- A Notion integration with **read+write access to both data sources** (Videos and Channels)

## Env

```env
NOTION_API_KEY=secret_...
NOTION_DATA_SOURCE_ID=...                 # Videos DS
NOTION_CHANNELS_DATA_SOURCE_ID=...        # Channels DS

# optional overrides — defaults shown
NOTION_LINK_PROP=Link
NOTION_TITLE_PROP=Name
NOTION_CHANNEL_PAGE_PROP=Channel Page
```

See [`.env.example`](./.env.example). Bun auto-loads `.env` from the repo root.

## Notion schema

**Videos DS**

| Property              | Type                   | Filled by script               |
| --------------------- | ---------------------- | ------------------------------ |
| `Link`                | URL                    | no (trigger — must be present) |
| `Name`                | Title                  | yes — from yt-dlp `title`      |
| `Channel Page`        | Relation → Channels DS | yes — single resolved channel  |
| page `cover`          | file                   | yes — video thumbnail          |

**Channels DS**

| Property / field | Type            | Filled by script                                                                   |
| ---------------- | --------------- | ---------------------------------------------------------------------------------- |
| `Name`           | Title           | yes — plain text channel name (no inline link)                                     |
| `URL`            | URL             | yes — channel URL; backfilled from inline-link in title on legacy rows             |
| `Videos`         | Number          | yes — count of Video pages whose `Channel Page` relation points here               |
| page `icon`      | file            | yes — channel avatar (`avatar_uncropped`)                                          |
| page `cover`     | file            | yes — channel banner (`banner_uncropped`), if present                              |

The script never overwrites a channel field that's already populated, except for `Name` (which it reconciles against yt-dlp's canonical name) and `Videos` (which it recomputes every run).

The relation between Channels and Videos is **one-way**, lives only on the Videos side (`Channel Page` → Channels). Inside each Channel page in Notion, configure a **linked view of the Videos DB filtered by `Channel Page == this`** — that's a manual one-time setup; the script doesn't create the view.

## Run

```sh
bun run sync:youtube
# or
bun run youtube_db/main.ts
```

## Cron

```cron
*/30 * * * * cd /path/to/Notion-Automation && /opt/homebrew/bin/bun run sync:youtube >> /tmp/notion-youtube.log 2>&1
```

## Behavior

Per video page:

1. Skip if `Link` is empty.
2. Skip if `Name`, `cover`, and `Channel Page` are all already set.
3. One yt-dlp call extracts title, channel name, channel URL, and the video thumbnail.
4. Fill `Name` and `cover` if missing.
5. Resolve the channel:
   - look up the Channel page by `URL`, falling back to the inline-link URL inside the title for legacy rows
   - if found: backfill `URL` if empty, strip any inline link from the title, rename if the name drifted, add icon/cover if missing
   - if missing: create a new Channel page with plain-text name, URL, icon, and (when available) cover
6. Set `Channel Page` relation on the video.

After the per-video loop, the script tallies each channel's videos (including ones it just linked this run) and writes `Videos` (number) on every channel whose count drifted.

Channel-thumbnail fetches are cached per run by channel URL, so a single channel referenced by many videos is only downloaded once.

Retries on 429 / 5xx with jittered backoff (max 6 attempts). Final line of output: `updated=… skipped=… failed=… total=…`.

## Extending

To sync another field on Videos (e.g. duration, published date):

1. Add a `read<Type>` / `set<Type>` helper to `lib/notion.ts` if one doesn't exist.
2. Add the field to the `--print` template in `lib/ytdlp.ts` and the returned `VideoInfo`.
3. In `main.ts`, add a `needsX` check and the matching write call inside the per-video `try` block.
