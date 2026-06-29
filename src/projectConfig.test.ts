import assert from "node:assert/strict";
import test from "node:test";
import { renderProjectScript } from "./config/projectConfig.js";

test("renderProjectScript closes the current Terminal window on macOS after Enter", () => {
  const script = renderProjectScript("/Users/alice/paper", 'status --path "$PROJECT_ROOT"', "darwin", "/opt/homebrew/bin/olfs");

  assert.match(script, /Press Enter to close\.\.\./);
  assert.match(
    script,
    /osascript -e 'tell application "Terminal" to close front window'/,
  );
  assert.match(script, /exit \$STATUS/);
  assert.match(script, /\/opt\/homebrew\/bin\/olfs'? status --path "\$PROJECT_ROOT"/);
});

test("renderProjectScript keeps the Windows pause flow intact", () => {
  const script = renderProjectScript("C:/Users/alice/paper", 'status --path "$PROJECT_ROOT"', "win32", "C:/Tools/olfs.cmd");

  assert.match(script, /pause/);
  assert.match(script, /exit \/b %STATUS%/);
  assert.match(script, /"C:\\Tools\\olfs\.cmd" status --path "%PROJECT_ROOT%"/);
});
