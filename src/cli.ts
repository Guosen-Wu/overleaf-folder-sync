#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { loadSessionCookie, saveCookieHeader, saveSessionCookie } from "./auth/cookieStore.js";
import { LatexLogParser, type CompileLogEntry, type CompileLogParseResult } from "./compile/latexLogParser.js";
import { authFilePath } from "./config/paths.js";
import { currentScriptGlob, loadLocalProjectConfig, saveLocalProjectConfig } from "./config/projectConfig.js";
import { OverleafClient } from "./overleaf/client.js";
import { indexProjectTree } from "./overleaf/tree.js";
import { createIgnoreFilter } from "./sync/ignore.js";
import { deleteLocalFiles, extractFilesFromZip, extractZipToFolder } from "./sync/apply.js";
import { computeLocalStatus, computeSmartStatus, saveBaselineFromLocal, saveBaselineFromZip, type SmartStatus } from "./sync/baseline.js";
import { planPush, pushLocalChanges, type PushPlan, type PushResult } from "./sync/push.js";
import { scanLocalFiles } from "./sync/scanner.js";
import { diffLocalAgainstZip } from "./sync/diff.js";
import { OlfsError } from "./util/errors.js";
import { commitProjectSnapshot, ensureGitRepository, gitMissingWarning, isGitAvailable, type GitCommitResult } from "./util/git.js";
import { runWithOperationTimeout } from "./util/operationTimeout.js";

