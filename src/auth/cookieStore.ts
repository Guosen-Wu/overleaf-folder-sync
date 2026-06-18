import fs from "node:fs/promises";
import path from "node:path";
import { authFilePath } from "../config/paths.js";
import { OlfsError } from "../util/errors.js";

export interface StoredAuth {
  overleafSession2: string;
  cookieHeader?: string;
  updatedAt: string;
}

function extractSessionCookie(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/(?:^|;\s*)overleaf_session2=([^;]+)/);
  return match ? match[1].trim() : trimmed;
}

function normalizeCookieHeader(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (/(?:^|;\s*)overleaf_session2=/.test(trimmed)) {
    return trimmed;
  }
  return `overleaf_session2=${trimmed}`;
}

export function parseSessionCookie(input: string): string {
  return extractSessionCookie(input);
}

export async function saveSessionCookie(rawCookie: string): Promise<StoredAuth> {
  const overleafSession2 = extractSessionCookie(rawCookie);
  if (!overleafSession2) {
    throw new OlfsError("Cookie value is empty.");
  }

  const stored: StoredAuth = {
    overleafSession2,
    cookieHeader: normalizeCookieHeader(rawCookie),
    updatedAt: new Date().toISOString(),
  };

  const target = authFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(target, 0o600);
  return stored;
}

export async function saveCookieHeader(cookieHeader: string): Promise<StoredAuth> {
  return saveSessionCookie(cookieHeader);
}

export async function loadSessionCookie(): Promise<StoredAuth> {
  const target = authFilePath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    throw new OlfsError(`Could not read auth file at ${target}. Run "olfs auth set-cookie" first.`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as StoredAuth).overleafSession2 !== "string"
  ) {
    throw new OlfsError(`Auth file at ${target} is invalid.`);
  }

  return parsed as StoredAuth;
}
