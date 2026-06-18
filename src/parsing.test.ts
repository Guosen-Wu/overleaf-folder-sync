import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionCookie } from "./auth/cookieStore.js";
import { normalizeCliArgs } from "./cli.js";
import { LatexLogParser } from "./compile/latexLogParser.js";
import { OverleafClient } from "./overleaf/client.js";
import { readMetaContent, requireMetaContent } from "./overleaf/csrf.js";

test("parseSessionCookie accepts a raw cookie value", () => {
  assert.equal(parseSessionCookie("abc123"), "abc123");
});

test("parseSessionCookie extracts overleaf_session2 from a Cookie header", () => {
  assert.equal(parseSessionCookie("foo=bar; overleaf_session2=session-value%3D; theme=dark"), "session-value%3D");
});

test("parseSessionCookie preserves encoded signed cookie prefixes", () => {
  assert.equal(parseSessionCookie("s%3ABw"), "s%3ABw");
});

test("readMetaContent decodes HTML attribute JSON", () => {
  const html = '<meta name="ol-projects" data-type="json" content="[{&quot;_id&quot;:&quot;p1&quot;,&quot;name&quot;:&quot;Paper&quot;}]">';
  assert.equal(requireMetaContent(html, "ol-projects"), '[{"_id":"p1","name":"Paper"}]');
});

test("readMetaContent returns undefined when optional meta is absent", () => {
  assert.equal(readMetaContent("<html></html>", "ol-usersEmail"), undefined);
});

test("diagnoseDashboard reports dashboard markers without secrets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    '<html><head><title>Projects</title><meta name="ol-csrfToken" content="csrf"></head></html>',
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  )) as typeof fetch;

  try {
    const client = new OverleafClient({ overleafSession2: "s%3Aexample" });
    const diagnostics = await client.diagnoseDashboard();
    assert.equal(diagnostics.hasCsrfMeta, true);
    assert.equal(diagnostics.hasProjectsMeta, false);
    assert.equal(diagnostics.hasLoginForm, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeCliArgs removes pnpm's command separator before subcommands", () => {
  assert.deepEqual(
    normalizeCliArgs(["node", "src/cli.ts", "--", "pull", "--project-id", "p1"]),
    ["node", "src/cli.ts", "pull", "--project-id", "p1"],
  );
});

test("LatexLogParser extracts compile errors and warnings", () => {
  const parsed = new LatexLogParser([
    "(./main.tex",
    "! Undefined control sequence.",
    "l.7 \\notacommand",
    "",
    "",
    "LaTeX Warning: Reference `missing' on page 1 undefined on input line 12.",
    ")",
  ].join("\n")).parse();

  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].message, "Undefined control sequence.");
  assert.equal(parsed.errors[0].line, 7);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.warnings[0].line, 12);
});
