# License Boundary

This project is Apache-2.0 licensed.

Reference projects in the parent directory are treated differently:

- `overleaf-sync-master` is MIT licensed. Its synchronization behavior can be
  reused or ported with attribution where applicable.
- `Overleaf-Workshop-master` is GPL licensed. It is used only to observe
  public interface behavior: URLs, HTTP methods, headers, payload fields,
  response shapes, and operation order.

Rules for this codebase:

- Do not copy GPL source files, functions, classes, comments, type definitions,
  or module structure into `overleaf-folder-sync`.
- Do not translate GPL TypeScript implementation line-by-line into this
  TypeScript project.
- Keep Workshop-derived notes factual and implementation-free.
- Keep new source code in an independently designed structure.
