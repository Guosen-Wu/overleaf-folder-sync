# Overleaf Folder Sync

`olfs` is a TypeScript CLI for syncing a local folder with Overleaf using a
user-provided `overleaf_session2` cookie. It does not implement web login.

## Quick Start

```bash
pnpm install
pnpm build
pnpm dev -- auth set-cookie
pnpm dev -- list
pnpm dev -- bind --project-id <id> --path .
pnpm dev -- pull
```

Authentication is stored in `~/.config/overleaf-folder-sync/auth.json` with
mode `0600`.

## Project Layout

Project state lives under `.olfs/` in the bound folder:

- `.olfs/config.json`
- `.olfs/baseline.json`
- `.olfs/bin/*.command`

## Status And Ignore Rules

`olfs bind` creates or updates a project `.gitignore` with common local-only
entries such as `.DS_Store`, editor folders, `.olfs/`, and LaTeX build
artifacts. Sync scans read both `.gitignore` and `.olignore`.

`olfs status --local` is fast and compares local files with the last saved
baseline only. `olfs status` contacts Overleaf and downloads the project zip so
it can tell whether the remote side changed.

`pull`, `push`, and `sync` run a full status check first. If both local and
remote changed the same file, the CLI asks whether to keep the local version,
keep the remote version, or skip that file.

Use `pull --force` or `push --force` to skip status/conflict prompts after a
runtime confirmation. Force pull mirrors the remote project into the local
folder. Force push mirrors the local folder into the remote project. Normal push
supports updating existing docs, replacing uploaded files, creating new
docs/files/folders, moving or renaming files when a baseline match is clear, and
deleting remote files when they were deleted locally.

On first pull, when no `.olfs/baseline.json` exists yet, `pull` initializes the
folder from the remote project. If local files already exist, the CLI asks before
overwriting matching files; use `pull --yes` to initialize without prompting.

## Platform Scripts

`olfs bind` creates launcher scripts in `.olfs/bin/` for the current platform:

- macOS: `.command`
- Linux: `.sh`
- Windows: `.cmd`

The generated scripts cover status, compile, pull, pull-force, push, push-force,
and sync.

## Compile Outputs

`olfs compile` fetches `output.log` and prints parsed errors/warnings. It can
also save compile artifacts and update project compile settings:

```bash
olfs compile --pdf-out output.pdf
olfs compile --log-out output.log
olfs compile --output-dir .output
olfs compile --compiler xelatex
olfs compile --set-root main.tex
```

## Global CLI

To install the current workspace build as a global `olfs` command:

```bash
cd /Users/stesen/Project/P_OverleafFolderSync
pnpm link --global
```

Rebuild after edits with:

```bash
pnpm build
```
