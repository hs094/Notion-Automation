# youtube_db

Sync a Notion database of YouTube links: fills in missing **cover**, **title**, and **channel** for every page whose `Link` is set.

Designed to run as an idempotent cron job — only touches fields that are empty.

## Layout

```
youtube_db/
├── main.js          # entrypoint — pure Notion orchestration
├── lib/
│   ├── notion.js    # Notion client + page read/write helpers
│   ├── ytdlp.js     # yt-dlp metadata + thumbnail extraction
│   └── retry.js     # shared backoff/retry helpers
└── README.md
```

`main.js` is the only file that knows the workflow. The `lib/` modules expose small, reusable helpers — extend the workflow by adding new field-checks to `main.js` and (if needed) new read/write helpers to `lib/notion.js`.

## Requirements

- [Bun](https://bun.sh) — `bun --version`
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on `$PATH`
- A Notion integration with access to the target data source

## Env

```env
NOTION_API_KEY=secret_...
NOTION_DATA_SOURCE_ID=...
# optional overrides — defaults shown
NOTION_LINK_PROP=Link
NOTION_TITLE_PROP=Name
NOTION_CHANNEL_PROP=Channel
```

Bun auto-loads `.env` from the repo root.

## Notion schema assumptions

| Property              | Type        | Used as                            |
| --------------------- | ----------- | ---------------------------------- |
| `NOTION_LINK_PROP`    | URL         | source URL passed to yt-dlp        |
| `NOTION_TITLE_PROP`   | Title       | filled with video title            |
| `NOTION_CHANNEL_PROP` | Select      | filled with channel name           |

If your Channel column is `rich_text` instead of `select`, swap `setSelect` / `readSelect` for `setRichText` / `readRichText` in `main.js`.

## Run

```sh
bun run sync:youtube
# or
bun run youtube_db/main.js
```

## Cron

```cron
*/30 * * * * cd /path/to/Notion-Automation && /opt/homebrew/bin/bun run sync:youtube >> /tmp/notion-youtube.log 2>&1
```

The script:

- paginates the data source
- skips pages without a `Link`
- skips pages where cover, title, and channel are all already set
- retries on 429 / 5xx with jittered backoff (max 6 attempts)
- prints a one-line summary at the end (`updated=… skipped=… failed=… total=…`)

## Extending

To sync another field (e.g. duration, published date):

1. Add a `read<Type>` / `set<Type>` helper to `lib/notion.js` if one doesn't exist.
2. If the new field comes from the video, add it to the `--print` template in `lib/ytdlp.js` and the returned object.
3. In `main.js`, add a `needsX` check and the matching write call inside the `try` block.
