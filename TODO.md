# TODO

## npm-ready Follow-up Features

These items come from comparing the current `olfs` CLI with the reference projects under `参考项目/overleaf-sync-master` and `参考项目/Overleaf-Workshop-master`.

### P1

- Project management commands:
  - Create blank projects.
  - Create example projects.
  - Upload a local archive as a new project.
  - Clone/copy an existing project.
  - Rename projects.
  - Archive and unarchive projects.
  - Move projects to trash and restore them.
  - Permanently delete trashed projects.

- Project tag management:
  - List tags.
  - Create, rename, and delete tags.
  - Add projects to tags.
  - Remove projects from tags.

- Project history:
  - List project update history.
  - Show file diffs between versions.
  - Show file tree diffs between versions.
  - Create and delete history labels.
  - Download a project zip at a specific version.

### P2

- Chat and collaboration:
  - List recent project chat messages.
  - Send project chat messages.
  - Support line-reference message formatting.
  - Show online collaborators if available from the socket API.

- Compile enhancements:
  - Stop an active compile.
  - Delete remote auxiliary/output files.
  - Expose SyncTeX jump-to-PDF and reverse-jump endpoints in a CLI-friendly form.

- Multi-server support:
  - Configure named Overleaf/ShareLaTeX servers.
  - Store auth per server.
  - Bind projects with server metadata.
  - Allow every remote command to target a configured server.

### P3

- Spelling tools:
  - Check words or files with Overleaf spelling API.
  - Learn words.
  - Unlearn words.
  - Show and update spell-check language settings.

- Browser-assisted login:
  - Offer an optional login flow that opens an authenticated browser/webview and stores the resulting cookie.
  - Keep manual cookie paste as the default lightweight path.
