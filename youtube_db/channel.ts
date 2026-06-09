import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import { queryAllPages } from "./lib/notion";

export const NOTION_VERSION = "2026-03-11"

const apiKey = process.env.NOTION_API_KEY
if (!apiKey) throw new Error("NOTION_API_KEY is required");

const notion = new Client({ auth: process.env.NOTION_API_KEY })

const data_source_id = process.env.NOTION_CHANNELS_DATA_SOURCE_ID
var pages = await queryAllPages(data_source_id)

for (var page of pages) {
  var properties = page.properties
  console.log(page);
  const response  = await 
  const response = await notion.blocks.children.append({
    block_id: page.id,
    children: [
      {
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: "Hello, world!" } }]
        }
      }
    ]
  })
  break;
}

