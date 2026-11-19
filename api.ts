// api.ts - REST v3.  Routes are chosen from the path prefix first; only the
// matching handler reads and parses a body.  All replies are JSON with a
// non-empty X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCommit } from "./gitobj.ts";
import {
  fileAt,
  flatFilesForBranch,
  type Forge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  pullMergeable,
} from "./meta.ts";
import { readTreeFlat, type FileEntry } from "./store.ts";
import { compressForHttp } from "./zstream.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  url: URL;
  body: Buffer;
  expectedToken: string;
  login: string;
  forge: Forge;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter++;
  return "ghf_" + Date.now().toString(36) + "_" + requestCounter.toString(36);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err: any) => reject(err));
  });
}

export function sendBody(
  ctx: Ctx,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-GitHub-Request-Id": nextRequestId(),
    ...extra,
  };
  let finalBody = body;
  const isJson = contentType.startsWith("application/json");
  if (isJson && status !== 204 && body.length > 0) {
    const accept = ctx.req.headers["accept-encoding"];
    const enc = compressForHttp(body, typeof accept === "string" ? accept : undefined);
    if (enc.encoding !== "identity") {
      finalBody = enc.body;
      headers["Content-Encoding"] = enc.encoding;
      headers["Vary"] = "Accept-Encoding";
    }
  }
  headers["Content-Length"] = String(finalBody.length);
  ctx.res.writeHead(status, headers);
  if (ctx.method === "HEAD" || status === 204) ctx.res.end();
  else ctx.res.end(finalBody);
}

export function sendJson(
  ctx: Ctx,
  status: number,
  value: any,
  extra: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  sendBody(ctx, status, body, "application/json; charset=utf-8", extra);
}

export function sendError(ctx: Ctx, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(ctx, status, { message }, extra);
}

export function authorized(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return !ctx.expectedToken || match[1] === ctx.expectedToken;
}