const color = {
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

let activeClient: OverleafClient | undefined;
let shouldPersistCookie = false;

function makeClient(overleafSession2: string, cookieHeader?: string): OverleafClient {
  return new OverleafClient({ overleafSession2, cookieHeader });
}

async function authenticatedClient(): Promise<OverleafClient> {
  const auth = await loadSessionCookie();
  activeClient = makeClient(auth.overleafSession2, auth.cookieHeader);
  shouldPersistCookie = true;
  return activeClient;
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function printProject(project: { id: string; name: string; lastUpdated?: string; accessLevel?: string }): void {
  const pieces = [project.id, project.name];
  const updated = formatDate(project.lastUpdated);
  if (updated) {
    pieces.push(updated);
  }
  if (project.accessLevel) {
    pieces.push(project.accessLevel);
  }
  console.log(pieces.join("\t"));
}

function printNamedList(title: string, names: string[], hint?: string, showItems = true, paint = (text: string) => text): void {
  const suffix = hint ? `  ${hint}` : "";
  console.log(paint(`${title.padEnd(18)} ${String(names.length).padStart(3)}${suffix}`));
  if (showItems) {
    names.forEach((name) => console.log(paint(`  - ${name}`)));
  }
}

function printSmartStatus(status: SmartStatus): void {
  console.log(color.bold("Overleaf Folder Sync status"));
  console.log((status.baselineAvailable ? color.green : color.yellow)(
    status.baselineAvailable
    ? "Baseline: available"
    : "Baseline: missing, run pull once or push after reviewing changes to establish direction tracking.",
  ));
  console.log(status.remoteChecked ? color.green("Remote: checked") : color.gray("Remote: not checked (--local)"));
  console.log("");
  printNamedList("Local modified", status.localModified, "push", true, color.green);
  printNamedList("Local added", status.localAdded, "push", true, color.green);
  printNamedList("Local deleted", status.localDeleted, "push deletes remote", true, color.yellow);
  printNamedList("Remote modified", status.remoteModified, "pull", true, color.cyan);
  printNamedList("Remote added", status.remoteAdded, "pull", true, color.cyan);
  printNamedList("Remote deleted", status.remoteDeleted, "pull deletes local", true, color.yellow);
  printNamedList("Conflicts", status.conflicts, "both sides changed", true, color.red);
  printNamedList("Changed", status.unknownChanged, "direction unknown", true, color.yellow);
  printNamedList("Unchanged", status.unchanged, undefined, false, color.gray);
}

function printActionStatusSummary(status: SmartStatus): void {
  const pieces: Array<[string, number]> = [];
  const add = (label: string, count: number) => {
    if (count > 0) {
      pieces.push([label, count]);
    }
  };
  add("local modified", status.localModified.length);
  add("local added", status.localAdded.length);
  add("local deleted", status.localDeleted.length);
  add("remote modified", status.remoteModified.length);
  add("remote added", status.remoteAdded.length);
  add("remote deleted", status.remoteDeleted.length);
  add("conflicts", status.conflicts.length);
  add("unknown", status.unknownChanged.length);

  if (pieces.length === 0) {
    console.log(color.green("No changes."));
    return;
  }

  console.log(pieces.map(([label, count]) => `${label}: ${count}`).join(", "));
}

function formatCompileLocation(entry: CompileLogEntry): string {
  const file = entry.file || "(unknown file)";
  return entry.line === null ? file : `${file}:${entry.line}`;
}

function printCompileEntries(title: string, entries: CompileLogEntry[], paint = (text: string) => text): void {
  if (entries.length === 0) {
    return;
  }
  console.log(paint(`${title}\t${entries.length}`));
  for (const entry of entries) {
    console.log(paint(`  ${formatCompileLocation(entry)}\t${entry.message}`));
  }
}

function printCompileSummary(status: string, parsed: CompileLogParseResult): void {
  console.log(color.bold(`Compile status: ${status}`));
  printCompileEntries("errors", parsed.errors, color.red);
  printCompileEntries("warnings", parsed.warnings, color.yellow);
  printCompileEntries("information", parsed.information, color.gray);
  if (parsed.all.length === 0) {
    console.log(color.green("No log issues found."));
  }
}

function printPushPlan(plan: PushPlan): void {
  printNamedList("Local dirs", plan.localDirs, undefined, plan.localDirs.length > 0);
  printNamedList("Changed docs", plan.changedDocs, undefined, plan.changedDocs.length > 0);
  printNamedList("Changed files", plan.changedFiles, undefined, plan.changedFiles.length > 0);
  printNamedList("Local only", plan.localOnly, undefined, plan.localOnly.length > 0);
  printNamedList("Remote only", plan.remoteOnly, undefined, plan.remoteOnly.length > 0);
  if (
    plan.localDirs.length === 0 &&
    plan.changedDocs.length === 0 &&
    plan.changedFiles.length === 0 &&
    plan.localOnly.length === 0 &&
    plan.remoteOnly.length === 0
  ) {
    console.log(color.green("No push actions."));
  }
}

function printPushResult(result: PushResult): void {
  printNamedList("Uploaded", result.uploaded, undefined, result.uploaded.length > 0, color.green);
  printNamedList("Moved", result.moved, undefined, result.moved.length > 0, color.cyan);
  printNamedList("Deleted", result.deleted, undefined, result.deleted.length > 0, color.yellow);
  printNamedList("Skipped", result.skipped, undefined, result.skipped.length > 0, color.red);
}

function printPushDryRun(plan: PushPlan): void {
  console.log(color.bold("Push plan"));
  printPushPlan(plan);
}

async function readCookieFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function downloadProjectZip(client: OverleafClient, projectId: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "olfs-"));
  const zipPath = path.join(tempDir, `${projectId}.zip`);
  await client.downloadZip(projectId, zipPath);
  return zipPath;
}

async function askConflictChoice(filePath: string): Promise<"local" | "remote" | "skip"> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question(
        `${color.red("Conflict")} ${filePath}\nKeep [l]ocal, keep [r]emote, or [s]kip? `,
      )).trim().toLowerCase();
      if (answer === "l" || answer === "local") return "local";
      if (answer === "r" || answer === "remote") return "remote";
      if (answer === "s" || answer === "skip" || answer === "") return "skip";
    }
  } finally {
    rl.close();
  }
}

