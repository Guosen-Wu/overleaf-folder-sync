import os from "node:os";
import path from "node:path";

export function configDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "overleaf-folder-sync");
  }
  return path.join(os.homedir(), ".config", "overleaf-folder-sync");
}

export function authFilePath(): string {
  return path.join(configDir(), "auth.json");
}

export const projectStateDirName = ".olfs";
export const localProjectConfigName = "config.json";

export function projectStateDir(projectRoot: string): string {
  return path.join(projectRoot, projectStateDirName);
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), localProjectConfigName);
}

export function legacyProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".olfs.json");
}

export function projectBaselinePath(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), "baseline.json");
}

export function legacyProjectBaselinePath(projectRoot: string): string {
  return path.join(projectRoot, ".olfs-cache", "baseline.json");
}

export function projectBinDir(projectRoot: string): string {
  return path.join(projectStateDir(projectRoot), "bin");
}
