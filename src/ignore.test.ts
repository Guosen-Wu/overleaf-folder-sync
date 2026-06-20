import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";
import { computeSmartStatus } from "./sync/baseline.js";
import { diffLocalAgainstZip } from "./sync/diff.js";
import { createIgnoreFilter } from "./sync/ignore.js";
import { scanLocalDirectories, scanLocalFiles } from "./sync/scanner.js";

test(".gitignore and .olignore filter project submission candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-ignore-"));
  const zipPath = path.join(os.tmpdir(), `olfs-ignore-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await fs.writeFile(path.join(root, ".gitignore"), "build/\n", "utf8");
  await fs.writeFile(path.join(root, ".olignore"), "private/\n*.aux\n", "utf8");
  await fs.writeFile(path.join(root, "main.tex"), "hello", "utf8");
  await fs.mkdir(path.join(root, "private"));
  await fs.writeFile(path.join(root, "private", "secret.tex"), "secret", "utf8");
  await fs.mkdir(path.join(root, "build"));
  await fs.writeFile(path.join(root, "build", "local.tmp"), "tmp", "utf8");

  const zip = new AdmZip();
  zip.addFile("main.tex", Buffer.from("hello"));
  zip.addFile("private/secret.tex", Buffer.from("remote secret"));
  zip.addFile("notes.aux", Buffer.from("aux"));
  zip.addFile("build/remote.tmp", Buffer.from("tmp"));
  zip.writeZip(zipPath);

  const keep = await createIgnoreFilter(root);
  const localFiles = await scanLocalFiles(root);
  const localDirs = await scanLocalDirectories(root);
  const diff = await diffLocalAgainstZip(localFiles, zipPath, keep);
  const status = await computeSmartStatus(root, "project-id", zipPath);
  const statusPaths = [
    ...status.localAdded,
    ...status.localModified,
    ...status.localDeleted,
    ...status.remoteAdded,
    ...status.remoteModified,
    ...status.remoteDeleted,
    ...status.conflicts,
    ...status.unknownChanged,
    ...status.unchanged,
  ];

  assert.deepEqual(localFiles.map((file) => file.relativePath), ["main.tex"]);
  assert.deepEqual(localDirs.map((dir) => dir.relativePath), []);
  assert.deepEqual(diff.remoteOnly, []);
  assert.deepEqual(statusPaths, ["main.tex"]);
});
