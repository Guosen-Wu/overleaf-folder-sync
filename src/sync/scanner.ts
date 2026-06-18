import path from "node:path";
import fg from "fast-glob";
import { createIgnoreFilter } from "./ignore.js";

export interface LocalFileEntry {
  relativePath: string;
  absolutePath: string;
}

export interface LocalDirectoryEntry {
  relativePath: string;
  absolutePath: string;
}

export async function scanLocalFiles(root: string): Promise<LocalFileEntry[]> {
  const keep = await createIgnoreFilter(root);
  const entries = await fg("**/*", {
    cwd: root,
    dot: true,
    onlyFiles: true,
    unique: true,
  });

  return entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter(keep)
    .sort((a, b) => a.localeCompare(b))
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(root, relativePath),
    }));
}

export async function scanLocalDirectories(root: string): Promise<LocalDirectoryEntry[]> {
  const keep = await createIgnoreFilter(root);
  const entries = await fg("**/*", {
    cwd: root,
    dot: true,
    onlyDirectories: true,
    unique: true,
  });

  return entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter(keep)
    .sort((a, b) => a.localeCompare(b))
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(root, relativePath),
    }));
}
