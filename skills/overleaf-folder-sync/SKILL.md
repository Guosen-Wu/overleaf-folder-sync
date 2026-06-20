---
name: overleaf-folder-sync
description: Use when the user wants Codex to operate Overleaf Folder Sync, olfs, or an installed overleaf-folder-sync CLI to bind a local folder to Overleaf, inspect auth, list projects, pull, push, sync, check status, fetch compile outputs, or help with Overleaf project synchronization workflows.
metadata:
  short-description: Operate the olfs Overleaf sync CLI
---

# Overleaf Folder Sync

Use this skill when the user wants help operating the installed `olfs` CLI.
Assume the CLI may already be installed globally through npm or `pnpm link --global`, but verify before using it.

## First Checks

1. Check whether `olfs` is available:

```bash
olfs --help
```

If the command is missing, tell the user to install or link `overleaf-folder-sync` before continuing. Do not invent an installation path.

2. Check the current repository and target folder:

```bash
pwd
git status --short
```

Do not overwrite or delete user files without an explicit confirmation from the user.

3. Check authentication state when needed:

```bash
olfs auth whoami
```

If authentication is missing or expired, ask the user to run:

```bash
olfs auth set-cookie
```

Never ask the user to paste the cookie into the chat unless they explicitly choose to do so. Prefer interactive terminal entry.

## Common Workflows

### List Projects

Use this when the user wants to find a project id:

```bash
olfs list
```

Summarize the project names and ids that matter for the user's request.

### Bind A Folder

Before binding, inspect the folder contents and confirm the intended target path if it is ambiguous.

```bash
olfs bind --project-id <project-id> --path <folder>
```

After binding, explain that project state lives under `.olfs/`.

Explain that `olfs` respects `.gitignore` and `.olignore` as project submission filters. Use `.olignore` for files that should stay out of Overleaf sync without changing Git behavior.

### Check Status

Use this when the user wants to preview local/remote differences without changing files:

```bash
olfs status
```

`olfs pull`, `olfs push`, and `olfs sync` each run a fresh full status check internally before changing files. Avoid running a separate `olfs status` immediately before those commands unless the user specifically wants a preview, because it will usually duplicate the same remote check.

### Pull From Overleaf

`olfs pull` runs a full status check before changing local files, so a separate `olfs status` is not needed unless the user specifically wants to preview changes first.

```bash
olfs pull
```

If the user asks for a first-time initialization and wants fewer prompts:

```bash
olfs pull --yes
```

Only use `olfs pull --force` after explicit user confirmation because it mirrors the remote project into the local folder.

### Push To Overleaf

`olfs push` runs a full status check before changing the remote project, so a separate `olfs status` is not needed unless the user specifically wants to preview changes first.

`olfs push` skips paths ignored by `.gitignore` or `.olignore`; ignored remote files are not deleted merely because they are absent locally.

```bash
olfs push
```

Only use `olfs push --force` after explicit user confirmation because it mirrors the local folder into the remote Overleaf project.

### Sync Both Sides

Use this when the user wants the CLI's combined sync behavior. `olfs sync` runs a full status check before changing either side, so a separate `olfs status` is not needed unless the user specifically wants to preview changes first.

`olfs sync` applies the same `.gitignore` and `.olignore` filters used by `push` and regular `pull`.

```bash
olfs sync
```

### Compile And Fetch Outputs

For a normal compile check:

```bash
olfs compile
```

To save outputs:

```bash
olfs compile --pdf-out output.pdf
olfs compile --log-out output.log
olfs compile --output-dir .output
```

To adjust compile settings:

```bash
olfs compile --compiler xelatex
olfs compile --set-root main.tex
```

Confirm compile setting changes with the user when the correct compiler or root file is not obvious.

## Safety Rules

- Treat `.olfs/` and the authentication file as local state, not source material for commits.
- Do not commit cookies, `auth.json`, or copied terminal output containing secrets.
- Check `.gitignore` and `.olignore` when the user asks why a file is not being pushed, pulled, or shown in status output.
- Prefer `olfs status --local` for a fast local-only preview. Use regular `olfs status` when the user asks to inspect remote differences, but do not run it automatically right before `pull`, `push`, or `sync` because those commands run their own full status check.
- Ask before running any force command.
- Ask before resolving a real conflict unless the user has already stated the resolution policy.
- When command output includes project ids, filenames, compile errors, or conflict summaries, relay the relevant parts back to the user.

## Troubleshooting

- If `olfs auth whoami` fails, refresh the cookie with `olfs auth set-cookie`.
- If `olfs status` reports conflicts, summarize the conflicted files and ask how to resolve them.
- If compile fails, report the first meaningful LaTeX error and the affected file or line when available.
- If Overleaf behavior changed and a command fails unexpectedly, capture the command, error summary, and project context before suggesting next steps.
