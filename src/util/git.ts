import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 5000;
const fallbackCommitAuthor = {
  name: "Overleaf Folder Sync",
  email: "olfs@example.invalid",
};

export const gitMissingWarning = "git is not installed or not on PATH. Local paper changes will not be protected by an auto-managed git repository.";

export interface GitOptions {
  gitCommand?: string;
}

export interface EnsureGitRepositoryResult {
  gitAvailable: boolean;
  alreadyRepository: boolean;
  initialized: boolean;
}

export interface GitCommitResult {
  gitAvailable: boolean;
  repositoryAvailable: boolean;
  committed: boolean;
  skippedReason?: string;
  commitHash?: string;
}

async function runGit(args: string[], options: GitOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(options.gitCommand ?? "git", args, { timeout: defaultTimeoutMs });
}

async function hasGitConfig(projectRoot: string, key: string, options: GitOptions = {}): Promise<boolean> {
  try {
    const { stdout } = await runGit(["-C", projectRoot, "config", "--get", key], options);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function commitArgs(projectRoot: string, message: string, options: GitOptions = {}): Promise<string[]> {
  const hasName = await hasGitConfig(projectRoot, "user.name", options);
  const hasEmail = await hasGitConfig(projectRoot, "user.email", options);
  const args = ["-C", projectRoot];
  if (!hasName) {
    args.push("-c", `user.name=${fallbackCommitAuthor.name}`);
  }
  if (!hasEmail) {
    args.push("-c", `user.email=${fallbackCommitAuthor.email}`);
  }
  args.push("commit", "-m", message);
  return args;
}

export async function isGitAvailable(options: GitOptions = {}): Promise<boolean> {
  try {
    await runGit(["--version"], options);
    return true;
  } catch {
    return false;
  }
}

export async function isInsideGitRepository(projectRoot: string, options: GitOptions = {}): Promise<boolean> {
  try {
    const { stdout } = await runGit(["-C", projectRoot, "rev-parse", "--is-inside-work-tree"], options);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function ensureGitRepository(projectRoot: string, options: GitOptions = {}): Promise<EnsureGitRepositoryResult> {
  if (!await isGitAvailable(options)) {
    return {
      gitAvailable: false,
      alreadyRepository: false,
      initialized: false,
    };
  }

  if (await isInsideGitRepository(projectRoot, options)) {
    return {
      gitAvailable: true,
      alreadyRepository: true,
      initialized: false,
    };
  }

  await runGit(["-C", projectRoot, "init"], options);
  return {
    gitAvailable: true,
    alreadyRepository: false,
    initialized: true,
  };
}

export async function commitProjectSnapshot(
  projectRoot: string,
  message: string,
  options: GitOptions = {},
): Promise<GitCommitResult> {
  if (!await isGitAvailable(options)) {
    return {
      gitAvailable: false,
      repositoryAvailable: false,
      committed: false,
      skippedReason: "git is not available",
    };
  }

  if (!await isInsideGitRepository(projectRoot, options)) {
    return {
      gitAvailable: true,
      repositoryAvailable: false,
      committed: false,
      skippedReason: "not inside a git repository",
    };
  }

  await runGit(["-C", projectRoot, "add", "."], options);
  const { stdout } = await runGit(["-C", projectRoot, "diff", "--cached", "--quiet"], options)
    .then(() => ({ stdout: "", stderr: "" }))
    .catch(async () => runGit(["-C", projectRoot, "diff", "--cached", "--name-only"], options));
  if (!stdout.trim()) {
    return {
      gitAvailable: true,
      repositoryAvailable: true,
      committed: false,
      skippedReason: "no staged changes",
    };
  }

  await runGit(await commitArgs(projectRoot, message, options), options);
  const { stdout: commitHash } = await runGit(["-C", projectRoot, "rev-parse", "--short", "HEAD"], options);
  return {
    gitAvailable: true,
    repositoryAvailable: true,
    committed: true,
    commitHash: commitHash.trim(),
  };
}
