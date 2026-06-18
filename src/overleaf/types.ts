export interface Identity {
  csrfToken?: string;
  userId?: string;
  userEmail?: string;
  cookieHeader: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  lastUpdated?: string;
  lastUpdatedBy?: unknown;
  archived?: boolean;
  trashed?: boolean;
  accessLevel?: string;
  source?: string;
  owner?: unknown;
}

export interface DashboardSnapshot {
  identity: Identity;
  projects: ProjectSummary[];
}

export interface DashboardDiagnostics {
  status: number;
  finalUrl: string;
  contentType: string;
  hasLoginForm: boolean;
  hasCsrfMeta: boolean;
  hasUserIdMeta: boolean;
  hasProjectsMeta: boolean;
  title?: string;
  bodyPreview: string;
}

export interface ProjectEntity {
  _id: string;
  name: string;
  _type?: "doc" | "file" | "folder";
  version?: number;
}

export interface FolderEntity extends ProjectEntity {
  docs?: ProjectEntity[];
  fileRefs?: ProjectEntity[];
  folders?: FolderEntity[];
}

export interface ProjectTree {
  _id: string;
  name: string;
  rootDoc_id?: string;
  compiler?: string;
  rootFolder: FolderEntity[];
}

export interface JoinedDoc {
  content: string;
  version: number;
}

export interface ProjectEntitiesResponse {
  entities: Array<{ path: string; type: string }>;
}

export interface CreatedEntity {
  _id: string;
  name: string;
  _type: "doc" | "file" | "folder";
}

export interface CompileOutputFile {
  _id?: string;
  name?: string;
  path: string;
  url: string;
  type: string;
  build?: string;
}

export interface CompileResponse {
  status: "success" | "failure" | "error";
  compileGroup?: string;
  clsiServerId?: string;
  pdfDownloadDomain?: string;
  outputFiles?: CompileOutputFile[];
  stats?: Record<string, unknown>;
  timings?: Record<string, unknown>;
}

export interface CompileFetchResult {
  compile: CompileResponse;
  log: string;
  outputs: CompileOutputFile[];
}
