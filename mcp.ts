// mcp.ts - JSON-RPC 2.0 over Streamable HTTP.  Tools operate on the same
// Forge model as REST and GraphQL, so ids survive a round trip through any
// surface.  Tool definitions are constant, which makes tools/list deterministic.

import type { Ctx } from "./api.ts";
import { authorized, sendBody, sendError, sendJson } from "./api.ts";
import type { Forge, Issue, Pull, Repo } from "./meta.ts";

class ToolError extends Error {}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  required: string[][];
  run: (forge: Forge, login: string, args: Record<string, any>) => any;
}

const stringProp = (description: string) => ({ type: "string", description });
const boolProp = (description: string) => ({ type: "boolean", description });

function repoOf(forge: Forge, login: string, args: Record<string, any>): Repo {
  const raw = firstString(args, ["repo", "repository", "repo_name", "repository_name", "full_name", "name"]);
  if (!raw) throw new ToolError("Missing required argument: repo");
  let owner = firstString(args, ["owner", "org", "organization", "login"]) ?? login;
  let name = raw;
  if (raw.includes("/")) {
    const parts = raw.split("/");
    owner = parts[0];
    name = parts.slice(1).join("/");
  }
  if (owner.toLowerCase() !== login.toLowerCase()) throw new ToolError("Repository not found");
  const repo = forge.getRepo(login, name);
  if (!repo) throw new ToolError("Repository not found: " + raw);
  return repo;
}

