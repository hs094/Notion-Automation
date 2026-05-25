import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import { withRetry, fetchWithRetry } from "./retry.ts";

export const NOTION_VERSION = "2026-03-11";

const apiKey = process.env.NOTION_API_KEY;
if (!apiKey) throw new Error("NOTION_API_KEY is required");

export const notion = new Client({
  auth: apiKey,
  notionVersion: NOTION_VERSION,
});

type PageProperty = PageObjectResponse["properties"][string];

function prop(page: PageObjectResponse, name: string): PageProperty | undefined {
  return page.properties[name];
}

export async function queryAllPages(
  dataSourceId: string,
): Promise<PageObjectResponse[]> {
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry(
      () =>
        notion.dataSources.query({
          data_source_id: dataSourceId,
          start_cursor: cursor,
        }),
      "dataSources.query",
    );
    for (const r of res.results) {
      if (r.object === "page" && "properties" in r) pages.push(r);
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

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
  if (p?.type !== "rich_text") return "";
  return p.rich_text.map((t) => t.plain_text).join("").trim();
}

export function readSelect(page: PageObjectResponse, name: string): string {
  const p = prop(page, name);
  return p?.type === "select" ? (p.select?.name ?? "") : "";
}

export function hasCover(page: PageObjectResponse): boolean {
  return page.cover != null;
}

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
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": NOTION_VERSION,
      },
      body: form,
    },
    "fileUploads.send",
  );

  return upload.id;
}

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

export async function setSelect(
  pageId: string,
  name: string,
  value: string,
): Promise<void> {
  await withRetry(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: { [name]: { select: { name: value } } },
      }),
    "pages.update(select)",
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
          [name]: { rich_text: [{ type: "text", text: { content: value } }] },
        },
      }),
    "pages.update(rich_text)",
  );
}
