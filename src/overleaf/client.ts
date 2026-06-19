import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { readMetaContent } from "./csrf.js";
import type {
  CompileFetchResult,
  CompileOutputFile,
  CompileResponse,
  CreatedEntity,
  DashboardDiagnostics,
  DashboardSnapshot,
  Identity,
  ProjectEntitiesResponse,
  ProjectTree,
  ProjectSummary,
} from "./types.js";
import { OverleafSocket } from "./socket.js";
import { OlfsError } from "../util/errors.js";
import { currentOperationSignal } from "../util/operationTimeout.js";

export interface OverleafClientOptions {
  baseUrl?: string;
  overleafSession2: string;
  cookieHeader?: string;
}

export class OverleafClient {
  private readonly baseUrl: URL;
  private identity?: Identity;

  constructor(options: OverleafClientOptions) {
    this.baseUrl = new URL(options.baseUrl ?? "https://www.overleaf.com/");
    const cookie = options.overleafSession2.trim();
    if (!cookie) {
      throw new OlfsError("overleaf_session2 is required.");
    }
    const cookieHeader = options.cookieHeader?.trim() || `overleaf_session2=${cookie}`;
    this.identity = {
      csrfToken: "",
      userId: "",
      cookieHeader,
    };
  }

  get baseURL(): URL {
    return this.baseUrl;
  }

  get cookieHeader(): string {
    return this.requireIdentity().cookieHeader;
  }

  async dashboard(): Promise<DashboardSnapshot> {
    const html = await this.fetchDashboardHtml();
    this.updateIdentityFromDashboardHtml(html);
    const projectsJson = readMetaContent(html, "ol-projects");
    const projects = projectsJson
      ? this.normalizeProjects(JSON.parse(projectsJson) as unknown[])
      : await this.projectsFromApiFallback();

    return {
      identity: this.requireIdentity(),
      projects,
    };
  }

  async diagnoseDashboard(): Promise<DashboardDiagnostics> {
    const response = await this.fetchRoute("project", { method: "GET" });
    const html = await response.text();
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    return {
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? "",
      hasLoginForm: html.includes('name="_csrf"') || /Log in to Overleaf/i.test(html),
      hasCsrfMeta: readMetaContent(html, "ol-csrfToken") !== undefined,
      hasUserIdMeta: readMetaContent(html, "ol-user_id") !== undefined,
      hasProjectsMeta: readMetaContent(html, "ol-projects") !== undefined,
      title,
      bodyPreview: html.replace(/\s+/g, " ").slice(0, 500),
    };
  }

  async refreshIdentity(): Promise<Identity> {
    const html = await this.fetchDashboardHtml();
    this.updateIdentityFromDashboardHtml(html);
    return this.requireIdentity();
  }

  async listProjects(includeArchivedAndTrashed = false): Promise<ProjectSummary[]> {
    const { projects } = await this.dashboard();
    return includeArchivedAndTrashed
      ? projects
      : projects.filter((project) => !project.archived && !project.trashed);
  }

  private async fetchDashboardHtml(): Promise<string> {
    const html = await this.requestText("project", { method: "GET", requireOk: true });
    this.assertAuthenticatedHtml(html);
    return html;
  }

  private updateIdentityFromDashboardHtml(html: string): void {
    const csrfToken = readMetaContent(html, "ol-csrfToken");
    const userId = readMetaContent(html, "ol-user_id");
    const userEmail = readMetaContent(html, "ol-usersEmail");

    const current = this.requireIdentity();
    this.identity = {
      ...current,
      csrfToken: csrfToken ?? current.csrfToken,
      userId: userId ?? current.userId,
      userEmail: userEmail ?? current.userEmail,
    };
  }

