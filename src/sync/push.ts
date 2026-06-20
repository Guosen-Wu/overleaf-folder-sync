import fs from "node:fs/promises";
import path from "node:path";
import { OverleafClient } from "../overleaf/client.js";
import { OverleafSocket } from "../overleaf/socket.js";
import { findFolderByRelativePath, indexProjectTree, parentDirOf } from "../overleaf/tree.js";
import type { FolderEntity, ProjectTree } from "../overleaf/types.js";
import { OlfsError } from "../util/errors.js";
import { loadBaseline, type SmartStatus } from "./baseline.js";
import { diffLocalAgainstZip, hashFile, type FileDiff } from "./diff.js";
import { createIgnoreFilter } from "./ignore.js";
import { scanLocalDirectories, scanLocalFiles } from "./scanner.js";

export interface PushPlan {
  localDirs: string[];
  localOnly: string[];
  changedDocs: string[];
  changedFiles: string[];
  remoteOnly: string[];
  unchangedCount: number;
}

export interface PushResult {
  uploaded: string[];
  moved: string[];
  deleted: string[];
  skipped: string[];
}

export async function planPush(client: OverleafClient, projectId: string, projectRoot: string, zipPath: string): Promise<PushPlan> {
  const keep = await createIgnoreFilter(projectRoot);
  const localFiles = await scanLocalFiles(projectRoot);
  const localDirs = await scanLocalDirectories(projectRoot);
  const diff = await diffLocalAgainstZip(localFiles, zipPath, keep);
  const projectTree = await client.projectTree(projectId);
  return makePushPlan(diff, projectTree, localDirs.map((entry) => entry.relativePath));
}

export async function pushLocalChanges(
  client: OverleafClient,
  projectId: string,
  projectRoot: string,
  zipPath: string,
  status?: SmartStatus,
  onlyPaths?: string[],
  options: { deleteRemoteOnly?: boolean } = {},
): Promise<PushResult> {
  const keep = await createIgnoreFilter(projectRoot);
  const localFiles = await scanLocalFiles(projectRoot);
  const localDirs = await scanLocalDirectories(projectRoot);
  const diff = await diffLocalAgainstZip(localFiles, zipPath, keep);
  const projectTree = await client.projectTree(projectId);
  const remoteIndex = indexProjectTree(projectTree);
  const plan = filterPushPlan(makePushPlan(diff, projectTree, localDirs.map((entry) => entry.relativePath)), onlyPaths);
  const identity = await client.refreshIdentity();
  const socket = new OverleafSocket(client.baseURL, identity, projectId);
  const uploaded: string[] = [];
  const moved: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];
  const movedPairs = await detectMovedFiles(projectRoot, projectId, diff.localOnly, status?.localDeleted ?? diff.remoteOnly);
  const movedLocalPaths = new Set(movedPairs.map((pair) => pair.to));
  const movedRemotePaths = new Set(movedPairs.map((pair) => pair.from));

  for (const dir of plan.localDirs) {
    await ensureRemoteFolderPath(client, projectId, projectTree, dir);
  }

  for (const pair of movedPairs) {
    const remote = remoteIndex.get(pair.from);
    if (!remote || remote.type === "folder") {
      skipped.push(`${pair.from} -> ${pair.to} (remote entity was not found)`);
      continue;
    }
    const parent = await ensureRemoteFolderPath(client, projectId, projectTree, parentDirOf(pair.to));
    const nextName = path.basename(pair.to);
    if (remote.parentFolder._id !== parent._id) {
      await client.moveEntity(projectId, remote.type, remote.entity._id, parent._id);
    }
    if (remote.entity.name !== nextName) {
      await client.renameEntity(projectId, remote.type, remote.entity._id, nextName);
    }
    moved.push(`${pair.from} -> ${pair.to}`);
  }

  try {
    await socket.connect();
    for (const relativePath of plan.changedDocs) {
      const remote = remoteIndex.get(relativePath);
      if (!remote || remote.type !== "doc") {
        skipped.push(`${relativePath} (remote doc was not found)`);
        continue;
      }

      const localContent = await fs.readFile(path.join(projectRoot, relativePath), "utf8");
      const remoteDoc = await socket.joinDoc(remote.entity._id);
      await socket.replaceDocContent(remote.entity._id, remoteDoc.content, remoteDoc.version, localContent);
      uploaded.push(relativePath);
    }

    for (const relativePath of plan.changedFiles) {
      const remote = remoteIndex.get(relativePath);
      if (!remote || remote.type !== "file") {
        skipped.push(`${relativePath} (remote file was not found)`);
        continue;
      }

      const localContent = await fs.readFile(path.join(projectRoot, relativePath));
      await client.deleteEntity(projectId, remote.type, remote.entity._id);
      await client.uploadFile(
        projectId,
        remote.parentFolder._id,
        path.basename(relativePath),
        new Blob([localContent]),
        guessMimeType(relativePath),
      );
      uploaded.push(relativePath);
    }

    for (const relativePath of plan.localOnly) {
      if (movedLocalPaths.has(relativePath)) {
        continue;
      }
      const absolutePath = path.join(projectRoot, relativePath);
      const parent = await ensureRemoteFolderPath(client, projectId, projectTree, parentDirOf(relativePath));
      const content = await fs.readFile(absolutePath);
      if (isDocPath(relativePath)) {
        const created = await client.addDoc(projectId, parent._id, path.basename(relativePath));
        const remoteDoc = await socket.joinDoc(created._id);
        await socket.replaceDocContent(created._id, remoteDoc.content, remoteDoc.version, content.toString("utf8"));
      } else {
        await client.uploadFile(
          projectId,
          parent._id,
          path.basename(relativePath),
          new Blob([content]),
          guessMimeType(relativePath),
        );
      }
      uploaded.push(relativePath);
    }
  } finally {
    socket.disconnect();
  }

  const deleteCandidates = options.deleteRemoteOnly ? plan.remoteOnly : (status?.localDeleted ?? []);
  for (const relativePath of deleteCandidates) {
    if (movedRemotePaths.has(relativePath)) {
      continue;
    }
    if (onlyPaths && !onlyPaths.includes(relativePath)) {
      continue;
    }
      const remote = remoteIndex.get(relativePath);
      if (!remote) {
        skipped.push(`${relativePath} (remote entity was not found)`);
        continue;
      }
      await client.deleteEntity(projectId, remote.type, remote.entity._id);
      deleted.push(relativePath);
  }

  return { uploaded, moved, deleted, skipped };
}