async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
    const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function confirmForceAction(action: "pull" | "push", projectRoot: string): Promise<void> {
  const messages = {
    pull: "Force pull skips status/conflict prompts and mirrors the remote project into this folder.",
    push: "Force push skips status/conflict prompts and mirrors this folder into the remote project.",
  };
  const ok = await askYesNo(`${color.red("Force mode")} ${messages[action]}\nProject: ${projectRoot}\nContinue?`, false);
  if (!ok) {
    throw new OlfsError(`Force ${action} cancelled.`);
  }
}

function hasBlockingRemoteChanges(status: SmartStatus, resolvedConflicts: string[] = []): boolean {
  const resolved = new Set(resolvedConflicts);
  return status.remoteModified.length > 0 ||
    status.remoteAdded.length > 0 ||
    status.remoteDeleted.length > 0 ||
    status.unknownChanged.length > 0 ||
    status.conflicts.some((name) => !resolved.has(name));
}

function hasLocalRiskForPull(status: SmartStatus): boolean {
  return status.localModified.length > 0 ||
    status.localAdded.length > 0 ||
    status.localDeleted.length > 0 ||
    status.conflicts.length > 0 ||
    status.unknownChanged.length > 0;
}

function shouldWarnAboutMissingGit(argv: string[]): boolean {
  const args = normalizeCliArgs(argv).slice(2);
  if (args.length === 0) {
    return false;
  }
  return !args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V");
}

async function warnIfGitMissing(argv: string[]): Promise<void> {
  if (shouldWarnAboutMissingGit(argv) && !await isGitAvailable()) {
    console.error(color.yellow(`Warning: ${gitMissingWarning}`));
  }
}

function resolvePushCommitMessage(options: { message?: string; comment?: string }): string {
  if (options.message && options.comment && options.message !== options.comment) {
    throw new OlfsError("Use either --message or --comment for the git commit message, not both with different values.");
  }
  return options.message ?? options.comment ?? "olfs push";
}

async function commitAfterPush(projectRoot: string, message: string): Promise<void> {
  let result: GitCommitResult;
  try {
    result = await commitProjectSnapshot(projectRoot, message);
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
    console.error(color.yellow(`Warning: git commit failed after successful push.${detail}`));
    return;
  }

  if (result.committed) {
    console.log(`Committed local snapshot ${result.commitHash ?? ""}`.trim());
    return;
  }

  console.log(color.yellow(`Skipped git commit: ${result.skippedReason ?? "nothing to commit"}.`));
}

export function normalizeCliArgs(argv: string[]): string[] {
  const args = [...argv];
  if (args[2] === "--") {
    args.splice(2, 1);
  }
  return args;
}

const program = new Command();
export const PROJECT_REPOSITORY = "[Guosen-Wu/overleaf-folder-sync](https://github.com/Guosen-Wu/overleaf-folder-sync)";

program
  .name("olfs")
  .description("Overleaf folder sync CLI")
  .version("0.1.0");

program
  .command("about")
  .description("Show project information")
  .action(() => {
    console.log(PROJECT_REPOSITORY);
  });

const auth = program.command("auth").description("Manage Overleaf authentication");

auth
  .command("set-cookie")
  .description("Store an overleaf_session2 cookie value")
  .argument("[cookie]", "raw overleaf_session2 value or a Cookie header containing it")
  .option("--stdin", "read the cookie from stdin")
  .action(async (cookieArg: string | undefined, options: { stdin?: boolean }) => {
    const cookie = options.stdin ? await readCookieFromStdin() : cookieArg;
    if (!cookie) {
      throw new OlfsError("Provide an overleaf_session2 value, or pass --stdin.");
    }

    const stored = await saveSessionCookie(cookie);
    console.log(`Saved overleaf_session2 auth to ${authFilePath()}`);
    console.log(`Updated at ${stored.updatedAt}`);
  });

auth
  .command("whoami")
  .description("Validate the stored cookie and print the Overleaf user")
  .action(async () => {
    const client = await authenticatedClient();
    const identity = await client.refreshIdentity();
    if (identity.userEmail || identity.userId) {
      console.log([identity.userEmail, identity.userId].filter(Boolean).join("\t"));
    } else {
      console.log("Cookie accepted, but this Overleaf page did not expose user identity metadata.");
    }
  });