function firstString(args: Record<string, any>, names: string[]): string | undefined {
  for (const n of names) {
    const v = args[n];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function hasAny(args: Record<string, any>, names: string[]): boolean {
  for (const n of names) {
    const v = args[n];
    if (v !== undefined && v !== null && v !== "") return true;
  }
  return false;
}

function repoSummary(repo: Repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.owner + "/" + repo.name,
    owner: repo.owner,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueSummary(issue: Issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => l.name),
    user: issue.user,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    repository: issue.repo.owner + "/" + issue.repo.name,
  };
}

function pullSummary(pull: Pull) {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: pull.headRef,
    base: pull.baseRef,
    head_sha: pull.headSha ?? null,
    base_sha: pull.baseSha ?? null,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProp("Repository name"),
        description: stringProp("Repository description"),
        private: boolProp("Whether the repository is private"),
      },
      required: ["name"],
      additionalProperties: false,
    },
    required: [["name", "repo", "repository", "repo_name", "repository_name"]],
    run: (forge, login, args) => {
      const name = firstString(args, ["name", "repo", "repository", "repo_name", "repository_name"]);
      if (!name) throw new ToolError("Missing required argument: name");
      const repo = forge.createRepo(login, name, {
        description: typeof args.description === "string" ? args.description : null,
        isPrivate: !!args.private,
      });
      return repoSummary(repo);
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by name.",
    inputSchema: {
      type: "object",
      properties: {
        repo: stringProp("Repository name, or owner/name"),
        owner: stringProp("Repository owner (defaults to the authenticated user)"),
      },
      required: ["repo"],
      additionalProperties: false,
    },
    required: [["repo", "name", "repository", "repo_name", "repository_name"]],
    run: (forge, login, args) => repoSummary(repoOf(forge, login, args)),
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: stringProp("Repository name, or owner/name"),
        title: stringProp("Issue title"),
        body: stringProp("Issue body"),
        labels: { type: "array", items: { type: "string" }, description: "Label names" },
      },
      required: ["repo", "title"],
      additionalProperties: false,
    },
    required: [
      ["repo", "name", "repository", "repo_name", "repository_name"],
      ["title"],
    ],
    run: (forge, login, args) => {
      const repo = repoOf(forge, login, args);
      const title = firstString(args, ["title"]);
      if (!title) throw new ToolError("Missing required argument: title");
      const names = Array.isArray(args.labels) ? args.labels.map((x: any) => String(x)) : [];
      const labels = [];
      for (const name of names) {
        const label = repo.labels.get(name);
        if (!label) throw new ToolError("Label does not exist: " + name);
        labels.push(label);
      }
      const issue = forge.createIssue(repo, title, typeof args.body === "string" ? args.body : "", labels, login);
      return issueSummary(issue);
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        repo: stringProp("Repository name, or owner/name"),
        state: stringProp("open, closed, or all"),
        labels: { type: "array", items: { type: "string" }, description: "Label names" },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    required: [["repo", "name", "repository", "repo_name", "repository_name"]],
    run: (forge, login, args) => {
      const repo = repoOf(forge, login, args);
      const state = (firstString(args, ["state"]) ?? "open").toLowerCase();
      const labels = Array.isArray(args.labels) ? args.labels.map((x: any) => String(x)) : [];
      let list = Array.from(repo.issues.values());
      if (state !== "all") list = list.filter((i) => i.state === state);
      if (labels.length) list = list.filter((i) => labels.every((n: string) => i.labels.some((l) => l.name === n)));
      list.sort((a, b) => b.number - a.number);
      return list.map(issueSummary);
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo: stringProp("Repository name, or owner/name"),
        title: stringProp("Pull request title"),
        head: stringProp("Head branch name"),
        base: stringProp("Base branch name"),
        body: stringProp("Pull request body"),
      },
      required: ["repo", "title", "head", "base"],
      additionalProperties: false,
    },
    required: [
      ["repo", "name", "repository", "repo_name", "repository_name"],
      ["title"],
      ["head", "headRefName", "head_branch", "headBranch"],
      ["base", "baseRefName", "base_branch", "baseBranch"],
    ],
    run: (forge, login, args) => {
      const repo = repoOf(forge, login, args);
      const title = firstString(args, ["title"]);
      const head = firstString(args, ["head", "headRefName", "head_branch", "headBranch"]);
      const base = firstString(args, ["base", "baseRefName", "base_branch", "baseBranch"]) ?? repo.defaultBranch;
      if (!title) throw new ToolError("Missing required argument: title");
      if (!head) throw new ToolError("Missing required argument: head");
      const pull = forge.createPull(
        repo,
        title,
        typeof args.body === "string" ? args.body : "",
        head,
        base,
        login,
      );
      return pullSummary(pull);
    },
  },
  {
    name: "merge_pull_request",
    description: "Squash-merge an open pull request into its base branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo: stringProp("Repository name, or owner/name"),
        number: { type: "integer", description: "Pull request number" },
      },
      required: ["repo", "number"],
      additionalProperties: false,
    },
    required: [
      ["repo", "name", "repository", "repo_name", "repository_name"],
      ["number", "pull_number", "pullNumber", "issue_number"],
    ],
    run: (forge, login, args) => {
      const repo = repoOf(forge, login, args);
      const raw = args.number ?? args.pull_number ?? args.pullNumber ?? args.issue_number;
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new ToolError("Missing required argument: number");
      const pull = repo.pulls.get(number);
      if (!pull) throw new ToolError("Pull request not found: " + number);
      const result = forge.mergePull(repo, pull);
      if (!result.ok) throw new ToolError(result.message);
      return {
        sha: result.sha,
        merged: true,
        message: result.message,
        pull_request: pullSummary(pull),
      };
    },
  },
];

const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2024-11-05"];

function toolListing() {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

function matchTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  for (const tool of TOOLS) {
    if (tool.name.toLowerCase() === lower) return tool;
  }
  for (const tool of TOOLS) {
    if (lower.endsWith(tool.name.toLowerCase())) return tool;
  }
  return undefined;
}

