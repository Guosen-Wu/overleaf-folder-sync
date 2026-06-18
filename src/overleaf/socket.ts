import crypto from "node:crypto";
import WebSocket from "ws";
import type { Identity, JoinedDoc, ProjectTree } from "./types.js";
import { OlfsError } from "../util/errors.js";

interface TextOperation {
  p: number;
  i?: string;
  d?: string;
}

interface OtUpdate {
  doc: string;
  v: number;
  hash: string;
  op: TextOperation[];
}

interface SocketPacket {
  type?: string;
  id?: string;
  ack?: "data" | true;
  endpoint?: string;
  name?: string;
  args?: unknown[];
  ackId?: string;
  reason?: string;
}

export class OverleafSocket {
  private ws?: WebSocket;
  private socketCookieHeader?: string;
  private nextAckId = 1;
  private pendingJoinProject?: {
    resolve: (project: ProjectTree) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
  };
  private readonly pendingAcks = new Map<string, {
    resolve: (value: unknown[]) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly baseUrl: URL, private readonly identity: Identity, private readonly projectId?: string) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    const sessionId = await this.handshake();
    await this.openWebSocket(sessionId);
  }

  disconnect(): void {
    if (this.pendingJoinProject) {
      clearTimeout(this.pendingJoinProject.timer);
      this.pendingJoinProject.reject(new OlfsError("Overleaf socket disconnected."));
      this.pendingJoinProject = undefined;
    }
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new OlfsError("Overleaf socket disconnected."));
    }
    this.pendingAcks.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  async joinProject(projectId: string): Promise<ProjectTree> {
    await this.connect();
    const eventPromise = this.waitForJoinProjectResponse();
    const ackPromise = this.emitAck("joinProject", { project_id: projectId });
    const values = await Promise.race([
      ackPromise,
      eventPromise.then((project) => [project] as unknown[]),
    ]);
    const project = values.find(isProjectTree);
    if (!project) {
      throw new OlfsError("Overleaf socket did not return a project file tree.");
    }
    return project;
  }

  async joinDoc(docId: string): Promise<JoinedDoc> {
    await this.connect();
    const values = await this.emitAck("joinDoc", docId, { encodeRanges: true });
    const lines = values.find((value): value is string[] => Array.isArray(value) && value.every((line) => typeof line === "string"));
    const version = values.find((value): value is number => typeof value === "number");
    if (!lines || version === undefined) {
      throw new OlfsError("Overleaf socket did not return document content and version.");
    }
    return {
      content: lines.map(decodeSocketLine).join("\n"),
      version,
    };
  }

  async replaceDocContent(docId: string, currentContent: string, version: number, nextContent: string): Promise<void> {
    const op = makeReplacementOperation(currentContent, nextContent);
    if (op.length === 0) {
      return;
    }

    const update: OtUpdate = {
      doc: docId,
      v: version,
      hash: shareJsHash(nextContent),
      op,
    };

    await this.emitAck("applyOtUpdate", docId, update);
  }

  private async handshake(): Promise<string> {
    const url = new URL("socket.io/1/", this.baseUrl);
    url.searchParams.set("t", String(Date.now()));
    if (this.projectId) {
      url.searchParams.set("projectId", this.projectId);
    }
    const response = await fetch(url, {
      headers: {
        Cookie: this.identity.cookieHeader,
      },
      redirect: "manual",
    });

    if (!response.ok) {
      throw new OlfsError(`Overleaf socket handshake failed: HTTP ${response.status}.`);
    }

    const body = await response.text();
    this.socketCookieHeader = mergeSetCookie(this.identity.cookieHeader, response.headers.get("set-cookie"));
    const [sessionId, , , transports] = body.split(":");
    if (!sessionId || !transports?.split(",").includes("websocket")) {
      throw new OlfsError(`Overleaf socket handshake did not allow websocket transport: ${body}`);
    }
    return sessionId;
  }

  private async openWebSocket(sessionId: string): Promise<void> {
    const scheme = this.baseUrl.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = new URL(`${scheme}//${this.baseUrl.host}/socket.io/1/websocket/${encodeURIComponent(sessionId)}`);
    if (this.projectId) {
      wsUrl.searchParams.set("projectId", this.projectId);
      wsUrl.searchParams.set("t", String(Date.now()));
    }
    const ws = new WebSocket(wsUrl, {
      headers: {
        Cookie: this.socketCookieHeader ?? this.identity.cookieHeader,
        Origin: this.baseUrl.origin,
      },
    });
    this.ws = ws;

    ws.on("message", (data) => this.handleMessage(String(data)));
    ws.on("close", () => {
      if (this.pendingJoinProject) {
        clearTimeout(this.pendingJoinProject.timer);
        this.pendingJoinProject.reject(new OlfsError("Overleaf socket closed before project tree was received."));
        this.pendingJoinProject = undefined;
      }
      for (const pending of this.pendingAcks.values()) {
        clearTimeout(pending.timer);
        pending.reject(new OlfsError("Overleaf socket closed before an ack was received."));
      }
      this.pendingAcks.clear();
    });
    ws.on("error", (error) => {
      if (this.pendingJoinProject) {
        clearTimeout(this.pendingJoinProject.timer);
        this.pendingJoinProject.reject(error);
        this.pendingJoinProject = undefined;
      }
      for (const pending of this.pendingAcks.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pendingAcks.clear();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OlfsError("Timed out opening Overleaf websocket.")), 10_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(new OlfsError(`Overleaf websocket failed: ${error.message}`));
      });
    });
  }

  private async emitAck(event: string, ...args: unknown[]): Promise<unknown[]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new OlfsError("Overleaf socket is not connected.");
    }

    const id = String(this.nextAckId++);
    const packet = encodeEventPacket(id, event, args);
    const ackPromise = new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new OlfsError(`Timed out waiting for Overleaf socket event ${event}.`));
      }, 15_000);
      this.pendingAcks.set(id, { resolve, reject, timer });
    });
    ws.send(packet);
    return ackPromise;
  }

  private handleMessage(raw: string): void {
    for (const chunk of decodePayload(raw)) {
      const packet = decodePacket(chunk);
      if (packet.type === "heartbeat") {
        this.ws?.send("2::");
      } else if (packet.type === "ack" && packet.ackId) {
        const pending = this.pendingAcks.get(packet.ackId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(packet.ackId);
          pending.resolve(packet.args ?? []);
        }
      } else if (packet.type === "error") {
        const error = new OlfsError(`Overleaf socket error: ${packet.reason ?? "unknown"}`);
        for (const pending of this.pendingAcks.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pendingAcks.clear();
      } else if (packet.type === "event" && packet.name === "joinProjectResponse") {
        const project = extractProjectFromJoinEvent(packet.args ?? []);
        if (project && this.pendingJoinProject) {
          clearTimeout(this.pendingJoinProject.timer);
          this.pendingJoinProject.resolve(project);
          this.pendingJoinProject = undefined;
        }
      }
    }
  }

  private waitForJoinProjectResponse(): Promise<ProjectTree> {
    return new Promise<ProjectTree>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJoinProject = undefined;
        reject(new OlfsError("Timed out waiting for Overleaf joinProjectResponse."));
      }, 15_000);
      this.pendingJoinProject = { resolve, reject, timer };
    });
  }
}