auth
  .command("diagnose")
  .description("Print non-secret diagnostics for the Overleaf /project response")
  .action(async () => {
    const client = await authenticatedClient();
    console.log(JSON.stringify(await client.diagnoseDashboard(), null, 2));
  });

program
  .command("list")
  .description("List active Overleaf projects")
  .option("--all", "include archived and trashed projects")
  .action(async (options: { all?: boolean }) => {
    const client = await authenticatedClient();
    const projects = await client.listProjects(Boolean(options.all));

    for (const project of projects.sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""))) {
      printProject(project);
    }
  });

program
  .command("bind")
  .description("Bind a local folder to an Overleaf project")
  .requiredOption("--project-id <projectId>", "Overleaf project id")
  .option("--path <path>", "local folder path", ".")
  .action(async (options: { projectId: string; path: string }) => {
    const config = await saveLocalProjectConfig(options.path, options.projectId);
    const git = await ensureGitRepository(config.path);
    console.log(`Bound ${config.path} to Overleaf project ${config.projectId}`);
    if (git.initialized) {
      console.log(`Initialized git repository at ${config.path}`);
    } else if (git.alreadyRepository) {
      console.log("Git repository already present; skipped git init.");
    } else {
      console.log("Skipped git repository initialization because git is not available.");
    }
    console.log(`Created .olfs/config.json and .olfs/bin/${currentScriptGlob()}`);
  });

program
  .command("project-info")
  .description("Fetch metadata for a project")
  .option("--project-id <projectId>", "Overleaf project id; defaults to local binding")
  .option("--path <path>", "local folder path for binding lookup", ".")
  .action(async (options: { projectId?: string; path: string }) => {
    const projectId = options.projectId ?? (await loadLocalProjectConfig(options.path)).projectId;
    const client = await authenticatedClient();
    const info = await client.projectInfo(projectId);
    console.log(JSON.stringify(info, null, 2));
  });