function toolResult(payload: any): any {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): any {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

function errorResponse(id: any, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function callTool(forge: Forge, login: string, params: any): RpcResponse | { result: any } {
  const name = params && typeof params.name === "string" ? params.name : "";
  const tool = matchTool(name);
  if (!tool) return { result: undefined };
  const args = params && params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  for (const group of tool.required) {
    if (!hasAny(args, group)) {
      return { result: toolError("Missing required argument: " + group[0]) };
    }
  }
  try {
    return { result: toolResult(tool.run(forge, login, args)) };
  } catch (err: any) {
    if (err instanceof ToolError) return { result: toolError(err.message) };
    return { result: toolError(err && err.message ? String(err.message) : "Tool failed") };
  }
}

function handleRpc(
  msg: any,
  ctx: Ctx,
  sessionId: string | undefined,
): { response?: RpcResponse; notification: boolean; sessionId?: string } {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { response: errorResponse(msg && msg.id, -32600, "Invalid Request"), notification: false };
  }
  const id = msg.id;
  const isNotification = id === undefined || id === null;
  const method = msg.method;
  const params = msg.params || {};

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return { notification: true };
  }
  if (method === "initialize") {
    const requested = params.protocolVersion;
    const version =
      typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_VERSIONS[0];
    const sid = sessionId || "sess_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    return {
      notification: false,
      sessionId: sid,
      response: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ghforge", version: "1.0.0" },
          instructions: "An in-memory GitHub-compatible forge.",
        },
      },
    };
  }
  if (method === "ping") {
    return { notification: isNotification, response: isNotification ? undefined : { jsonrpc: "2.0", id, result: {} } };
  }
  if (method === "server/discover") {
    return {
      notification: false,
      response: {
        jsonrpc: "2.0",
        id,
        result: {
          supportedVersions: SUPPORTED_VERSIONS.slice(),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ghforge", version: "1.0.0" },
        },
      },
    };
  }
  if (method === "tools/list") {
    return {
      notification: false,
      response: { jsonrpc: "2.0", id, result: toolListing() },
    };
  }
  if (method === "tools/call") {
    const called = callTool(ctx.forge, ctx.login, params);
    if (called.result === undefined) {
      return {
        notification: false,
        response: errorResponse(id, -32602, "Unknown tool: " + String(params && params.name)),
      };
    }
    return {
      notification: false,
      response: { jsonrpc: "2.0", id, result: called.result },
    };
  }
  if (method === "resources/list") {
    return { notification: false, response: { jsonrpc: "2.0", id, result: { resources: [] } } };
  }
  if (method === "prompts/list") {
    return { notification: false, response: { jsonrpc: "2.0", id, result: { prompts: [] } } };
  }
  return {
    notification: isNotification,
    response: isNotification ? undefined : errorResponse(id, -32601, "Method not found: " + method),
  };
}

export async function handleMcp(ctx: Ctx): Promise<void> {
  if (!authorized(ctx)) {
    sendError(ctx, 401, "Requires authentication");
    return;
  }
  const text = ctx.body.length ? ctx.body.toString("utf8") : "";
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(ctx, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const headerSession = ctx.req.headers["mcp-session-id"];
  const sessionId = typeof headerSession === "string" ? headerSession : undefined;
  const extra: Record<string, string> = {};
  if (sessionId) extra["Mcp-Session-Id"] = sessionId;

  if (Array.isArray(parsed)) {
    const responses: RpcResponse[] = [];
    for (const msg of parsed) {
      const handled = handleRpc(msg, ctx, sessionId);
      if (handled.sessionId) extra["Mcp-Session-Id"] = handled.sessionId;
      if (!handled.notification && handled.response) responses.push(handled.response);
    }
    if (responses.length === 0) {
      sendBody(ctx, 202, Buffer.alloc(0), "application/json", extra);
    } else {
      sendJson(ctx, 200, responses, extra);
    }
    return;
  }

  const handled = handleRpc(parsed, ctx, sessionId);
  if (handled.sessionId) extra["Mcp-Session-Id"] = handled.sessionId;
  if (handled.notification || !handled.response) {
    sendBody(ctx, 202, Buffer.alloc(0), "application/json", extra);
    return;
  }
  if (parsed && parsed.method === "server/discover") {
    extra["MCP-Protocol-Version"] = "2026-07-28";
  }
  sendJson(ctx, 200, handled.response, extra);
}
