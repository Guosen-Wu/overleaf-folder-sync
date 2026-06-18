import path from "node:path";
import type { FolderEntity, ProjectEntity, ProjectTree } from "./types.js";

export interface RemotePathEntry {
  path: string;
  entity: ProjectEntity;
  type: "doc" | "file" | "folder";
  parentFolder: FolderEntity;
}

export function indexProjectTree(project: ProjectTree): Map<string, RemotePathEntry> {
  const entries = new Map<string, RemotePathEntry>();
  const root = project.rootFolder[0];
  if (!root) {
    return entries;
  }

  walkFolder(root, "", root, entries);
  return entries;
}

export function findFolderByRelativePath(project: ProjectTree, relativeDir: string): FolderEntity | undefined {
  const root = project.rootFolder[0];
  if (!root) {
    return undefined;
  }

  const parts = relativeDir.split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    const next = (current.folders ?? []).find((folder) => folder.name === part);
    if (!next) {
      return undefined;
    }
    current = next;
  }
  return current;
}

export function parentDirOf(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === "." ? "" : dir;
}

function walkFolder(
  folder: FolderEntity,
  folderPath: string,
  parentFolder: FolderEntity,
  entries: Map<string, RemotePathEntry>,
): void {
  const folderEntryPath = folderPath;
  if (folderEntryPath) {
    entries.set(folderEntryPath, {
      path: folderEntryPath,
      entity: folder,
      type: "folder",
      parentFolder,
    });
  }

  for (const doc of folder.docs ?? []) {
    const docPath = joinRemotePath(folderPath, doc.name);
    entries.set(docPath, { path: docPath, entity: doc, type: "doc", parentFolder: folder });
  }

  for (const file of folder.fileRefs ?? []) {
    const filePath = joinRemotePath(folderPath, file.name);
    entries.set(filePath, { path: filePath, entity: file, type: "file", parentFolder: folder });
  }

  for (const child of folder.folders ?? []) {
    walkFolder(child, joinRemotePath(folderPath, child.name), folder, entries);
  }
}

function joinRemotePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
