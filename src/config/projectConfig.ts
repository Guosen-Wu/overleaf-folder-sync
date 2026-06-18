import fs from "node:fs/promises";
import path from "node:path";
import {
  legacyProjectBaselinePath,
  legacyProjectConfigPath,
  projectBaselinePath,
  projectBinDir,
  projectConfigPath,
  projectStateDir,
} from "./paths.js";
import { OlfsError } from "../util/errors.js";

export interface LocalProjectConfig {
  projectId: string;
  path: string;
  boundAt: string;
}

const defaultGitignoreEntries = [
  "# Overleaf Folder Sync",
  ".olfs/",
  ".olfs.json",
  ".olfs-cache/",
  ".olauth",
  "",
  "# macOS",
  ".DS_Store",
  "._*",
  "",
  "# Editors",
  ".vscode/",
  ".idea/",
  "*~",
  "*.swp",
  "*.swo",
  "",
  "# LaTeX build artifacts",
  "*.aux",
  "*.bbl",
  "*.bcf",
  "*.blg",
  "*.fdb_latexmk",
  "*.fls",
  "*.log",
  "*.out",
  "*.run.xml",
  "*.synctex.gz",
  "*.toc",
];

export function resolveProjectRoot(inputPath: string): string {
  return path.resolve(inputPath);
}

export function localConfigPath(projectRoot: string): string {
  return projectConfigPath(projectRoot);
}