function mergeSetCookie(cookieHeader: string, setCookieHeader: string | null): string {
  if (!setCookieHeader) {
    return cookieHeader;
  }

  const cookiePairs = setCookieHeader
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean);

  if (!cookiePairs.length) {
    return cookieHeader;
  }

  return [cookieHeader, ...cookiePairs].join("; ");
}

function encodeEventPacket(id: string, name: string, args: unknown[]): string {
  return `5:${id}+::${JSON.stringify({ name, args })}`;
}

function decodePacket(raw: string): SocketPacket {
  const match = raw.match(/([^:]+):([0-9]+)?(\+)?:([^:]+)?:?([\s\S]*)?/);
  if (!match) {
    return {};
  }

  const type = ["disconnect", "connect", "heartbeat", "message", "json", "event", "ack", "error", "noop"][Number(match[1])];
  const packet: SocketPacket = {
    type,
    id: match[2] || undefined,
    endpoint: match[4] || "",
  };

  if (packet.id) {
    packet.ack = match[3] ? "data" : true;
  }

  const data = match[5] || "";
  if (type === "ack") {
    const ackMatch = data.match(/^([0-9]+)(\+)?([\s\S]*)/);
    if (ackMatch) {
      packet.ackId = ackMatch[1];
      packet.args = ackMatch[3] ? JSON.parse(ackMatch[3]) as unknown[] : [];
    }
  } else if (type === "event" && data) {
    const parsed = JSON.parse(data) as { name?: string; args?: unknown[] };
    packet.name = parsed.name;
    packet.args = parsed.args ?? [];
  } else if (type === "error") {
    packet.reason = data;
  }

  return packet;
}

function decodePayload(raw: string): string[] {
  if (!raw.startsWith("\ufffd")) {
    return [raw];
  }

  const packets: string[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "\ufffd") {
      break;
    }
    const nextMarker = raw.indexOf("\ufffd", index + 1);
    if (nextMarker === -1) {
      break;
    }
    const length = Number(raw.slice(index + 1, nextMarker));
    const start = nextMarker + 1;
    packets.push(raw.slice(start, start + length));
    index = start + length;
  }
  return packets;
}

function isProjectTree(value: unknown): value is ProjectTree {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ProjectTree).rootFolder)
  );
}

function extractProjectFromJoinEvent(args: unknown[]): ProjectTree | undefined {
  for (const arg of args) {
    if (isProjectTree(arg)) {
      return arg;
    }
    if (
      typeof arg === "object" &&
      arg !== null &&
      isProjectTree((arg as { project?: unknown }).project)
    ) {
      return (arg as { project: ProjectTree }).project;
    }
  }
  return undefined;
}

function decodeSocketLine(text: string): string {
  return Buffer.from(text, "latin1").toString("utf8");
}

function makeReplacementOperation(current: string, next: string): TextOperation[] {
  if (current === next) {
    return [];
  }

  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) {
    prefix += 1;
  }

  let currentSuffix = current.length;
  let nextSuffix = next.length;
  while (
    currentSuffix > prefix &&
    nextSuffix > prefix &&
    current[currentSuffix - 1] === next[nextSuffix - 1]
  ) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  const deleted = current.slice(prefix, currentSuffix);
  const inserted = next.slice(prefix, nextSuffix);
  const op: TextOperation[] = [];
  if (deleted) {
    op.push({ p: prefix, d: deleted });
  }
  if (inserted) {
    op.push({ p: prefix, i: inserted });
  }
  return op;
}

function shareJsHash(content: string): string {
  return crypto.createHash("sha1").update(`blob ${content.length}\0${content}`).digest("hex");
}
