import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";
import { pushLocalChanges } from "./sync/push.js";
import type { ProjectTree } from "./overleaf/types.js";
import type { OverleafClient } from "./overleaf/client.js";

test("pushLocalChanges returns immediately when there are no push actions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-push-empty-"));
  const zipPath = path.join(os.tmpdir(), `olfs-push-empty-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await fs.writeFile(path.join(root, "main.tex"), "hello\n", "utf8");

  const zip = new AdmZip();
  zip.addFile("main.tex", Buffer.from("hello\n"));
  zip.writeZip(zipPath);

  const projectTree: ProjectTree = {
    _id: "project-id",
    name: "Project",
    rootFolder: [{
      _id: "root",
      name: "root",
      _type: "folder",
      docs: [{ _id: "doc-main", name: "main.tex", _type: "doc" }],
      fileRefs: [],
      folders: [],
    }],
  };
  const calls = {
    projectTree: 0,
    refreshIdentity: 0,
  };
  const client = {
    baseURL: new URL("https://www.overleaf.com/"),
    async projectTree() {
      calls.projectTree += 1;
      return projectTree;
    },
    async refreshIdentity() {
      calls.refreshIdentity += 1;
      throw new Error("refreshIdentity should not be called for an empty push");
    },
  } as unknown as OverleafClient;

  const result = await pushLocalChanges(client, "project-id", root, zipPath);

  assert.deepEqual(result, {
    uploaded: [],
    moved: [],
    deleted: [],
    skipped: [],
  });
  assert.equal(calls.projectTree, 1);
  assert.equal(calls.refreshIdentity, 0);
});