function filterPushPlan(plan: PushPlan, onlyPaths?: string[]): PushPlan {
  if (!onlyPaths) {
    return plan;
  }

  const allowed = new Set(onlyPaths);
  return {
    localDirs: plan.localDirs,
    localOnly: plan.localOnly.filter((name) => allowed.has(name)),
    changedDocs: plan.changedDocs.filter((name) => allowed.has(name)),
    changedFiles: plan.changedFiles.filter((name) => allowed.has(name)),
    remoteOnly: plan.remoteOnly.filter((name) => allowed.has(name)),
    unchangedCount: plan.unchangedCount,
  };
}

function makePushPlan(diff: FileDiff, projectTree: ProjectTree, localDirs: string[] = []): PushPlan {
  const remoteIndex = indexProjectTree(projectTree);
  const changedDocs: string[] = [];
  const changedFiles: string[] = [];

  for (const relativePath of diff.changed) {
    const remote = remoteIndex.get(relativePath);
    if (!remote) {
      throw new OlfsError(`Remote entity for changed file ${relativePath} was not found.`);
    }
    if (remote.type === "doc") {
      changedDocs.push(relativePath);
    } else {
      changedFiles.push(relativePath);
    }
  }

  return {
    localDirs: localDirs.filter((dir) => !remoteIndex.has(dir)),
    localOnly: diff.localOnly,
    changedDocs,
    changedFiles,
    remoteOnly: diff.remoteOnly,
    unchangedCount: diff.unchanged.length,
  };
}

function isDocPath(relativePath: string): boolean {
  return /\.(tex|ltx|bib|sty|cls|bst|bbx|cbx|def|cfg|clo|dtx|ins)$/i.test(relativePath);
}

function guessMimeType(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case ".tex":
    case ".ltx":
    case ".bib":
    case ".txt":
    case ".md":
      return "text/plain";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function ensureRemoteFolderPath(client: OverleafClient, projectId: string, projectTree: ProjectTree, relativeDir: string): Promise<FolderEntity> {
  const root = projectTree.rootFolder[0];
  if (!root) {
    throw new OlfsError("Remote project tree has no root folder.");
  }

  const parts = relativeDir.split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    let next = (current.folders ?? []).find((folder) => folder.name === part);
    if (!next) {
      const created = await client.addFolder(projectId, current._id, part);
      next = {
        _id: created._id,
        name: created.name,
        _type: "folder",
        docs: [],
        fileRefs: [],
        folders: [],
      };
      current.folders = current.folders ?? [];
      current.folders.push(next);
    }
    current = next;
  }

  return current;
}

async function detectMovedFiles(
  projectRoot: string,
  projectId: string,
  localOnly: string[],
  remoteDeleted: string[],
): Promise<Array<{ from: string; to: string }>> {
  const baseline = await loadBaseline(projectRoot, projectId);
  if (!baseline) {
    return [];
  }

  const byHash = new Map<string, string[]>();
  for (const remotePath of remoteDeleted) {
    const hash = baseline.files[remotePath];
    if (!hash) {
      continue;
    }
    const paths = byHash.get(hash) ?? [];
    paths.push(remotePath);
    byHash.set(hash, paths);
  }

  const moves: Array<{ from: string; to: string }> = [];
  for (const localPath of localOnly) {
    const hash = baseline.files[localPath] ?? await hashLocalFile(projectRoot, localPath);
    const candidates = byHash.get(hash);
    const from = candidates?.shift();
    if (from) {
      moves.push({ from, to: localPath });
    }
  }

  return moves;
}

async function hashLocalFile(projectRoot: string, relativePath: string): Promise<string> {
  return hashFile(path.join(projectRoot, relativePath));
}