  private async projectsFromApiFallback(): Promise<ProjectSummary[]> {
    const userProjects = await this.tryProjectListRoute("user/projects", {
      method: "GET",
    });
    if (userProjects) {
      return userProjects;
    }

    const apiProjects = await this.tryProjectListRoute("api/project", {
      method: "POST",
      body: JSON.stringify({ _csrf: this.requireIdentity().csrfToken }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (apiProjects) {
      return apiProjects;
    }

    throw new OlfsError(
      "Could not find projects in the dashboard or project list API responses. Run \"olfs auth diagnose\" to inspect the response shape.",
    );
  }

  async activeProjects(): Promise<ProjectSummary[]> {
    return this.listProjects(false);
  }

  async projectInfo(projectId: string): Promise<unknown> {
    await this.ensureIdentity();
    return this.requestJson(`project/${encodeURIComponent(projectId)}/metadata`, {
      method: "GET",
      requireOk: true,
    });
  }

  async projectEntities(projectId: string): Promise<ProjectEntitiesResponse> {
    await this.ensureIdentity();
    return this.requestJson(`project/${encodeURIComponent(projectId)}/entities`, {
      method: "GET",
      requireOk: true,
    }) as Promise<ProjectEntitiesResponse>;
  }

  async projectTree(projectId: string): Promise<ProjectTree> {
    const identity = await this.refreshIdentity();
    const socket = new OverleafSocket(this.baseUrl, identity, projectId);
    try {
      return await socket.joinProject(projectId);
    } finally {
      socket.disconnect();
    }
  }

  async projectSettings(projectId: string): Promise<{ learnedWords: string[]; languages: Array<{ code: string; name: string }>; compilers: Array<{ code: string; name: string }> }> {
    await this.ensureIdentity();
    const html = await this.requestText(`project/${encodeURIComponent(projectId)}`, { method: "GET", requireOk: true });
    const learnedWordsMatch = /<meta\s+name="ol-learnedWords"\s+data-type="json"\s+content="(\[.*?\])">/.exec(html);
    const languagesMatch = /<meta\s+name="ol-languages"\s+data-type="json"\s+content="(\[.*?\])">/.exec(html);
    const learnedWords = learnedWordsMatch ? JSON.parse(learnedWordsMatch[1].replace(/&quot;/g, '"')) as string[] : [];
    const languages = languagesMatch ? JSON.parse(languagesMatch[1].replace(/&quot;/g, '"')) as Array<{ code: string; name: string }> : [];
    if (languages.length) {
      languages.unshift({ code: "", name: "Off" });
    }
    const compilers = [
      { code: "pdflatex", name: "pdfLaTeX" },
      { code: "latex", name: "LaTeX" },
      { code: "xelatex", name: "XeLaTeX" },
      { code: "lualatex", name: "LuaLaTeX" },
    ];
    return { learnedWords, languages, compilers };
  }

  async updateProjectSettings(projectId: string, setting: Record<string, unknown>): Promise<void> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    await this.requestText(`project/${encodeURIComponent(projectId)}/settings`, {
      method: "POST",
      body: JSON.stringify(setting),
      headers: {
        "Content-Type": "application/json",
        "X-Csrf-Token": csrfToken,
      },
      requireOk: true,
    });
  }

  async downloadZip(projectId: string, targetPath: string): Promise<void> {
    await this.ensureIdentity();
    const response = await this.fetchRoute(`project/${encodeURIComponent(projectId)}/download/zip`, {
      method: "GET",
    });
    if (!response.ok || response.body === null) {
      throw await this.responseError("Failed to download project zip", response);
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await pipeline(response.body, createWriteStream(targetPath));
  }

  async compileProject(
    projectId: string,
    options: { rootResourcePath?: string; draft?: boolean; stopOnFirstError?: boolean } = {},
  ): Promise<CompileResponse> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    return this.requestJson(`project/${encodeURIComponent(projectId)}/compile?auto_compile=true`, {
      method: "POST",
      body: JSON.stringify({
        check: "silent",
        draft: options.draft ?? false,
        incrementalCompilesEnabled: true,
        rootResourcePath: options.rootResourcePath ?? null,
        stopOnFirstError: options.stopOnFirstError ?? false,
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Csrf-Token": csrfToken,
      },
      requireOk: true,
    }) as Promise<CompileResponse>;
  }

  async compileProjectAndFetchLog(
    projectId: string,
    options: { rootResourcePath?: string; draft?: boolean; stopOnFirstError?: boolean } = {},
  ): Promise<CompileFetchResult> {
    const compile = await this.compileProject(projectId, options);
    const outputLog = this.findOutputFile(compile, "log");
    if (!outputLog) {
      throw new OlfsError("Compile completed, but Overleaf did not return output.log in outputFiles.");
    }

    const log = (await this.downloadCompileOutput(compile, outputLog)).toString("utf8");
    return { compile, log, outputs: compile.outputFiles ?? [] };
  }

  async addDoc(projectId: string, folderId: string, name: string): Promise<CreatedEntity> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    const value = await this.requestJson(`project/${encodeURIComponent(projectId)}/doc`, {
      method: "POST",
      body: JSON.stringify({ parent_folder_id: folderId, name }),
      headers: {
        "Content-Type": "application/json",
        "X-Csrf-Token": csrfToken,
      },
      requireOk: true,
    });
    const record = value as Record<string, unknown>;
    return {
      _id: String(record._id ?? record.id ?? ""),
      name,
      _type: "doc",
    };
  }

  async addFolder(projectId: string, parentFolderId: string, name: string): Promise<CreatedEntity> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    const value = await this.requestJson(`project/${encodeURIComponent(projectId)}/folder`, {
      method: "POST",
      body: JSON.stringify({ parent_folder_id: parentFolderId, name }),
      headers: {
        "Content-Type": "application/json",
        "X-Csrf-Token": csrfToken,
      },
      requireOk: true,
    });
    const record = value as Record<string, unknown>;
    return {
      _id: String(record._id ?? record.id ?? ""),
      name: String(record.name ?? name),
      _type: "folder",
    };
  }

  async uploadFile(projectId: string, folderId: string, name: string, content: Blob, mimeType: string): Promise<CreatedEntity> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    const formData = new FormData();
    formData.set("targetFolderId", folderId);
    formData.set("name", name);
    formData.set("type", mimeType);
    formData.set("qqfile", content, name);

    const value = await this.requestJson(`project/${encodeURIComponent(projectId)}/upload?folder_id=${encodeURIComponent(folderId)}`, {
      method: "POST",
      body: formData,
      headers: {
        "X-Csrf-Token": csrfToken,
      },
      requireOk: true,
    });
    const record = value as Record<string, unknown>;
    return {
      _id: String(record.entity_id ?? record._id ?? record.id ?? ""),
      name,
      _type: String(record.entity_type ?? record._type ?? "file") === "doc" ? "doc" : "file",
    };
  }

