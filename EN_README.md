# Overleaf Folder Sync

[中文 README](./README.md)

`Overleaf Folder Sync` is a TypeScript command-line tool for synchronizing a local folder with an Overleaf project. It exposes the `olfs` command and supports project binding, pulling, pushing, status checks, conflict handling, and compile artifact retrieval.

The project is designed for researchers and writers who want to keep using local editors, Git, terminals, and automation scripts while collaborating through Overleaf.

## Features

- Bind a local folder to an Overleaf project.
- Authenticate with a user-provided `overleaf_session2` cookie. The CLI does not implement web login.
- Pull, push, and sync project files with a status check before changing either side.
- Detect conflicts against a saved baseline and ask how to resolve files changed on both sides.
- Respect `.gitignore` and `.olignore` as project submission filters to avoid uploading, pulling, or deleting local temporary files, editor state, and LaTeX build outputs.
- Check for a local Git repository when binding; if the folder is not already in a Git work tree and `git` is available, run `git init`.
- Fetch compile logs, PDFs, and other compile artifacts from Overleaf.
- Generate platform-specific launcher scripts for common commands.

## Installation

Install globally with `pnpm`:

```bash
pnpm add -g overleaf-folder-sync
```

You can also run it without installing:

```bash
pnpm dlx overleaf-folder-sync --help
```

After installation, the global `olfs` command becomes available:

```bash
olfs --help
```

If you use `npm`:

```bash
npm install -g overleaf-folder-sync
npx overleaf-folder-sync --help
```

For development from source, run commands directly:

```bash
pnpm dev -- --help
```

## Quick Start

1. Set the Overleaf cookie:

```bash
olfs auth set-cookie
```

2. Verify the active account:

```bash
olfs auth whoami
```

3. List accessible Overleaf projects:

```bash
olfs list
```

4. Bind a local folder to an Overleaf project:

```bash
olfs bind --project-id <project-id> --path .
```

5. Pull project files from Overleaf:

```bash
olfs pull
```

6. Push local changes back to Overleaf:

```bash
olfs push
```

## Common Commands

```bash
olfs status
olfs status --local
olfs pull
olfs pull --force
olfs push
olfs push --message "update experiment results"
olfs push --force
olfs sync
olfs compile
```

`status --local` compares local files with the last saved baseline and is fast. A regular `status` contacts Overleaf and downloads the remote project archive so the CLI can detect remote changes as well. `pull`, `push`, and `sync` run an additional full `status` before they change files; if one of those commands is your next step, you usually do not need to run a separate regular `status` first unless you only want to preview changes or conflicts.

## Project State

After binding, the local project folder contains `.olfs/` state files:

```text
.olfs/config.json
.olfs/baseline.json
.olfs/bin/*
```

Authentication is stored outside the project folder:

```text
~/.config/overleaf-folder-sync/auth.json
```

The authentication file is written with `0600` permissions.

During binding, `olfs` checks whether the target folder is already inside a Git repository. Existing repositories are left alone; if no repository exists and `git` is available, the CLI initializes one. If `git` is not available, the command still continues, but every `olfs` operation prints a warning that local paper changes are not protected by a Git repository.

## Sync Behavior

`pull`, `push`, and `sync` run a full status check first, so they contact Overleaf and download the remote project archive before deciding what to change. If you just ran `olfs status` as a preview, these commands still check again to avoid acting on stale state. If the same file changed both locally and remotely, the CLI asks whether to:

- keep the local version
- keep the remote version
- skip the file

`pull --force` mirrors the remote project into the local folder. `push --force` mirrors the local folder into the remote project. Both commands ask for runtime confirmation.

On the first `pull`, if `.olfs/baseline.json` does not exist yet, the CLI initializes the local folder from the remote project. If local files already exist and could be overwritten, the CLI asks first; use `pull --yes` to skip the prompt.

After each successful `olfs push`, the CLI runs `git add .` and creates a local Git commit. Use `--message` or `--comment` to set the commit message, for example `olfs push --comment "revise introduction"`; when omitted, the default message is `olfs push`. If there are no new Git changes, the commit is skipped automatically.

## Submission Filters

`olfs` reads `.gitignore` and `.olignore` from the project root. These rules apply to local scanning, status checks, regular `pull`, `push`, and `sync`:

- Ignored local files are not uploaded to Overleaf.
- Ignored remote files are not treated as deletion candidates just because they are missing locally.
- Regular `pull` and `sync` do not write ignored remote files into the local folder.

Use `.olignore` for rules that should affect Overleaf sync without affecting Git.

## Compile Outputs

`olfs compile` fetches the Overleaf compile log and prints parsed errors and warnings. It can also save compile artifacts:

```bash
olfs compile --pdf-out output.pdf
olfs compile --log-out output.log
olfs compile --output-dir .output
```

It can also update compile settings:

```bash
olfs compile --compiler xelatex
olfs compile --set-root main.tex
```

## Platform Scripts

`olfs bind` creates launcher scripts under `.olfs/bin/` for the current platform:

- macOS: `.command`
- Linux: `.sh`
- Windows: `.cmd`

The generated scripts cover status, compile, pull, force pull, push, force push, and sync.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Run commands in development mode:

```bash
pnpm dev -- <command>
```

Examples:

```bash
pnpm dev -- list
pnpm dev -- status
```

## Codex Skill

This repository includes a Codex skill that teaches an agent how to safely operate the installed `olfs` command.

After this project is published to GitHub, Codex can install the skill from the repository path with `skill-installer`:

```bash
install skill from <owner>/<repo> path skills/overleaf-folder-sync
```

Restart Codex after installation. When you ask Codex to run Overleaf sync, pull, push, compile, or conflict-resolution workflows, it will load this skill and follow its safety workflow for `olfs`.

## Security

This tool requires the user to provide an `overleaf_session2` cookie. It does not implement Overleaf web login and does not ask for an Overleaf password.

Use this tool only on trusted machines, and protect the local authentication file. Do not commit `auth.json`, `.olfs/`, or any file containing cookies to Git.

## Disclaimer

This project is not an official Overleaf project and is not affiliated with, endorsed by, or sponsored by Overleaf. Overleaf is a trademark of its respective owners.

This tool depends on currently observable Overleaf interface behavior. Those interfaces may change, and future releases may need updates to remain compatible.

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
