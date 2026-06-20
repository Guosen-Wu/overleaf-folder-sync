import fs from "node:fs/promises";
import path from "node:path";
import { legacyProjectBaselinePath, projectBaselinePath } from "../config/paths.js";
import { localHashes, zipHashes } from "./diff.js";
import { createIgnoreFilter, type IgnoreFilter } from "./ignore.js";
import { scanLocalFiles } from "./scanner.js";

export interface SyncBaseline {
  version: 1;
  projectId: string;
  updatedAt: string;
  files: Record<string, string>;
}

export interface SmartStatus {
  localAdded: string[];
  localModified: string[];
  localDeleted: string[];
  remoteAdded: string[];
  remoteModified: string[];
  remoteDeleted: string[];
  conflicts: string[];
  unknownChanged: string[];
  unchanged: string[];
  baselineAvailable: boolean;
  remoteChecked: boolean;
}

export function baselinePath(projectRoot: string): string {
  return projectBaselinePath(projectRoot);
}

export async function loadBaseline(projectRoot: string, projectId: string): Promise<SyncBaseline | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(baselinePath(projectRoot), "utf8")) as SyncBaseline;
    if (parsed.version === 1 && parsed.projectId === projectId && typeof parsed.files === "object") {
      return parsed;
    }
  } catch {
    try {
      const parsed = JSON.parse(await fs.readFile(legacyProjectBaselinePath(projectRoot), "utf8")) as SyncBaseline;
      if (parsed.version === 1 && parsed.projectId === projectId && typeof parsed.files === "object") {
        await saveBaseline(projectRoot, parsed);
        return parsed;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function saveBaselineFromZip(projectRoot: string, projectId: string, zipPath: string): Promise<SyncBaseline> {
  const keep = await createIgnoreFilter(projectRoot);
  const files = Object.fromEntries([...zipHashes(zipPath, keep).entries()].sort(([a], [b]) => a.localeCompare(b)));
  return saveBaseline(projectRoot, {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    files,
  });
}

export async function saveBaselineFromLocal(projectRoot: string, projectId: string): Promise<SyncBaseline> {
  const hashes = await localHashes(await scanLocalFiles(projectRoot));
  const files = Object.fromEntries([...hashes.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return saveBaseline(projectRoot, {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    files,
  });
}

export async function computeSmartStatus(projectRoot: string, projectId: string, zipPath: string): Promise<SmartStatus> {
  const keep = await createIgnoreFilter(projectRoot);
  const local = await localHashes(await scanLocalFiles(projectRoot));
  const remote = zipHashes(zipPath, keep);
  const baseline = await loadBaseline(projectRoot, projectId);
  const base = filterFiles(baseline?.files ?? {}, keep);
  const names = new Set([...Object.keys(base), ...local.keys(), ...remote.keys()]);

  const status: SmartStatus = {
    localAdded: [],
    localModified: [],
    localDeleted: [],
    remoteAdded: [],
    remoteModified: [],
    remoteDeleted: [],
    conflicts: [],
    unknownChanged: [],
    unchanged: [],
    baselineAvailable: Boolean(baseline),
    remoteChecked: true,
  };

  for (const name of [...names].sort()) {
    const baseHash = base[name];
    const localHash = local.get(name);
    const remoteHash = remote.get(name);

    if (localHash === remoteHash) {
      status.unchanged.push(name);
      continue;
    }

    if (!baseline) {
      status.unknownChanged.push(name);
      continue;
    }

    const localChanged = localHash !== baseHash;
    const remoteChanged = remoteHash !== baseHash;

    if (localChanged && remoteChanged) {
      status.conflicts.push(name);
    } else if (localChanged) {
      if (baseHash === undefined && localHash !== undefined) status.localAdded.push(name);
      else if (localHash === undefined) status.localDeleted.push(name);
      else status.localModified.push(name);
    } else if (remoteChanged) {
      if (baseHash === undefined && remoteHash !== undefined) status.remoteAdded.push(name);
      else if (remoteHash === undefined) status.remoteDeleted.push(name);
      else status.remoteModified.push(name);
    }
  }

  return status;
}

export async function computeLocalStatus(projectRoot: string, projectId: string): Promise<SmartStatus> {
  const keep = await createIgnoreFilter(projectRoot);
  const local = await localHashes(await scanLocalFiles(projectRoot));
  const baseline = await loadBaseline(projectRoot, projectId);
  const base = filterFiles(baseline?.files ?? {}, keep);
  const names = new Set([...Object.keys(base), ...local.keys()]);

  const status: SmartStatus = {
    localAdded: [],
    localModified: [],
    localDeleted: [],
    remoteAdded: [],
    remoteModified: [],
    remoteDeleted: [],
    conflicts: [],
    unknownChanged: [],
    unchanged: [],
    baselineAvailable: Boolean(baseline),
    remoteChecked: false,
  };

  for (const name of [...names].sort()) {
    const baseHash = base[name];
    const localHash = local.get(name);

    if (!baseline) {
      status.unknownChanged.push(name);
    } else if (localHash === baseHash) {
      status.unchanged.push(name);
    } else if (baseHash === undefined && localHash !== undefined) {
      status.localAdded.push(name);
    } else if (localHash === undefined) {
      status.localDeleted.push(name);
    } else {
      status.localModified.push(name);
    }
  }

  return status;
}

function filterFiles(files: Record<string, string>, keep: IgnoreFilter): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([name]) => keep(name)));
}

async function saveBaseline(projectRoot: string, baseline: SyncBaseline): Promise<SyncBaseline> {
  const target = baselinePath(projectRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return baseline;
}