function parseJsonBody(ctx: Ctx): { ok: true; value: any } | { ok: false } {
  const text = ctx.body.length ? ctx.body.toString("utf8") : "";
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function pageInfo(ctx: Ctx): { perPage: number; page: number; start: number } {
  const perPageRaw = ctx.url.searchParams.get("per_page");
  const pageRaw = ctx.url.searchParams.get("page");
  let perPage = perPageRaw ? parseInt(perPageRaw, 10) : 30;
  let page = pageRaw ? parseInt(pageRaw, 10) : 1;
  if (!Number.isFinite(perPage) || perPage <= 0) perPage = 30;
  if (perPage > 100) perPage = 100;
  if (!Number.isFinite(page) || page <= 0) page = 1;
  return { perPage, page, start: (page - 1) * perPage };
}

function pageHeaders(ctx: Ctx, total: number, perPage: number, page: number): Record<string, string> {
  const last = Math.max(1, Math.ceil(total / perPage));
  if (total <= perPage && page === 1) return {};
  const host = ctx.req.headers.host ? "http://" + ctx.req.headers.host : "";
  const base = host + ctx.path;
  const link = (p: number, rel: string) =>
    "<" + base + "?page=" + p + "&per_page=" + perPage + '>; rel="' + rel + '"';
  const links: string[] = [link(1, "first")];
  if (page > 1) links.push(link(page - 1, "prev"));
  if (page < last) links.push(link(page + 1, "next"));
  links.push(link(last, "last"));
  return { Link: links.join(", ") };
}

function ownerMatches(login: string, owner: string): boolean {
  return login.toLowerCase() === owner.toLowerCase();
}

function findRepo(ctx: Ctx, owner: string, name: string): Repo | undefined {
  if (!ownerMatches(ctx.login, owner)) return undefined;
  return ctx.forge.getRepo(ctx.login, name);
}

function userJson(login: string, forge: Forge) {
  const user = forge.ensureUser(login);
  return {
    login: user.login,
    id: user.id,
    node_id: "U_" + user.id,
    avatar_url: "https://avatars.githubusercontent.com/u/" + user.id + "?v=4",
    gravatar_id: "",
    url: "/api/v3/users/" + encodeURIComponent(user.login),
    html_url: "https://github.com/" + encodeURIComponent(user.login),
    type: "User",
    site_admin: false,
  };
}

export function repoJson(ctx: Ctx, repo: Repo) {
  const full = repo.owner + "/" + repo.name;
  return {
    id: repo.id,
    node_id: "R_" + repo.id,
    name: repo.name,
    full_name: full,
    owner: userJson(repo.owner, ctx.forge),
    private: repo.private,
    html_url: "https://github.com/" + full,
    description: repo.description,
    fork: false,
    url: "/api/v3/repos/" + full,
    clone_url: "/" + full + ".git",
    git_url: "/" + full + ".git",
    ssh_url: "git@github.com:" + full + ".git",
    default_branch: repo.defaultBranch,
    open_issues_count: Array.from(repo.issues.values()).filter((i) => i.state === "open").length,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? "private" : "public",
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
  };
}

function labelJson(repo: Repo, label: Label) {
  return {
    id: label.id,
    node_id: "L_" + label.id,
    url: "/api/v3/repos/" + repo.owner + "/" + repo.name + "/labels/" + encodeURIComponent(label.name),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(ctx: Ctx, issue: Issue) {
  const repo = issue.repo;
  return {
    id: issue.id,
    node_id: "I_" + issue.id,
    url: "/api/v3/repos/" + repo.owner + "/" + repo.name + "/issues/" + issue.number,
    repository_url: "/api/v3/repos/" + repo.owner + "/" + repo.name,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user, ctx.forge),
    labels: issue.labels.map((l) => labelJson(repo, l)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === "closed" ? issue.updatedAt : null,
    html_url: "https://github.com/" + repo.owner + "/" + repo.name + "/issues/" + issue.number,
  };
}

function refJson(repo: Repo, ref: string, sha: string | undefined, label: string) {
  return {
    label: repo.owner + ":" + ref,
    ref,
    sha: sha ?? null,
    user: null,
    repo: { id: repo.id, name: repo.name, full_name: repo.owner + "/" + repo.name },
  };
}

export function pullJson(ctx: Ctx, pull: Pull) {
  const repo = pull.repo;
  const canMerge = pull.merged ? false : pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: "PR_" + pull.id,
    url: "/api/v3/repos/" + repo.owner + "/" + repo.name + "/pulls/" + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user, ctx.forge),
    labels: [],
    head: refJson(repo, pull.headRef, pull.headSha, pull.headRef),
    base: refJson(repo, pull.baseRef, pull.baseSha, pull.baseRef),
    merged: pull.merged,
    mergeable: canMerge,
    mergeable_state: pull.merged ? "unknown" : canMerge ? "clean" : "dirty",
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: "https://github.com/" + repo.owner + "/" + repo.name + "/pull/" + pull.number,
  };
}

export function commitJson(ctx: Ctx, repo: Repo, sha: string) {
  const obj = repo.store.getObject(sha);
  const info = obj && obj.type === "commit" ? parseCommit(obj.body) : undefined;
  const message = (info?.message ?? "").replace(/\n+$/, "");
  const author = info?.author ?? "";
  return {
    sha,
    node_id: "C_" + sha.slice(0, 12),
    url: "/api/v3/repos/" + repo.owner + "/" + repo.name + "/commits/" + sha,
    html_url: "https://github.com/" + repo.owner + "/" + repo.name + "/commit/" + sha,
    commit: {
      author: { name: author, email: "", date: repo.updatedAt },
      committer: { name: author, email: "", date: repo.updatedAt },
      message,
      tree: { sha: info?.tree ?? "", url: "" },
      url: "",
      comment_count: 0,
    },
    author: userJson(ctx.login, ctx.forge),
    committer: userJson(ctx.login, ctx.forge),
    parents: (info?.parents ?? []).map((p) => ({ sha: p, url: "" })),
  };
}

function contentFileJson(ctx: Ctx, repo: Repo, path: string, entry: FileEntry, branch: string) {
  const obj = repo.store.getObject(entry.sha);
  const body = obj ? obj.body : Buffer.alloc(0);
  return {
    name: path.split("/").pop() ?? path,
    path,
    sha: entry.sha,
    size: body.length,
    type: "file",
    content: body.toString("base64"),
    encoding: "base64",
    url: "/api/v3/repos/" + repo.owner + "/" + repo.name + "/contents/" + path + "?ref=" + encodeURIComponent(branch),
    git_url: "",
    html_url: "https://github.com/" + repo.owner + "/" + repo.name + "/blob/" + branch + "/" + path,
    download_url: "https://raw.githubusercontent.com/" + repo.owner + "/" + repo.name + "/" + branch + "/" + path,
  };
}

function directoryJson(repo: Repo, prefix: string, files: Map<string, FileEntry>) {
  const seen = new Map<string, any>();
  for (const [path, entry] of files) {
    if (prefix && !path.startsWith(prefix + "/")) continue;
    const rest = prefix ? path.slice(prefix.length + 1) : path;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      const childPath = (prefix ? prefix + "/" : "") + name;
      seen.set(childPath, {
        name,
        path: childPath,
        sha: "",
        size: 0,
        type: "dir",
        url: "/api/v3/repos/" + repo.owner + "/" + repo.name + "/contents/" + childPath,
      });
    } else {
      const childPath = (prefix ? prefix + "/" : "") + rest;
      seen.set(childPath, {
        name: rest,
        path: childPath,
        sha: entry.sha,
        size: repo.store.getObject(entry.sha)?.body.length ?? 0,
        type: "file",
        url: "/api/v3/repos/" + repo.owner + "/" + repo.name + "/contents/" + childPath,
      });
    }
  }
  return Array.from(seen.values());
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function issueLabels(repo: Repo, names: any): { labels?: Label[]; missing?: string[] } {
  const result: Label[] = [];
  const missing: string[] = [];
  if (!Array.isArray(names)) return { labels: result };
  for (const raw of names) {
    const name = String(raw);
    const label = repo.labels.get(name);
    if (label) result.push(label);
    else missing.push(name);
  }
  return { labels: result, missing };
}

export async function handleApi(ctx: Ctx): Promise<void> {
  if (!authorized(ctx)) {
    sendError(ctx, 401, "Requires authentication");
    return;
  }

  let rest = ctx.path;
  if (rest === "/api/v3" || rest === "/api/v3/") rest = "/";
  else if (rest.startsWith("/api/v3/")) rest = rest.slice("/api/v3".length);
  else rest = "/";
  const parts = rest.split("/").filter((p) => p.length > 0);

  const method = ctx.method;

  // GET /api/v3/
  if (parts.length === 0) {
    if (method !== "GET" && method !== "HEAD") return sendError(ctx, 405, "Method not allowed");
    sendJson(
      ctx,
      200,
      {
        current_user_url: "/api/v3/user",
        current_user_authorizations_html_url: "/settings/connections/applications{/client_id}",
        authorizations_url: "/api/v3/authorizations",
        repositories_url: "/api/v3/user/repos",
        user_repositories_url: "/api/v3/users/{user}/repos",
        repository_url: "/api/v3/repos/{owner}/{repo}",
        user_url: "/api/v3/users/{user}",
        rate_limit_url: "/api/v3/rate_limit",
      },
      { "X-OAuth-Scopes": "repo, user" },
    );
    return;
  }

  if (parts[0] === "meta") {
    if (method !== "GET") return sendError(ctx, 405, "Method not allowed");
    sendJson(ctx, 200, {
      installed_version: "ghforge-1.0.0",
      verifiable_password_authentication: false,
      hooks: [],
      git: [],
      packages: [],
      pages: [],
    });
    return;
  }

  if (parts[0] === "user" && parts[1] === "repos") {
    if (parts.length !== 2) return sendError(ctx, 404, "Not Found");
    if (method === "GET" || method === "HEAD") {
      const all = ctx.forge.listRepos(ctx.login);
      const perPageRaw = ctx.url.searchParams.get("per_page");
      const pageRaw = ctx.url.searchParams.get("page");
      let perPage = perPageRaw ? parseInt(perPageRaw, 10) : 30;
      let page = pageRaw ? parseInt(pageRaw, 10) : 1;
      if (!Number.isFinite(perPage) || perPage <= 0) perPage = 30;
      if (perPage > 100) perPage = 100;
      if (!Number.isFinite(page) || page <= 0) page = 1;
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const base = (ctx.req.headers.host ? "http://" + ctx.req.headers.host : "") + "/api/v3/user/repos";
        headers["Link"] =
          "<" + base + "?page=" + (page + 1) + "&per_page=" + perPage + '>; rel="next", ' +
          "<" + base + "?page=" + Math.max(1, Math.ceil(all.length / perPage)) + "&per_page=" + perPage + '>; rel="last"';
      }
      sendJson(ctx, 200, slice.map((r) => repoJson(ctx, r)), headers);
      return;
    }
    if (method === "POST") {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
      const body = parsed.value || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return sendError(ctx, 422, "Repository name is required");
      let repo = ctx.forge.getRepo(ctx.login, name);
      if (repo) return sendError(ctx, 422, "Repository already exists");
      repo = ctx.forge.createRepo(ctx.login, name, {
        description: typeof body.description === "string" ? body.description : null,
        isPrivate: !!body.private,
        autoInit: !!body.auto_init,
      });
      sendJson(ctx, 201, repoJson(ctx, repo), {
        Location: "/api/v3/repos/" + repo.owner + "/" + repo.name,
      });
      return;
    }
    return sendError(ctx, 405, "Method not allowed");
  }

  if (parts[0] === "user" && parts.length === 1) {
    sendJson(ctx, 200, userJson(ctx.login, ctx.forge));
    return;
  }

  if (parts[0] === "users" && parts[1] && parts[2] === "repos") {
    const user = decodeSeg(parts[1]);
    if (!ownerMatches(ctx.login, user)) return sendError(ctx, 404, "Not Found");
    sendJson(ctx, 200, ctx.forge.listRepos(ctx.login).map((r) => repoJson(ctx, r)));
    return;
  }

  if (parts[0] !== "repos" || !parts[1] || !parts[2]) {
    return sendError(ctx, 404, "Not Found");
  }

  const owner = decodeSeg(parts[1]);
  const name = decodeSeg(parts[2]);
  const repo = findRepo(ctx, owner, name);
  if (!repo) return sendError(ctx, 404, "Not Found");

  const tail = parts.slice(3);

  if (tail.length === 0) {
    if (method === "GET" || method === "HEAD") {
      sendJson(ctx, 200, repoJson(ctx, repo));
      return;
    }
    if (method === "PATCH") {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
      const body = parsed.value || {};
      if (typeof body.description === "string" || body.description === null) {
        repo.description = body.description;
      }
      if (typeof body.private === "boolean") repo.private = body.private;
      if (typeof body.default_branch === "string" && body.default_branch) {
        repo.defaultBranch = body.default_branch;
      }
      if (typeof body.name === "string" && body.name && body.name !== repo.name) {
        const newName = body.name;
        if (ctx.forge.getRepo(repo.owner, newName)) return sendError(ctx, 422, "Repository already exists");
        ctx.forge.repos.delete(ctx.forge.repoKey(repo.owner, repo.name));
        repo.name = newName;
        ctx.forge.repos.set(ctx.forge.repoKey(repo.owner, repo.name), repo);
      }
      repo.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, repoJson(ctx, repo));
      return;
    }
    if (method === "DELETE") {
      ctx.forge.deleteRepo(repo.owner, repo.name);
      sendBody(ctx, 204, Buffer.alloc(0), "application/json");
      return;
    }
    return sendError(ctx, 405, "Method not allowed");
  }

  if (tail[0] === "labels") {
    if (tail.length === 1) {
      if (method === "GET" || method === "HEAD") {
        const all = Array.from(repo.labels.values());
        const { perPage, page, start } = pageInfo(ctx);
        sendJson(ctx, 200, all.slice(start, start + perPage).map((l) => labelJson(repo, l)), pageHeaders(ctx, all.length, perPage, page));
        return;
      }
      if (method === "POST") {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
        const body = parsed.value || {};
        if (typeof body.name !== "string" || !body.name.trim()) {
          return sendError(ctx, 422, "Validation Failed");
        }
        const label = ctx.forge.createLabel(
          repo,
          body.name.trim(),
          typeof body.color === "string" ? body.color.replace(/^#/, "") : "ededed",
          typeof body.description === "string" ? body.description : null,
        );
        sendJson(ctx, 201, labelJson(repo, label), { Location: "/api/v3/repos/" + owner + "/" + name + "/labels/" + encodeURIComponent(label.name) });
        return;
      }
      return sendError(ctx, 405, "Method not allowed");
    }
    const labelName = decodeSeg(tail[1]);
    const label = repo.labels.get(labelName);
    if (!label) return sendError(ctx, 404, "Not Found");
    if (method === "GET" || method === "HEAD") return sendJson(ctx, 200, labelJson(repo, label));
    if (method === "DELETE") {
      repo.labels.delete(labelName);
      sendBody(ctx, 204, Buffer.alloc(0), "application/json");
      return;
    }
    return sendError(ctx, 405, "Method not allowed");
  }

  if (tail[0] === "issues") {
    if (tail.length === 1) {
      if (method === "GET" || method === "HEAD") {
        const state = ctx.url.searchParams.get("state") || "open";
        const labelFilter = ctx.url.searchParams.get("labels");
        let list = Array.from(repo.issues.values());
        if (state !== "all") list = list.filter((i) => i.state === state);
        if (labelFilter) {
          const wanted = labelFilter.split(",").map((s) => s.trim());
          list = list.filter((i) => wanted.every((w) => i.labels.some((l) => l.name === w)));
        }
        const sort = ctx.url.searchParams.get("sort") || "created";
        const dir = ctx.url.searchParams.get("direction") || "desc";
        list.sort((a, b) => {
          const av = sort === "updated" ? a.updatedAt : a.createdAt;
          const bv = sort === "updated" ? b.updatedAt : b.createdAt;
          const cmp = av < bv ? -1 : av > bv ? 1 : a.number - b.number;
          return dir === "asc" ? cmp : -cmp;
        });
        const { perPage, page, start } = pageInfo(ctx);
        const total = list.length;
        sendJson(ctx, 200, list.slice(start, start + perPage).map((i) => issueJson(ctx, i)), pageHeaders(ctx, total, perPage, page));
        return;
      }
      if (method === "POST") {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
        const body = parsed.value || {};
        if (typeof body.title !== "string" || !body.title.trim()) {
          return sendError(ctx, 422, "Validation Failed");
        }
        const resolved = issueLabels(repo, body.labels);
        if (resolved.missing && resolved.missing.length > 0) {
          return sendJson(ctx, 422, {
            message: "Validation Failed",
            errors: resolved.missing.map((n) => ({ resource: "Label", field: "name", code: "missing_field", value: n })),
          });
        }
        const issue = ctx.forge.createIssue(
          repo,
          body.title,
          typeof body.body === "string" ? body.body : "",
          resolved.labels ?? [],
          ctx.login,
        );
        sendJson(ctx, 201, issueJson(ctx, issue), {
          Location: "/api/v3/repos/" + owner + "/" + name + "/issues/" + issue.number,
        });
        return;
      }
      return sendError(ctx, 405, "Method not allowed");
    }
    const number = parseInt(tail[1], 10);
    if (!Number.isFinite(number)) return sendError(ctx, 404, "Not Found");
    const issue = repo.issues.get(number);
    if (!issue) return sendError(ctx, 404, "Not Found");
    // Comments on an issue: /issues/{number}/comments.
    if (tail.length === 3 && tail[2] === "comments") {
      if (method === "GET" || method === "HEAD") {
        return sendJson(ctx, 200, issue.comments.map((c) => ({
          id: c.id,
          node_id: "C_" + c.id,
          url: "/api/v3/repos/" + owner + "/" + name + "/issues/comments/" + c.id,
          body: c.body,
          user: userJson(c.user, ctx.forge),
          created_at: c.createdAt,
          updated_at: c.createdAt,
          issue_url: "/api/v3/repos/" + owner + "/" + name + "/issues/" + number,
        })));
      }
      if (method === "POST") {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
        const body = parsed.value as Record<string, unknown>;
        if (typeof body.body !== "string" || body.body === "") {
          return sendError(ctx, 422, "Validation Failed");
        }
        const comment = ctx.forge.addIssueComment(repo, issue, body.body, ctx.login);
        return sendJson(ctx, 201, {
          id: comment.id,
          node_id: "C_" + comment.id,
          url: "/api/v3/repos/" + owner + "/" + name + "/issues/comments/" + comment.id,
          body: comment.body,
          user: userJson(comment.user, ctx.forge),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
          issue_url: "/api/v3/repos/" + owner + "/" + name + "/issues/" + number,
        });
      }
      return sendError(ctx, 404, "Not Found");
    }
    if (method === "GET" || method === "HEAD") {
      sendJson(ctx, 200, issueJson(ctx, issue));
      return;
    }
    if (method === "PATCH") {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
      const body = parsed.value || {};
      if (typeof body.title === "string") issue.title = body.title;
      if (typeof body.body === "string") issue.body = body.body;
      if (body.state === "open" || body.state === "closed") issue.state = body.state;
      if (body.labels !== undefined) {
        const resolved = issueLabels(repo, body.labels);
        if (resolved.missing && resolved.missing.length > 0) return sendError(ctx, 422, "Validation Failed");
        issue.labels = resolved.labels ?? [];
      }
      issue.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, issueJson(ctx, issue));
      return;
    }
    return sendError(ctx, 405, "Method not allowed");
  }

  if (tail[0] === "pulls") {
    if (tail.length === 1) {
      if (method === "GET" || method === "HEAD") {
        const state = ctx.url.searchParams.get("state") || "open";
        let list = Array.from(repo.pulls.values());
        if (state !== "all") list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.number - a.number);
        const { perPage, page, start } = pageInfo(ctx);
        const total = list.length;
        sendJson(ctx, 200, list.slice(start, start + perPage).map((p) => pullJson(ctx, p)), pageHeaders(ctx, total, perPage, page));
        return;
      }
      if (method === "POST") {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
        const body = parsed.value || {};
        if (typeof body.title !== "string" || !body.title.trim()) return sendError(ctx, 422, "Validation Failed");
        if (typeof body.head !== "string" || !body.head) return sendError(ctx, 422, "Validation Failed");
        if (typeof body.base !== "string" || !body.base) return sendError(ctx, 422, "Validation Failed");
        const head = body.head.includes(":") ? body.head.split(":").pop() : body.head;
        const base = body.base;
        const pull = ctx.forge.createPull(repo, body.title, typeof body.body === "string" ? body.body : "", head, base, ctx.login);
        sendJson(ctx, 201, pullJson(ctx, pull), {
          Location: "/api/v3/repos/" + owner + "/" + name + "/pulls/" + pull.number,
        });
        return;
      }
      return sendError(ctx, 405, "Method not allowed");
    }
    const number = parseInt(tail[1], 10);
    if (!Number.isFinite(number)) return sendError(ctx, 404, "Not Found");
    const pull = repo.pulls.get(number);
    if (!pull) return sendError(ctx, 404, "Not Found");
    if (tail[2] === "files" && (method === "GET" || method === "HEAD")) {
      const baseSha = repo.store.getRef("refs/heads/" + pull.baseRef);
      const headSha = repo.store.getRef("refs/heads/" + pull.headRef);
      const baseTree = baseSha ? repo.store.commitTree(baseSha) : undefined;
      const headTree = headSha ? repo.store.commitTree(headSha) : undefined;
      const before = baseTree ? readTreeFlat(repo.store, baseTree) : new Map<string, FileEntry>();
      const after = headTree ? readTreeFlat(repo.store, headTree) : new Map<string, FileEntry>();
      const paths = new Set<string>([...before.keys(), ...after.keys()]);
      const files: unknown[] = [];
      for (const path of [...paths].sort()) {
        const b = before.get(path)?.sha ?? null;
        const a = after.get(path)?.sha ?? null;
        if (b === a) continue;
        const status = b === null ? "added" : a === null ? "removed" : "modified";
        const bb = b ? repo.store.getObject(b) : undefined;
        const ab = a ? repo.store.getObject(a) : undefined;
        const bText = bb?.type === "blob" ? bb.body.toString("utf8") : "";
        const aText = ab?.type === "blob" ? ab.body.toString("utf8") : "";
        const bLines = bText ? bText.split("\n").length : 0;
        const aLines = aText ? aText.split("\n").length : 0;
        files.push({
          filename: path,
          status,
          additions: Math.max(0, aLines - bLines),
          deletions: Math.max(0, bLines - aLines),
          changes: Math.abs(aLines - bLines),
          sha: a ?? b,
          blob_url: "/api/v3/repos/" + owner + "/" + name + "/blob/" + (pull.headRef) + "/" + path,
        });
      }
      return sendJson(ctx, 200, files);
    }
    if (tail[2] === "merge") {
      if (method !== "PUT" && method !== "POST") return sendError(ctx, 405, "Method not allowed");
      const result = ctx.forge.mergePull(repo, pull);
      if (!result.ok) return sendError(ctx, 405, result.message);
      sendJson(ctx, 200, { sha: result.sha, merged: true, message: result.message });
      return;
    }
    if (tail.length === 2 && (method === "GET" || method === "HEAD")) {
      sendJson(ctx, 200, pullJson(ctx, pull));
      return;
    }
    return sendError(ctx, 404, "Not Found");
  }

  if (tail[0] === "git" && tail[1] === "refs") {
    const refName = tail.slice(2).map(decodeSeg).join("/");
    if (method === "POST" && tail.length === 2) {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
      const body = parsed.value as Record<string, unknown>;
      if (typeof body.ref !== "string" || typeof body.sha !== "string") {
        return sendError(ctx, 422, "Invalid ref payload");
      }
      if (!body.ref.startsWith("refs/")) return sendError(ctx, 422, "ref must start with refs/");
      if (!repo.store.getObject(body.sha)) return sendError(ctx, 422, "Object does not exist");
      if (repo.store.getRef(body.ref) !== undefined) return sendError(ctx, 422, "Reference already exists");
      repo.store.setRef(body.ref, body.sha);
      return sendJson(ctx, 201, { ref: body.ref, object: { sha: body.sha, type: "commit" } });
    }
    if (tail.length >= 3) {
      const target = "refs/" + refName;
      if (method === "GET" || method === "HEAD") {
        const sha = repo.store.getRef(target);
        if (sha === undefined) return sendError(ctx, 404, "Not Found");
        return sendJson(ctx, 200, { ref: target, object: { sha, type: "commit" } });
      }
      if (method === "PATCH") {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
        const body = parsed.value as Record<string, unknown>;
        if (typeof body.sha !== "string" || !repo.store.getObject(body.sha)) {
          return sendError(ctx, 422, "Object does not exist");
        }
        repo.store.setRef(target, body.sha);
        return sendJson(ctx, 200, { ref: target, object: { sha: body.sha, type: "commit" } });
      }
      if (method === "DELETE") {
        if (repo.store.getRef(target) === undefined) return sendError(ctx, 404, "Not Found");
        repo.store.deleteRef(target);
        return sendBody(ctx, 204, Buffer.alloc(0), "application/json");
      }
    }
    return sendError(ctx, 404, "Not Found");
  }

  if (tail[0] === "branches") {
    if (method === "GET" || method === "HEAD") {
      if (tail.length === 1) {
        const branches = Array.from(repo.store.refs.keys())
          .filter((r) => r.startsWith("refs/heads/"))
          .map((r) => ({
            name: r.slice("refs/heads/".length),
            commit: { sha: repo.store.getRef(r) ?? "", url: "/api/v3/repos/" + owner + "/" + name + "/commits/" + (repo.store.getRef(r) ?? "") },
            protected: false,
          }));
        return sendJson(ctx, 200, branches);
      }
      if (tail.length === 2) {
        const branchName = decodeSeg(tail[1]);
        const sha = repo.store.getRef("refs/heads/" + branchName);
        if (!sha) return sendError(ctx, 404, "Not Found");
        return sendJson(ctx, 200, {
          name: branchName,
          commit: { sha, url: "/api/v3/repos/" + owner + "/" + name + "/commits/" + sha },
          protected: false,
        });
      }
    }
    return sendError(ctx, 404, "Not Found");
  }

  if (tail[0] === "commits" && tail.length === 1 && (method === "GET" || method === "HEAD")) {
    const ref = ctx.url.searchParams.get("sha") || repo.defaultBranch;
    const sha = repo.store.getRef("refs/heads/" + ref) ?? repo.store.getRef(ref);
    if (!sha) return sendJson(ctx, 200, []);
    const out: unknown[] = [];
    let cur: string | undefined = sha;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const obj = repo.store.getObject(cur);
      if (!obj || obj.type !== "commit") break;
      out.push(commitJson(ctx, repo, cur));
      const parents = parseCommit(obj.body).parents;
      cur = parents[0];
    }
    return sendJson(ctx, 200, out);
  }

  if (tail[0] === "contents") {
    const filePath = tail.slice(1).map(decodeSeg).join("/");
    const ref = ctx.url.searchParams.get("ref") || ctx.url.searchParams.get("branch") || repo.defaultBranch;
    if (method === "GET" || method === "HEAD") {
      const files = flatFilesForBranch(repo, ref);
      if (!filePath) {
        sendJson(ctx, 200, directoryJson(repo, "", files));
        return;
      }
      const entry = files.get(filePath);
      if (entry) {
        sendJson(ctx, 200, contentFileJson(ctx, repo, filePath, entry, ref));
        return;
      }
      const dir = directoryJson(repo, filePath, files);
      if (dir.length > 0) {
        sendJson(ctx, 200, dir);
        return;
      }
      return sendError(ctx, 404, "Not Found");
    }
    if (method === "PUT") {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
      const body = parsed.value || {};
      if (!filePath) return sendError(ctx, 422, "path is required");
      if (typeof body.content !== "string") return sendError(ctx, 422, "content is required");
      const branch = typeof body.branch === "string" && body.branch ? body.branch : repo.defaultBranch;
      let raw: Buffer;
      try {
        raw = Buffer.from(body.content, "base64");
      } catch {
        return sendError(ctx, 422, "content is not valid base64");
      }
      const files = flatFilesForBranch(repo, branch);
      const existing = files.get(filePath);
      if (body.sha !== undefined && (!existing || existing.sha !== body.sha)) {
        return sendError(ctx, 409, "sha does not match");
      }
      if (existing && body.sha === undefined) {
        // Updating without a sha is accepted; a wrong sha is still a conflict.
      }
      const blobSha = repo.store.putObject("blob", raw);
      files.set(filePath, { mode: "100644", sha: blobSha });
      const message = typeof body.message === "string" && body.message ? body.message : (existing ? "Update " : "Create ") + filePath;
      const commitSha = ctx.forge.commitFiles(repo, branch, files, message, ctx.login);
      const status = existing ? 200 : 201;
      sendJson(ctx, status, {
        content: contentFileJson(ctx, repo, filePath, files.get(filePath)!, branch),
        commit: commitJson(ctx, repo, commitSha),
      });
      return;
    }
    if (method === "DELETE") {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, "Problems parsing JSON");
      const body = parsed.value || {};
      if (!filePath) return sendError(ctx, 422, "path is required");
      const branch = typeof body.branch === "string" && body.branch ? body.branch : repo.defaultBranch;
      const files = flatFilesForBranch(repo, branch);
      const existing = files.get(filePath);
      if (!existing) return sendError(ctx, 404, "Not Found");
      if (body.sha !== undefined && body.sha !== existing.sha) return sendError(ctx, 409, "sha does not match");
      files.delete(filePath);
      const message = typeof body.message === "string" && body.message ? body.message : "Delete " + filePath;
      const commitSha = ctx.forge.commitFiles(repo, branch, files, message, ctx.login);
      sendJson(ctx, 200, { commit: commitJson(ctx, repo, commitSha), content: null });
      return;
    }
    return sendError(ctx, 405, "Method not allowed");
  }

  sendError(ctx, 404, "Not Found");
}
