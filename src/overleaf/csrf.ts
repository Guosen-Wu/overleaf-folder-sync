import { OlfsError } from "../util/errors.js";

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function readMetaContent(html: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta\\b(?=[^>]*\\bname=["']${escapedName}["'])(?=[^>]*\\bcontent=(["'])([\\s\\S]*?)\\1)[^>]*>`,
    "i",
  );
  const match = html.match(pattern);
  return match ? decodeHtmlAttribute(match[2]) : undefined;
}

export function requireMetaContent(html: string, name: string): string {
  const value = readMetaContent(html, name);
  if (value === undefined) {
    throw new OlfsError(`Could not find ${name} in Overleaf dashboard HTML.`);
  }
  return value;
}