program
  .command("pull")
  .description("Download the bound project zip and extract it into the local folder")
  .option("--project-id <projectId>", "Overleaf project id; defaults to local binding")
  .option("--path <path>", "local folder path", ".")
  .option("--zip-only <file>", "write the zip archive to this path instead of extracting")
  .option("--dry-run", "show status without writing files")
  .option("--yes", "answer yes to safe initialization prompts")
  .option("--force", "skip status/conflict checks after confirmation and mirror remote files to local")
  .action(async (options: { projectId?: string; path: string; zipOnly?: string; dryRun?: boolean; yes?: boolean; force?: boolean }) => {
    const projectRoot = path.resolve(options.path);
    const projectId = options.projectId ?? (await loadLocalProjectConfig(projectRoot)).projectId;
    const client = await authenticatedClient();
    const zipPath = await downloadProjectZip(client, projectId);

    if (options.zipOnly) {
      const target = path.resolve(options.zipOnly);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(zipPath, target);
      console.log(`Wrote ${target}`);
      return;
    }

    if (options.force) {
      if (options.dryRun) {
        throw new OlfsError("pull --force cannot be combined with --dry-run.");
      }
      await confirmForceAction("pull", projectRoot);
      const localFiles = await scanLocalFiles(projectRoot);
      const diff = await diffLocalAgainstZip(localFiles, zipPath);
      const summary = await extractZipToFolder(zipPath, projectRoot);
      const deleted = await deleteLocalFiles(projectRoot, diff.localOnly);
      await saveBaselineFromZip(projectRoot, projectId, zipPath);
      console.log(`Force pulled ${summary.written.length} file(s) into ${projectRoot}`);
      if (deleted.length) {
        console.log(`Deleted ${deleted.length} local file(s) not present on remote.`);
      }
      console.log("Updated .olfs/baseline.json");
      return;
    }

    const keep = await createIgnoreFilter(projectRoot);
    const status = await computeSmartStatus(projectRoot, projectId, zipPath);
    if (options.dryRun) {
      printSmartStatus(status);
      return;
    }
    printActionStatusSummary(status);

    if (!status.baselineAvailable) {
      const localFiles = await scanLocalFiles(projectRoot);
      if (localFiles.length > 0 && !options.yes) {
        const ok = await askYesNo(
          `No baseline exists and ${localFiles.length} local file(s) are present. Initialize this folder from remote and overwrite matching files?`,
          false,
        );
        if (!ok) {
          throw new OlfsError("Pull cancelled. Run with --yes to initialize from remote.");
        }
      }

      const summary = await extractZipToFolder(zipPath, projectRoot, keep);
      await saveBaselineFromZip(projectRoot, projectId, zipPath);
      console.log(`Initialized from remote: pulled ${summary.written.length} files into ${projectRoot}`);
      console.log("Updated .olfs/baseline.json");
      return;
    }

    if (hasLocalRiskForPull(status)) {
      const remoteWins: string[] = [...status.remoteModified, ...status.remoteAdded];
      const localDeletes: string[] = [...status.remoteDeleted];
      const localProtected: string[] = [...status.localModified, ...status.localAdded, ...status.localDeleted, ...status.unknownChanged];

      for (const filePath of status.conflicts) {
        const choice = await askConflictChoice(filePath);
        if (choice === "remote") remoteWins.push(filePath);
        else localProtected.push(filePath);
      }

      if (localProtected.length) {
        console.log(color.yellow("Keeping local versions for:"));
        localProtected.forEach((name) => console.log(color.yellow(`  ${name}`)));
      }

      if (remoteWins.length === 0 && localDeletes.length === 0) {
        console.log(color.yellow("No remote files selected for pull."));
        return;
      }

      const summary = await extractFilesFromZip(zipPath, projectRoot, remoteWins);
      const deleted = await deleteLocalFiles(projectRoot, localDeletes);
      await saveBaselineFromLocal(projectRoot, projectId);
      console.log(`Pulled ${summary.written.length} selected files into ${projectRoot}`);
      if (deleted.length) {
        console.log(`Deleted ${deleted.length} local file(s) removed on remote.`);
      }
      console.log("Updated .olfs/baseline.json");
      return;
    }

    const pullPaths = [...status.remoteModified, ...status.remoteAdded];
    const summary = pullPaths.length
      ? await extractFilesFromZip(zipPath, projectRoot, pullPaths)
      : await extractZipToFolder(zipPath, projectRoot, keep);
    const deleted = await deleteLocalFiles(projectRoot, status.remoteDeleted);
    await saveBaselineFromZip(projectRoot, projectId, zipPath);
    console.log(`Pulled ${summary.written.length} files into ${projectRoot}`);
    if (deleted.length) {
      console.log(`Deleted ${deleted.length} local file(s) removed on remote.`);
    }
    console.log("Updated .olfs/baseline.json");
  });

program
  .command("status")
  .description("Compare local files with the current remote project zip")
  .option("--project-id <projectId>", "Overleaf project id; defaults to local binding")
  .option("--path <path>", "local folder path", ".")
  .option("--local", "only compare local files with the last baseline; does not contact Overleaf")
  .action(async (options: { projectId?: string; path: string; local?: boolean }) => {
    const projectRoot = path.resolve(options.path);
    const projectId = options.projectId ?? (await loadLocalProjectConfig(projectRoot)).projectId;
    if (options.local) {
      printSmartStatus(await computeLocalStatus(projectRoot, projectId));
      return;
    }

    const client = await authenticatedClient();
    const zipPath = await downloadProjectZip(client, projectId);
    printSmartStatus(await computeSmartStatus(projectRoot, projectId, zipPath));
  });

