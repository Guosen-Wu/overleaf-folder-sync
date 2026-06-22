import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { commitProjectSnapshot, ensureGitRepository, isGitAvailable } from "./util/git.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout.trim();
}

test("ensureGitRepository reports missing git without failing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-git-missing-"));
  const result = await ensureGitRepository(root, {
    gitCommand: path.join(root, "missing-git"),
  });

  assert.deepEqual(result, {
    gitAvailable: false,
    alreadyRepository: false,
    initialized: false,
  });
});

test("ensureGitRepository initializes a folder once", { skip: !await isGitAvailable() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-git-init-"));

  const first = await ensureGitRepository(root);
  const second = await ensureGitRepository(root);

  assert.deepEqual(first, {
    gitAvailable: true,
    alreadyRepository: false,
    initialized: true,
  });
  assert.deepEqual(second, {
    gitAvailable: true,
    alreadyRepository: true,
    initialized: false,
  });
});

test("ensureGitRepository respects an inherited git repository", { skip: !await isGitAvailable() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-git-parent-"));
  const child = path.join(root, "paper");

  await fs.mkdir(child);
  await ensureGitRepository(root);

  const result = await ensureGitRepository(child);

  assert.deepEqual(result, {
    gitAvailable: true,
    alreadyRepository: true,
    initialized: false,
  });
});

test("commitProjectSnapshot stages and commits all project changes", { skip: !await isGitAvailable() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-git-commit-"));

  await ensureGitRepository(root);
  await fs.writeFile(path.join(root, "main.tex"), "hello\n", "utf8");

  const result = await commitProjectSnapshot(root, "Sync paper draft");

  assert.equal(result.committed, true);
  assert.match(result.commitHash ?? "", /^[0-9a-f]+$/);
  assert.equal(await git(root, ["log", "-1", "--pretty=%s"]), "Sync paper draft");
  assert.equal(await git(root, ["status", "--short"]), "");
});

test("commitProjectSnapshot skips when there are no staged changes", { skip: !await isGitAvailable() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-git-empty-"));

  await ensureGitRepository(root);

  const result = await commitProjectSnapshot(root, "No changes");

  assert.deepEqual(result, {
    gitAvailable: true,
    repositoryAvailable: true,
    committed: false,
    skippedReason: "no staged changes",
  });
});