  async deleteEntity(projectId: string, entityType: string, entityId: string): Promise<void> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    await this.requestText(
      `project/${encodeURIComponent(projectId)}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      {
        method: "DELETE",
        headers: {
          "X-Csrf-Token": csrfToken,
        },
        requireOk: true,
      },
    );
  }

  async renameEntity(projectId: string, entityType: string, entityId: string, name: string): Promise<void> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    await this.requestText(
      `project/${encodeURIComponent(projectId)}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/rename`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
        headers: {
          "Content-Type": "application/json",
          "X-Csrf-Token": csrfToken,
        },
        requireOk: true,
      },
    );
  }

  async moveEntity(projectId: string, entityType: string, entityId: string, folderId: string): Promise<void> {
    await this.ensureIdentity();
    const csrfToken = this.requireCsrfToken();
    await this.requestText(
      `project/${encodeURIComponent(projectId)}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/move`,
      {
        method: "POST",
        body: JSON.stringify({ folder_id: folderId }),
        headers: {
          "Content-Type": "application/json",
          "X-Csrf-Token": csrfToken,
        },
        requireOk: true,
      },
    );
  }

  private findOutputFile(compile: CompileResponse, typeOrPath: string): CompileOutputFile | undefined {
    const outputs = compile.outputFiles ?? [];
    return outputs.find((file) => file.type === typeOrPath || file.path === typeOrPath || file.path.endsWith(`/${typeOrPath}`));
  }

  async downloadCompileOutputByPath(compile: CompileResponse, outputPathOrType: string): Promise<Buffer> {
    const outputFile = this.findOutputFile(compile, outputPathOrType);
    if (!outputFile) {
      throw new OlfsError(`Compile output not found: ${outputPathOrType}`);
    }
    return this.downloadCompileOutput(compile, outputFile);
  }

  async downloadCompileOutputFile(compile: CompileResponse, outputFile: CompileOutputFile): Promise<Buffer> {
    return this.downloadCompileOutput(compile, outputFile);
  }

  private async downloadCompileOutput(compile: CompileResponse, outputFile: CompileOutputFile): Promise<Buffer> {
    const url = this.compileOutputUrl(compile, outputFile);
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: currentOperationSignal(),
      headers: this.shouldSendCookieForCompileOutput(url)
        ? { Cookie: this.requireIdentity().cookieHeader, Connection: "keep-alive" }
        : { Connection: "keep-alive" },
    });

    if (!response.ok) {
      throw await this.responseError("Failed to download compile output", response);
    }

    this.mergeSetCookie(response.headers.get("set-cookie"));
    return Buffer.from(await response.arrayBuffer());
  }

  private compileOutputUrl(compile: CompileResponse, outputFile: CompileOutputFile): URL {
    const rawOutputUrl = outputFile.url.replace(/^\/+/, "");
    if (compile.pdfDownloadDomain && compile.clsiServerId) {
      const url = new URL(rawOutputUrl, `${compile.pdfDownloadDomain.replace(/\/+$/, "")}/`);
      url.searchParams.set("compileGroup", compile.compileGroup ?? "standard");
      url.searchParams.set("clsiserverid", compile.clsiServerId);
      url.searchParams.set("enable_pdf_caching", "true");
      return url;
    }

    return new URL(rawOutputUrl, this.baseUrl);
  }

  private shouldSendCookieForCompileOutput(url: URL): boolean {
    return url.origin === this.baseUrl.origin;
  }

  private async ensureIdentity(): Promise<Identity> {
    const identity = this.requireIdentity();
    if (!identity.csrfToken) {
      return this.refreshIdentity();
    }
    return identity;
  }

  private requireIdentity(): Identity {
    if (!this.identity) {
      throw new OlfsError("Overleaf identity is not initialized.");
    }
    return this.identity;
  }

  private requireCsrfToken(): string {
    const csrfToken = this.requireIdentity().csrfToken;
    if (!csrfToken) {
      throw new OlfsError("Overleaf did not expose a CSRF token for this session.");
    }
    return csrfToken;
  }

  private normalizeProjects(rawProjects: unknown[]): ProjectSummary[] {
    return rawProjects
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        ...item,
        id: String(item.id ?? item._id ?? ""),
        name: String(item.name ?? "(untitled)"),
        lastUpdated: typeof item.lastUpdated === "string" ? item.lastUpdated : undefined,
        archived: Boolean(item.archived),
        trashed: Boolean(item.trashed),
        accessLevel: typeof item.accessLevel === "string" ? item.accessLevel : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
      }))
      .filter((project) => project.id.length > 0);
  }

  private assertAuthenticatedHtml(html: string): void {
    if (
      readMetaContent(html, "ol-projects") !== undefined ||
      readMetaContent(html, "ol-csrfToken") !== undefined ||
      readMetaContent(html, "ol-user_id") !== undefined
    ) {
      return;
    }

    if (html.includes('name="_csrf"') || /\/login\b/i.test(html) || /Log in to Overleaf/i.test(html)) {
      throw new OlfsError(
        "Overleaf did not return the project dashboard. The overleaf_session2 cookie is likely invalid, expired, or not copied in full.",
      );
    }

    throw new OlfsError(
      "Overleaf returned a page without the usual dashboard markers. The page format may have changed, or the account may need an additional browser-side check.",
    );
  }

  private async tryProjectListRoute(route: string, init: RequestInit): Promise<ProjectSummary[] | undefined> {
    const response = await this.fetchRoute(route, init);
    if (!response.ok) {
      return undefined;
    }

    const text = await response.text();
    if (!text) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }

    const projects = this.extractProjects(parsed);
    return projects ? this.normalizeProjects(projects) : undefined;
  }

  private extractProjects(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (Array.isArray(record.projects)) {
      return record.projects;
    }
    if (Array.isArray(record.projectList)) {
      return record.projectList;
    }
    if (record.data) {
      return this.extractProjects(record.data);
    }

    return undefined;
  }

  private async requestJson(route: string, init: RequestInit & { requireOk?: boolean }): Promise<unknown> {
    const text = await this.requestText(route, init);
    return text.length ? JSON.parse(text) : {};
  }

  private async requestText(route: string, init: RequestInit & { requireOk?: boolean }): Promise<string> {
    const response = await this.fetchRoute(route, init);
    if (init.requireOk && !response.ok) {
      throw await this.responseError("Overleaf request failed", response);
    }
    return response.text();
  }

  private async fetchRoute(route: string, init: RequestInit): Promise<Response> {
    const identity = this.requireIdentity();
    const headers = new Headers(init.headers);
    headers.set("Cookie", identity.cookieHeader);
    headers.set("Connection", "keep-alive");

    const url = new URL(route, this.baseUrl);
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers,
      signal: init.signal ?? currentOperationSignal(),
    });
    this.mergeSetCookie(response.headers.get("set-cookie"));
    return response;
  }

  private mergeSetCookie(setCookieHeader: string | null): void {
    if (!setCookieHeader) {
      return;
    }

    const identity = this.requireIdentity();
    const current = new Map(identity.cookieHeader.split(/;\s*/).map((pair) => {
      const index = pair.indexOf("=");
      return index === -1 ? [pair, ""] : [pair.slice(0, index), pair.slice(index + 1)];
    }));

    const pairs = setCookieHeader
      .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
      .map((cookie) => cookie.split(";")[0]?.trim())
      .filter(Boolean);

    for (const pair of pairs) {
      const index = pair.indexOf("=");
      if (index > 0) {
        current.set(pair.slice(0, index), pair.slice(index + 1));
      }
    }

    this.identity = {
      ...identity,
      cookieHeader: [...current.entries()].map(([key, value]) => `${key}=${value}`).join("; "),
    };
  }

  private async responseError(prefix: string, response: Response): Promise<OlfsError> {
    const body = await response.text().catch(() => "");
    const hint = response.status === 302 ? " Session may be invalid or expired." : "";
    return new OlfsError(`${prefix}: HTTP ${response.status}.${hint}${body ? `\n${body.slice(0, 500)}` : ""}`);
  }
}
