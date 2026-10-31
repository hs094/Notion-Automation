import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import { withRetry, fetchWithRetry } from "./retry.ts";

export const NOTION_VERSION = "2026-03-11";

function getApiKey(): string {
  // ponytail: read lazily so initDoppler() can inject first; support legacy .env name
  const key = process.env.YT_DB_NOTION_API_KEY ?? process.env.NOTION_API_KEY;
  if (!key) throw new Error("YT_DB_NOTION_API_KEY is required");
  return key;
}

let cached: Client | undefined;
function getClient(): Client {
  cached ??= new Client({ auth: getApiKey(), notionVersion: NOTION_VERSION });
  return cached;
}

// ponytail: Proxy defers Client construction until first use (post-Doppler)
export const notion: Client = new Proxy({} as Client, {
  get(_t, p) {
    const v = (getClient() as unknown as Record<string | symbol, unknown>)[p];
    return typeof v === "function" ? (v as Function).bind(getClient()) : v;
  },
});

type PageProperty = PageObjectResponse["properties"][string];

function prop(page: PageObjectResponse, name: string): PageProperty | undefined {
  return page.properties[name];
}

export async function queryPageBatch(
  dataSourceId: string,
  pageSize: number,
  startCursor?: string,
): Promise<{ pages: PageObjectResponse[]; nextCursor?: string }> {
  const res = await withRetry(
    () =>
      notion.dataSources.query({
        data_source_id: dataSourceId,
        page_size: pageSize,
        start_cursor: startCursor,
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      }),
    "dataSources.query",
  );
  return {
    pages: res.results.filter(
      (r): r is PageObjectResponse => r.object === "page" && "properties" in r,
    ),
    nextCursor: res.has_more && res.next_cursor ? res.next_cursor : undefined,
  };
}

export async function queryAllPages(
  dataSourceId: string,
): Promise<PageObjectResponse[]> {
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const batch = await queryPageBatch(dataSourceId, 100, cursor);
    pages.push(...batch.pages);
    cursor = batch.nextCursor;
  } while (cursor);
  return pages;
}

// --- reads ---

export function readUrl(page: PageObjectResponse, name: string): string {
  const p = prop(page, name);
  return p?.type === "url" ? (p.url ?? "") : "";
}

export function readTitle(page: PageObjectResponse, name: string): string {
  const p = prop(page, name);
  if (p?.type !== "title") return "";
  return p.title.map((t) => t.plain_text).join("").trim();
}

export function readRichText(page: PageObjectResponse, name: string): string {
  const p = prop(page, name);
  return p?.type === "rich_text"
    ? p.rich_text.map((t) => t.plain_text).join("").trim()
    : "";
}

export function readTitleInlineUrl(
  page: PageObjectResponse,
  name: string,
): string {
  const p = prop(page, name);
  if (p?.type !== "title") return "";
  for (const t of p.title) {
    if (t.type === "text" && t.text.link?.url) return t.text.link.url;
  }
  return "";
}

export function readRelationIds(
  page: PageObjectResponse,
  name: string,
): string[] {
  const p = prop(page, name);
  if (p?.type !== "relation") return [];
  return p.relation.map((r) => r.id);
}

export function hasCover(page: PageObjectResponse): boolean {
  return page.cover != null;
}

export function hasIcon(page: PageObjectResponse): boolean {
  return page.icon != null;
}

// --- file upload ---

