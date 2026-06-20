import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

export type IgnoreFilter = (relativePath: string) => boolean;

export async function createIgnoreFilter(root: string): Promise<IgnoreFilter> {
  const ig = ignore()
    .add(".DS_Store")
    .add("**/.DS_Store")
    .add(".git")
    .add(".gitignore")
    .add(".olignore")
    .add(".olfs")
    .add(".olfs.json")
    .add(".olfs-cache")
    .add("node_modules");

  try {
    const contents = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    ig.add(contents);
  } catch {
    // Missing .gitignore is fine.
  }

  try {
    const contents = await fs.readFile(path.join(root, ".olignore"), "utf8");
    ig.add(contents);
  } catch {
    // Missing .olignore means all regular project files are included.
  }

  return (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    return !ig.ignores(normalized) && !ig.ignores(`${normalized}/`);
  };
}