program
  .command("compile")
  .description("Compile an Overleaf project, parse the log, and optionally save outputs")
  .option("--project-id <projectId>", "Overleaf project id; defaults to local binding")
  .option("--path <path>", "local folder path for binding lookup", ".")
  .option("--root <file>", "root TeX file path to compile, for example main.tex")
  .option("--set-root <file>", "set the Overleaf project root document before compiling")
  .option("--compiler <compiler>", "set the Overleaf project compiler before compiling")
  .option("--settings", "print known compile settings before compiling")
  .option("--draft", "compile in draft mode")
  .option("--stop-on-first-error", "ask Overleaf to stop compilation on the first LaTeX error")
  .option("--raw-log", "print the full output.log instead of a parsed summary")
  .option("--log-out <file>", "write the full output.log to a file")
  .option("--pdf-out <file>", "write the compiled PDF to a file")
  .option("--output-dir <dir>", "write all returned compile output files to a directory")
  .option("--json", "print compile status and parsed log entries as JSON")
  .action(async (options: {
    projectId?: string;
    path: string;
    root?: string;
    setRoot?: string;
    compiler?: string;
    settings?: boolean;
    draft?: boolean;
    stopOnFirstError?: boolean;
    rawLog?: boolean;
    logOut?: string;
    pdfOut?: string;
    outputDir?: string;
    json?: boolean;
  }) => {
    const projectId = options.projectId ?? (await loadLocalProjectConfig(options.path)).projectId;
    const client = await authenticatedClient();
    if (options.settings || options.setRoot || options.compiler) {
      const tree = await client.projectTree(projectId);
      if (options.settings) {
        const settings = await client.projectSettings(projectId);
        console.log(JSON.stringify({
          compiler: tree.compiler,
          rootDocId: tree.rootDoc_id,
          compilers: settings.compilers,
        }, null, 2));
      }
      if (options.setRoot) {
        const remoteIndex = indexProjectTree(tree);
        const rootEntry = remoteIndex.get(options.setRoot);
        if (!rootEntry || rootEntry.type !== "doc") {
          throw new OlfsError(`Root document was not found as an Overleaf doc: ${options.setRoot}`);
        }
        await client.updateProjectSettings(projectId, { rootDocId: rootEntry.entity._id });
      }
      if (options.compiler) {
        await client.updateProjectSettings(projectId, { compiler: options.compiler });
      }
    }
    const result = await client.compileProjectAndFetchLog(projectId, {
      rootResourcePath: options.root ?? options.setRoot,
      draft: Boolean(options.draft),
      stopOnFirstError: Boolean(options.stopOnFirstError),
    });

    if (options.logOut) {
      const target = path.resolve(options.logOut);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, result.log, "utf8");
    }
    if (options.pdfOut) {
      const pdf = result.outputs.find((file) => file.type === "pdf" || file.path.endsWith(".pdf"));
      if (!pdf) {
        throw new OlfsError("Compile completed, but Overleaf did not return a PDF output file.");
      }
      const target = path.resolve(options.pdfOut);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await client.downloadCompileOutputFile(result.compile, pdf));
    }
    if (options.outputDir) {
      const targetDir = path.resolve(options.outputDir);
      for (const output of result.outputs) {
        const normalized = output.path.replace(/\\/g, "/").replace(/^\/+/, "");
        const target = path.resolve(targetDir, normalized);
        const rootWithSep = `${targetDir}${path.sep}`;
        if (!target.startsWith(rootWithSep)) {
          throw new OlfsError(`Refusing to write compile output outside target folder: ${output.path}`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await client.downloadCompileOutputFile(result.compile, output));
      }
    }

    const parsed = new LatexLogParser(result.log).parse();
    if (options.json) {
      console.log(JSON.stringify({
        status: result.compile.status,
        stats: result.compile.stats,
        timings: result.compile.timings,
        outputFiles: result.compile.outputFiles?.map((file) => ({
          path: file.path,
          type: file.type,
          build: file.build,
        })),
        logPath: options.logOut ? path.resolve(options.logOut) : undefined,
        pdfPath: options.pdfOut ? path.resolve(options.pdfOut) : undefined,
        outputDir: options.outputDir ? path.resolve(options.outputDir) : undefined,
        errors: parsed.errors,
        warnings: parsed.warnings,
        information: parsed.information,
      }, null, 2));
      return;
    }

    if (options.rawLog) {
      process.stdout.write(result.log);
      if (!result.log.endsWith("\n")) {
        process.stdout.write("\n");
      }
      return;
    }

    printCompileSummary(result.compile.status, parsed);
    if (options.logOut) {
      console.log(`log\t${path.resolve(options.logOut)}`);
    }
    if (options.pdfOut) {
      console.log(`pdf\t${path.resolve(options.pdfOut)}`);
    }
    if (options.outputDir) {
      console.log(`outputs\t${path.resolve(options.outputDir)}`);
    }
  });

