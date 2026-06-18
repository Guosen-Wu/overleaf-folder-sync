import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";

export interface PullSummary {
  written: string[];
  directories: string[];
}

export async function extractZipToFolder(zipPath: string, targetRoot: string): Promise<PullSummary> {
  const zip = new AdmZip(zipPath);
  const written: string[] = [];
  const directories: string[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      const normalizedDir = entry.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
      if (normalizedDir) {
        const outputDir = path.resolve(targetRoot, normalizedDir);
        const rootWithSep = `${path.resolve(targetRoot)}${path.sep}`;
        if (!outputDir.startsWith(rootWithSep)) {
          throw new Error(`Refusing to extract path outside target folder: ${entry.entryName}`);
        }
        await fs.mkdir(outputDir, { recursive: true });
        directories.push(normalizedDir);
      }
      continue;
    }

    const normalized = entry.entryName.replace(/\\/g, "/");
    const outputPath = path.resolve(targetRoot, normalized);
    const rootWithSep = `${path.resolve(targetRoot)}${path.sep}`;
    if (!outputPath.startsWith(rootWithSep)) {
      throw new Error(`Refusing to extract path outside target folder: ${entry.entryName}`);
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, entry.getData());
    written.push(normalized);
  }

  return { written, directories };
}

export async function extractFilesFromZip(zipPath: string, targetRoot: string, relativePaths: string[]): Promise<PullSummary> {
  const wanted = new Set(relativePaths);
  const zip = new AdmZip(zipPath);
  const written: string[] = [];
  const directories: string[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      const normalizedDir = entry.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
      if (wanted.has(normalizedDir)) {
        const outputDir = path.resolve(targetRoot, normalizedDir);
        const rootWithSep = `${path.resolve(targetRoot)}${path.sep}`;
        if (!outputDir.startsWith(rootWithSep)) {
          throw new Error(`Refusing to extract path outside target folder: ${entry.entryName}`);
        }
        await fs.mkdir(outputDir, { recursive: true });
        directories.push(normalizedDir);
      }
      continue;
    }

    const normalized = entry.entryName.replace(/\\/g, "/");
    if (!wanted.has(normalized)) {
      continue;
    }

    const outputPath = path.resolve(targetRoot, normalized);
    const rootWithSep = `${path.resolve(targetRoot)}${path.sep}`;
    if (!outputPath.startsWith(rootWithSep)) {
      throw new Error(`Refusing to extract path outside target folder: ${entry.entryName}`);
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, entry.getData());
    written.push(normalized);
  }

  return { written, directories };
}

export async function deleteLocalFiles(targetRoot: string, relativePaths: string[]): Promise<string[]> {
  const deleted: string[] = [];

  for (const relativePath of relativePaths) {
    const normalized = relativePath.replace(/\\/g, "/");
    const outputPath = path.resolve(targetRoot, normalized);
    const rootWithSep = `${path.resolve(targetRoot)}${path.sep}`;
    if (!outputPath.startsWith(rootWithSep)) {
      throw new Error(`Refusing to delete path outside target folder: ${relativePath}`);
    }

    try {
      await fs.rm(outputPath, { force: true });
      deleted.push(normalized);
      await removeEmptyParentDirs(path.dirname(outputPath), path.resolve(targetRoot));
    } catch {
      // Missing files are already in the desired state.
    }
  }

  return deleted;
}

async function removeEmptyParentDirs(startDir: string, rootDir: string): Promise<void> {
  let current = startDir;
  while (current.startsWith(rootDir) && current !== rootDir) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