export async function saveLocalProjectConfig(inputPath: string, projectId: string): Promise<LocalProjectConfig> {
  const projectRoot = resolveProjectRoot(inputPath);
  const config: LocalProjectConfig = {
    projectId,
    path: projectRoot,
    boundAt: new Date().toISOString(),
  };
  await fs.mkdir(projectStateDir(projectRoot), { recursive: true });
  await fs.writeFile(localConfigPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await ensureProjectGitignore(projectRoot);
  await migrateLegacyProjectState(projectRoot);
  await writeProjectScripts(projectRoot);
  return config;
}

async function writeProjectScripts(projectRoot: string): Promise<void> {
  const binDir = projectBinDir(projectRoot);
  await fs.mkdir(binDir, { recursive: true });
  await removeOtherPlatformScripts(binDir);

  for (const script of projectScripts()) {
    const name = `${script.name}${scriptExtension()}`;
    const filePath = path.join(binDir, name);
    const contents = renderProjectScript(projectRoot, script.command);
    await fs.writeFile(filePath, contents, { mode: 0o755 });
    await fs.chmod(filePath, 0o755);
  }
}

export function currentScriptGlob(): string {
  return `*${scriptExtension()}`;
}

function projectScripts(): Array<{ name: string; command: string }> {
  return [
    { name: "olfs-status", command: "olfs status --path \"$PROJECT_ROOT\"" },
    { name: "olfs-status-local", command: "olfs status --local --path \"$PROJECT_ROOT\"" },
    { name: "olfs-compile", command: "olfs compile --path \"$PROJECT_ROOT\"" },
    { name: "olfs-pull", command: "olfs pull --yes --path \"$PROJECT_ROOT\"" },
    { name: "olfs-pull-force", command: "olfs pull --force --path \"$PROJECT_ROOT\"" },
    { name: "olfs-push", command: "olfs push --path \"$PROJECT_ROOT\"" },
    { name: "olfs-push-force", command: "olfs push --force --path \"$PROJECT_ROOT\"" },
    { name: "olfs-sync", command: "olfs sync --path \"$PROJECT_ROOT\"" },
  ];
}

function scriptExtension(): ".cmd" | ".command" | ".sh" {
  if (process.platform === "win32") {
    return ".cmd";
  }
  if (process.platform === "darwin") {
    return ".command";
  }
  return ".sh";
}

function renderProjectScript(projectRoot: string, command: string): string {
  if (process.platform === "win32") {
    const windowsRoot = projectRoot.replace(/\//g, "\\");
    const windowsCommand = command.replace(/\$PROJECT_ROOT/g, "%PROJECT_ROOT%");
    return [
      "@echo off",
      "setlocal",
      `set "PROJECT_ROOT=${windowsRoot}"`,
      "cd /d \"%PROJECT_ROOT%\" || exit /b 1",
      "echo Overleaf Folder Sync",
      "echo Project: %PROJECT_ROOT%",
      "echo.",
      windowsCommand,
      "set STATUS=%ERRORLEVEL%",
      "echo.",
      "echo Exit code: %STATUS%",
      "pause",
      "exit /b %STATUS%",
      "",
    ].join("\r\n");
  }

  const shell = process.platform === "darwin" ? "/bin/zsh" : "/usr/bin/env bash";
  return [
    `#!${shell}`,
    "export PATH=\"$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH\"",
    `PROJECT_ROOT=${shellQuote(projectRoot)}`,
    "cd \"$PROJECT_ROOT\" || exit 1",
    "echo \"Overleaf Folder Sync\"",
    "echo \"Project: $PROJECT_ROOT\"",
    "echo",
    command,
    "STATUS=$?",
    "echo",
    "echo \"Exit code: $STATUS\"",
    process.platform === "darwin" ? "echo \"Press Enter to close...\"" : "echo \"Press Enter to close...\"",
    "read",
    "exit $STATUS",
    "",
  ].join("\n");
}

async function removeOtherPlatformScripts(binDir: string): Promise<void> {
  const current = scriptExtension();
  for (const script of projectScripts()) {
    for (const extension of [".cmd", ".command", ".sh"]) {
      if (extension !== current) {
        await fs.rm(path.join(binDir, `${script.name}${extension}`), { force: true });
      }
    }
  }
}

async function migrateLegacyProjectState(projectRoot: string): Promise<void> {
  const oldBaseline = legacyProjectBaselinePath(projectRoot);
  const newBaseline = projectBaselinePath(projectRoot);

  try {
    await fs.access(newBaseline);
  } catch {
    try {
      await fs.mkdir(path.dirname(newBaseline), { recursive: true });
      await fs.copyFile(oldBaseline, newBaseline);
    } catch {
      // No legacy baseline to migrate.
    }
  }

  await fs.rm(legacyProjectConfigPath(projectRoot), { force: true });
  await fs.rm(path.join(projectRoot, ".olfs-cache"), { recursive: true, force: true });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function ensureProjectGitignore(projectRoot: string): Promise<void> {
  const filePath = path.join(projectRoot, ".gitignore");
  const desired = defaultGitignoreEntries.join("\n");

  let current = "";
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch {
    await fs.writeFile(filePath, `${desired}\n`, "utf8");
    return;
  }

  const missing = defaultGitignoreEntries.filter((entry) => {
    if (!entry || entry.startsWith("#")) {
      return false;
    }
    return !current.split(/\r?\n/).includes(entry);
  });

  if (missing.length) {
    const prefix = current.endsWith("\n") ? "" : "\n";
    await fs.writeFile(filePath, `${current}${prefix}\n# Overleaf Folder Sync\n${missing.join("\n")}\n`, "utf8");
  }
}

export async function loadLocalProjectConfig(inputPath: string): Promise<LocalProjectConfig> {
  const projectRoot = resolveProjectRoot(inputPath);
  const filePath = localConfigPath(projectRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    try {
      parsed = JSON.parse(await fs.readFile(legacyProjectConfigPath(projectRoot), "utf8"));
      await fs.mkdir(projectStateDir(projectRoot), { recursive: true });
      await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    } catch {
      throw new OlfsError(`No .olfs/config.json found at ${projectRoot}. Run "olfs bind --project-id <id>" first.`);
    }
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as LocalProjectConfig).projectId !== "string"
  ) {
    throw new OlfsError(`${filePath} is invalid.`);
  }

  return parsed as LocalProjectConfig;
}