program
  .command("push")
  .description("Upload local changes to Overleaf")
  .option("--project-id <projectId>", "Overleaf project id; defaults to local binding")
  .option("--path <path>", "local folder path", ".")
  .option("--dry-run", "show the push plan without writing to Overleaf")
  .option("--force", "skip status/conflict checks after confirmation and mirror local files to remote")
  .option("-m, --message <message>", "git commit message after a successful push")
  .option("--comment <comment>", "alias for --message")
  .action(async (options: { projectId?: string; path: string; dryRun?: boolean; force?: boolean; message?: string; comment?: string }) => {
    const projectRoot = path.resolve(options.path);
    const projectId = options.projectId ?? (await loadLocalProjectConfig(projectRoot)).projectId;
    const commitMessage = resolvePushCommitMessage(options);
    const client = await authenticatedClient();
    const zipPath = await downloadProjectZip(client, projectId);
    if (options.force) {
      if (options.dryRun) {
        throw new OlfsError("push --force cannot be combined with --dry-run.");
      }
      await confirmForceAction("push", projectRoot);
      const plan = await planPush(client, projectId, projectRoot, zipPath);
      printPushDryRun(plan);

      const result = await pushLocalChanges(client, projectId, projectRoot, zipPath, undefined, undefined, {
        deleteRemoteOnly: true,
      });
      if ((result.uploaded.length > 0 || result.deleted.length > 0) && result.skipped.length === 0) {
        await saveBaselineFromLocal(projectRoot, projectId);
      }
      printPushResult(result);
      if (result.skipped.length === 0) {
        await commitAfterPush(projectRoot, commitMessage);
      }
      return;
    }

    const status = await computeSmartStatus(projectRoot, projectId, zipPath);
    printActionStatusSummary(status);
    const conflictLocalWins: string[] = [];
    const conflictRemoteWins: string[] = [];
    const conflictSkipped: string[] = [];

    if (!options.dryRun && status.conflicts.length > 0) {
      for (const filePath of status.conflicts) {
        const choice = await askConflictChoice(filePath);
        if (choice === "local") conflictLocalWins.push(filePath);
        else if (choice === "remote") conflictRemoteWins.push(filePath);
        else conflictSkipped.push(filePath);
      }

      if (conflictRemoteWins.length > 0) {
        const summary = await extractFilesFromZip(zipPath, projectRoot, conflictRemoteWins);
        console.log(color.cyan(`Restored ${summary.written.length} conflict file(s) from remote.`));
      }
    }

    if (!options.dryRun && hasBlockingRemoteChanges(status, [...conflictLocalWins, ...conflictRemoteWins])) {
      throw new OlfsError("Remote changes are present. Pull first, or resolve conflicts before pushing.");
    }

    const allowedPushPaths = [
      ...status.localModified,
      ...status.localAdded,
      ...status.localDeleted,
      ...conflictLocalWins,
    ];
    const plan = await planPush(client, projectId, projectRoot, zipPath);

    if (options.dryRun) {
      printPushDryRun(plan);
      return;
    }

    const result = await pushLocalChanges(client, projectId, projectRoot, zipPath, status, allowedPushPaths);
    if ((result.uploaded.length > 0 || result.deleted.length > 0) && result.skipped.length === 0) {
      await saveBaselineFromLocal(projectRoot, projectId);
    }
    printPushResult(result);
    if (conflictSkipped.length) {
      console.log(color.yellow(`conflict-skipped\t${conflictSkipped.length}`));
      conflictSkipped.forEach((name) => console.log(color.yellow(`  ${name}`)));
    }
    if (result.skipped.length === 0 && conflictSkipped.length === 0) {
      await commitAfterPush(projectRoot, commitMessage);
    }
  });

