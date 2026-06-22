import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

export function packageVersion(): string {
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version) {
    return "0.0.0";
  }
  return parsed.version;
}
