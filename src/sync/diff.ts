import fs from "node:fs/promises";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import type { LocalFileEntry } from "./scanner.js";
import type { IgnoreFilter } from "./ignore.js";

export interface FileDiff {
  localOnly: string[];
  remoteOnly: string[];
  changed: string[];
  unchanged: string[];
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function hashBuffer(buffer: Buffer): string {
  return sha256(buffer);
}

export async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

export function zipHashes(zipPath: string, keep: IgnoreFilter = () => true): Map<string, string> {
  const hashes = new Map<string, string>();
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      const normalized = entry.entryName.replace(/\\/g, "/");
      if (keep(normalized)) {
        hashes.set(normalized, sha256(entry.getData()));
      }
    }
  }
  return hashes;
}

export async function localHashes(localFiles: LocalFileEntry[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of localFiles) {
    hashes.set(file.relativePath, await hashFile(file.absolutePath));
  }
  return hashes;
}

export async function diffLocalAgainstZip(
  localFiles: LocalFileEntry[],
  zipPath: string,
  keepRemote: IgnoreFilter = () => true,
): Promise<FileDiff> {
  const localHashesMap = await localHashes(localFiles);
  const remoteHashes = zipHashes(zipPath, keepRemote);

  const localOnly: string[] = [];
  const remoteOnly: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [name, hash] of localHashesMap) {
    const remoteHash = remoteHashes.get(name);
    if (remoteHash === undefined) {
      localOnly.push(name);
    } else if (remoteHash === hash) {
      unchanged.push(name);
    } else {
      changed.push(name);
    }
  }

  for (const name of remoteHashes.keys()) {
    if (!localHashesMap.has(name)) {
      remoteOnly.push(name);
    }
  }

  return {
    localOnly: localOnly.sort(),
    remoteOnly: remoteOnly.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
  };
}
