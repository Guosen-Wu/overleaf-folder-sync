import assert from "node:assert/strict";
import test from "node:test";
import { renderProjectScript } from "./projectConfig.js";

test("renderProjectScript closes the current Terminal window on macOS after Enter", () => {
  const script = renderProjectScript("/Users/alice/paper", "olfs status --path \"$PROJECT_ROOT\"", "darwin");

  assert.match(script, /Press Enter to close\.\.\./);
  assert.match(
    script,
    /osascript -e 'tell application "Terminal" to close front window'/,
  );
  assert.match(script, /exit \$STATUS/);
});

test("renderProjectScript keeps the Windows pause flow intact", () => {
  const script = renderProjectScript("C:/Users/alice/paper", "olfs status --path \"$PROJECT_ROOT\"", "win32");

  assert.match(script, /pause/);
  assert.match(script, /exit \/b %STATUS%/);
});
