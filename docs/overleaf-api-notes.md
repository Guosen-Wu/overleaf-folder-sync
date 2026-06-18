# Overleaf API Notes

These are interface observations used for an independent implementation. They
record endpoint behavior only and intentionally avoid GPL source text.

## Authentication With `overleaf_session2`

- Caller provides an `overleaf_session2` value.
- Client sends it as a cookie on `GET https://www.overleaf.com/project`.
- A valid session returns the dashboard HTML with meta tags containing user,
  CSRF, and project data.

Observed dashboard meta values:

- `ol-user_id`: authenticated user id.
- `ol-usersEmail`: authenticated user email, when present.
- `ol-csrfToken`: CSRF token for mutating requests.
- `ol-projects`: JSON project list embedded in an HTML attribute.

## Project List

- `GET /project`
- Cookie: `overleaf_session2=<value>`
- Parse `ol-projects` from the dashboard HTML.
- Active projects are those without `archived` and without `trashed`.

## Project Data

- `GET /project/:projectId/download/zip`
- Downloads a zip archive of the project files.

- `GET /project/:projectId/metadata`
- Returns project metadata JSON.

- `GET /project/:projectId/entities`
- Returns file/folder entity records when available to the authenticated user.

## File And Folder Mutation

Mutating requests require the session cookie and CSRF token.

- `POST /project/:projectId/doc`
  - JSON body: `_csrf`, `parent_folder_id`, `name`
  - Creates a text document.

- `POST /project/:projectId/folder`
  - JSON body: `_csrf`, `parent_folder_id`, `name`
  - Creates a folder.

- `POST /project/:projectId/upload?folder_id=:folderId`
  - Multipart fields: `targetFolderId`, `name`, `type`, `qqfile`
  - Creates or uploads a file reference in the target folder.

- `DELETE /project/:projectId/:entityType/:entityId`
  - Header: `X-Csrf-Token`
  - Deletes a `doc`, `file`, or `folder` entity.

## Socket Join

Some current Overleaf file-tree details may require a Socket.IO project join:

- Connect to the Overleaf origin with the session cookie.
- Emit `joinProject` with `{ project_id }`.
- The callback includes project details such as root folder structure.

This is intentionally left as a later milestone; initial read-only commands use
dashboard data and project zip download.