export async function uploadFile(
  filePath: string,
  filename: string,
  contentType?: string,
): Promise<string> {
  const file = Bun.file(filePath);
  const type = contentType || file.type || "application/octet-stream";

  const upload = await withRetry(
    () =>
      notion.fileUploads.create({
        mode: "single_part",
        filename,
        content_type: type,
      }),
    "fileUploads.create",
  );

  const form = new FormData();
  form.append("file", new Blob([await file.arrayBuffer()], { type }), filename);

  await fetchWithRetry(
    `https://api.notion.com/v1/file_uploads/${upload.id}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Notion-Version": NOTION_VERSION,
      },
      body: form,
    },
    "fileUploads.send",
  );

  return upload.id;
}

// --- page-level writes (icon/cover) ---

export async function setCoverFromUpload(
  pageId: string,
  uploadId: string,
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.update({
        page_id: pageId,
        cover: { type: "file_upload", file_upload: { id: uploadId } },
      }),
    "pages.update(cover)",
  );
}

export async function setIconFromUpload(
  pageId: string,
  uploadId: string,
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.update({
        page_id: pageId,
        icon: { type: "file_upload", file_upload: { id: uploadId } },
      }),
    "pages.update(icon)",
  );
}

export async function trashPage(pageId: string): Promise<void> {
  await withRetry(
    () => notion.pages.update({ page_id: pageId, in_trash: true }),
    "pages.update(trash)",
  );
}

export async function hasPageSummary(pageId: string): Promise<boolean> {
  let cursor: string | undefined;

  do {
    const response = await withRetry(
      () =>
        notion.blocks.children.list({
          block_id: pageId,
          page_size: 100,
          start_cursor: cursor,
        }),
      "blocks.children.list(summary)",
    );
    if (
      response.results.some(
        (block) =>
          "heading_2" in block &&
          block.heading_2.rich_text.map((text) => text.plain_text).join("") ===
            "AI Summary",
      )
    ) {
      return true;
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return false;
}

export async function appendPageSummary(
  pageId: string,
  value: string,
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.updateMarkdown({
        page_id: pageId,
        markdown_version: "v1",
        type: "insert_content",
        insert_content: {
          content: `\n\n## AI Summary\n\n${value}`,
          position: { type: "end" },
        },
      }),
    "pages.updateMarkdown(summary)",
  );
}

// --- property writes ---

export async function setTitle(
  pageId: string,
  name: string,
  value: string,
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          [name]: { title: [{ type: "text", text: { content: value } }] },
        },
      }),
    "pages.update(title)",
  );
}

export async function setRichText(
  pageId: string,
  name: string,
  value: string,
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          [name]: {
            rich_text: (value.match(/[\s\S]{1,2000}/gu) ?? []).map((content) => ({
              type: "text",
              text: { content },
            })),
          },
        },
      }),
    "pages.update(rich_text)",
  );
}

export async function setUrlProp(
  pageId: string,
  name: string,
  value: string,
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: { [name]: { url: value } },
      }),
    "pages.update(url)",
  );
}

export async function setRelation(
  pageId: string,
  name: string,
  targetPageIds: string[],
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          [name]: { relation: targetPageIds.map((id) => ({ id })) },
        },
      }),
    "pages.update(relation)",
  );
}

// --- channel-page creation ---

export interface CreateChannelInput {
  channelsDataSourceId: string;
  videosDataSourceId: string;
  titleProp: string;
  urlProp: string;
  channelPageProp: string;
  name: string;
  url: string;
  iconUploadId: string;
  coverUploadId: string | null;
}

export async function createChannelPage(
  input: CreateChannelInput,
): Promise<string> {
  const created = await withRetry(
    () =>
      notion.pages.create({
        parent: {
          type: "data_source_id",
          data_source_id: input.channelsDataSourceId,
        },
        icon: {
          type: "file_upload",
          file_upload: { id: input.iconUploadId },
        },
        ...(input.coverUploadId
          ? {
              cover: {
                type: "file_upload",
                file_upload: { id: input.coverUploadId },
              },
            }
          : {}),
        properties: {
          [input.titleProp]: {
            title: [{ type: "text", text: { content: input.name } }],
          },
          [input.urlProp]: { url: input.url },
        },
      }),
    "pages.create(channel)",
  );
  await createChannelVideoView({
    videosDataSourceId: input.videosDataSourceId,
    channelPageId: created.id,
    channelPageProp: input.channelPageProp,
    name: input.name,
  });
  return created.id;
}

export interface CreateChannelVideoViewInput {
  videosDataSourceId: string;
  channelPageId: string;
  channelPageProp: string;
  name: string;
}

// Creates a gallery view inside the channel page showing the videos
// watched from that channel (filtered by the Channel Page relation).
export async function createChannelVideoView(
  input: CreateChannelVideoViewInput,
): Promise<void> {
  await withRetry(
    () =>
      notion.views.create({
        data_source_id: input.videosDataSourceId,
        name: `${input.name}'s Video's DB`,
        type: "gallery",
        create_database: {
          parent: { type: "page_id", page_id: input.channelPageId },
        },
        // The SDK types the view filter as Record<string, never>; the API
        // accepts a relation property filter, so cast past the stub type.
        filter: {
          property: input.channelPageProp,
          relation: { contains: input.channelPageId },
        } as unknown as Record<string, never>,
        configuration: {
          type: "gallery",
          cover: { type: "page_cover" },
        },
      }),
    "views.create(gallery)",
  );
}