program
  .command("sync")
  .description("Two-way sync with conflict prompts")
  .option("--project-id <projectId>", "Overleaf project id; defaults to local binding")
  .option("--path <path>", "local folder path", ".")
  .option("--dry-run", "show the sync plan without writing files")
  .action(async (options: { projectId?: string; path: string; dryRun?: boolean }) => {
    const projectRoot = path.resolve(options.path);
    const projectId = options.projectId ?? (await loadLocalProjectConfig(projectRoot)).projectId;
    const client = await authenticatedClient();
    const zipPath = await downloadProjectZip(client, projectId);
    const status = await computeSmartStatus(projectRoot, projectId, zipPath);
    printActionStatusSummary(status);

    const conflictLocalWins: string[] = [];
    const conflictRemoteWins: string[] = [];
    const conflictSkipped: string[] = [];

    if (!options.dryRun) {
      for (const filePath of status.conflicts) {
        const choice = await askConflictChoice(filePath);
        if (choice === "local") conflictLocalWins.push(filePath);
        else if (choice === "remote") conflictRemoteWins.push(filePath);
        else conflictSkipped.push(filePath);
      }
    }

    const pullPaths = [...status.remoteModified, ...status.remoteAdded, ...conflictRemoteWins];
    const pullDeletes = [...status.remoteDeleted];
    const pushPaths = [
      ...status.localModified,
      ...status.localAdded,
      ...status.localDeleted,
      ...conflictLocalWins,
    ];

    const plan = await planPush(client, projectId, projectRoot, zipPath);

    if (options.dryRun) {
      printPushDryRun(plan);
      return;
    }

    if (pullPaths.length) {
      const summary = await extractFilesFromZip(zipPath, projectRoot, pullPaths);
      console.log(`Pulled ${summary.written.length} file(s).`);
    }
    if (pullDeletes.length) {
      const deleted = await deleteLocalFiles(projectRoot, pullDeletes);
      console.log(`Deleted ${deleted.length} local file(s) removed on remote.`);
    }

    const result = await pushLocalChanges(client, projectId, projectRoot, zipPath, status, pushPaths);
    printPushResult(result);
    if (conflictSkipped.length) {
      console.log(color.yellow(`conflict-skipped\t${conflictSkipped.length}`));
      conflictSkipped.forEach((name) => console.log(color.yellow(`  ${name}`)));
    }
    if (result.skipped.length === 0) {
      await saveBaselineFromLocal(projectRoot, projectId);
      console.log("Updated .olfs/baseline.json");
    }
  });

program.exitOverride();

export async function runCli(argv = process.argv): Promise<void> {
  try {
    await warnIfGitMissing(argv);
    await runWithOperationTimeout(() => program.parseAsync(normalizeCliArgs(argv)));
  } catch (error) {
    if (error instanceof OlfsError) {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
  } else if ((error as { code?: string }).code === "commander.helpDisplayed") {
    process.exitCode = 0;
  } else if ((error as { code?: string }).code === "commander.version") {
    process.exitCode = 0;
  } else if ((error as { code?: string }).code?.startsWith("commander.")) {
    process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
  } else {
      throw error;
    }
  } finally {
    if (activeClient && shouldPersistCookie && process.exitCode !== 1) {
      await saveCookieHeader(activeClient.cookieHeader);
    }
  }
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  await runCli();
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}
