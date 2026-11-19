import http from "node:http";
import { createForgeServer } from "./app.ts";
import { Forge } from "./meta.ts";

const token = "probe-token";
const login = "octocat";
const forge = new Forge(login);
const server = createForgeServer(forge, { token, login });

function listen() {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function base() {
  return "http://127.0.0.1:" + server.address().port;
}
async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.auth !== false) headers.authorization = "Bearer " + token;
  const res = await fetch(base() + path, { ...opts, headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}
function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

await listen();
try {
  let r = await req("/api/v3/", { auth: false });
  assert(r.status === 401, "unauth root 401");
  r = await req("/api/v3/");
  assert(r.status === 200 && r.headers.get("x-github-request-id"), "root");
  assert(r.headers.get("x-oauth-scopes"), "oauth scopes");
  r = await req("/api/v3/meta");
  assert(r.json.installed_version, "meta version");

  r = await req("/api/v3/user/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "demo", description: "old", auto_init: true }) });
  console.log("create repo", r.status, r.json && r.json.id);
  assert(r.status === 201, "create repo 201");
  const repo = r.json;
  r = await req("/api/v3/repos/octocat/demo");
  assert(r.status === 200 && r.json.description === "old", "get repo");
  r = await req("/api/v3/repos/octocat/demo", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "new" }) });
  assert(r.status === 200 && r.json.description === "new", "patch repo");

  await req("/api/v3/user/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "page-a" }) });
  await req("/api/v3/user/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "page-b" }) });
  r = await req("/api/v3/user/repos?per_page=1&page=1");
  assert(r.status === 200 && /rel="next"/.test(r.headers.get("link") || ""), "pagination next link");
  r = await req("/api/v3/repos/octocat/page-b", { method: "DELETE" });
  assert(r.status === 204, "delete repo 204");
  r = await req("/api/v3/repos/octocat/page-b");
  assert(r.status === 404 && typeof r.json.message === "string", "deleted repo 404 json");
  r = await req("/api/v3/no/such/route");
  assert(r.status === 404 && typeof r.json.message === "string", "unknown route json");
  r = await req("/api/v3/user/repos", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert(r.status === 400 && typeof r.json.message === "string", "malformed json 400");

  r = await req("/api/v3/repos/octocat/demo/labels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "bug", color: "ff0000" }) });
  assert(r.status === 201 && r.json.name === "bug", "label");
  r = await req("/api/v3/repos/octocat/demo/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "broken", body: "yes", labels: ["bug"] }) });
  console.log("create issue", r.status, r.json && r.json.number, r.json && r.json.id);
  assert(r.status === 201 && r.json.state === "open", "issue");
  const issue = r.json;
  r = await req("/api/v3/repos/octocat/demo/issues/" + issue.number);
  assert(r.status === 200 && r.json.id === issue.id, "get issue same id");
  r = await req("/api/v3/repos/octocat/demo/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "bad", labels: ["nope"] }) });
  assert(r.status === 422, "missing label 422");

  r = await req("/api/v3/repos/octocat/demo/contents/README.md");
  assert(r.status === 200 && r.json.type === "file", "readme exists");
  const oldsha = r.json.sha;
  r = await req("/api/v3/repos/octocat/demo/contents/a.txt", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "add", content: Buffer.from("hello").toString("base64") }) });
  assert(r.status === 201 && r.json.commit.sha, "put create");
  r = await req("/api/v3/repos/octocat/demo/contents/a.txt");
  assert(r.status === 200 && Buffer.from(r.json.content, "base64").toString() === "hello", "get content");
  const asha = r.json.sha;
  r = await req("/api/v3/repos/octocat/demo/contents/a.txt", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "stale", content: Buffer.from("x").toString("base64"), sha: oldsha }) });
  assert(r.status === 409, "stale sha");
  r = await req("/api/v3/repos/octocat/demo/contents/a.txt", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "rm", sha: asha }) });
  assert(r.status === 200 && r.json.commit.sha, "delete content");
  r = await req("/api/v3/repos/octocat/demo/contents/a.txt");
  assert(r.status === 404, "deleted content 404");

  // git v2 advertisement
  let res = await fetch(base() + "/octocat/demo.git/info/refs?service=git-upload-pack", { headers: { "Git-Protocol": "version=2" } });
  let body = Buffer.from(await res.arrayBuffer());
  console.log("v2 ad starts", JSON.stringify(body.subarray(0, 20).toString()));
  assert(body.subarray(4).toString().startsWith("version 2"), "v2 opens version 2");
  assert(body.toString().includes("ls-refs") && body.toString().includes("fetch"), "v2 caps");
  res = await fetch(base() + "/octocat/demo.git/info/refs?service=git-upload-pack");
  body = Buffer.from(await res.arrayBuffer());
  assert(body.toString().startsWith("001e# service=git-upload-pack"), "v0 preamble");
  res = await fetch(base() + "/octocat/demo.git/info/refs?service=git-receive-pack");
  body = Buffer.from(await res.arrayBuffer());
  assert(body.toString().includes("report-status") && body.toString().includes("side-band-64k") && body.toString().includes("delete-refs"), "receive caps");
  res = await fetch(base() + "/no/such.git/info/refs?service=git-upload-pack", { headers: { "Git-Protocol": "version=2" } });
  assert(res.status === 404, "missing repo 404");

  // graphql
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ repository(owner:"octocat", name:"demo") { name issues(first:10, orderBy:{field: CREATED_AT, direction: DESC}) { nodes { number title state body } } } }' }) });
  console.log("graphql", r.status, JSON.stringify(r.json).slice(0, 200));
  assert(r.status === 200 && r.json.data.repository.issues.nodes.length >= 1, "graphql issues");
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ repository(owner:"octocat", name:"demo") { bogus } }' }) });
  assert(r.status === 200 && r.json.errors && r.json.errors[0].message.includes("bogus"), "graphql unknown field");
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ repository(owner:"octocat", name:"nope") { name } }' }) });
  assert(r.json.data.repository === null && !r.json.errors, "graphql unknown repo");
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ __type(name:"Issue") { fields { name } } }' }) });
  const names = r.json.data.__type.fields.map((f) => f.name);
  assert(["id", "number", "title", "state", "body"].every((n) => names.includes(n)), "introspection Issue");
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ __type(name:"PullRequest") { fields { name } } }' }) });
  const prNames = r.json.data.__type.fields.map((f) => f.name);
  assert(["id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files"].every((n) => prNames.includes(n)), "introspection PullRequest");
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ __type(name:"Repository") { fields { name } } }' }) });
  const repoNames = r.json.data.__type.fields.map((f) => f.name);
  assert(["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest"].every((n) => repoNames.includes(n)), "introspection Repository");
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: '{ __type(name:"SearchType") { enumValues { name } } }' }) });
  assert(r.json.data.__type.enumValues.some((v) => v.name === "ISSUE"), "SearchType ISSUE");
  r = await req("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ query: '{ repository(owner:"octocat", name:"demo") { name } }' }, { query: '{ repository(owner:"octocat", name:"demo") { nameWithOwner } }' }]) });
  assert(Array.isArray(r.json) && r.json.length === 2 && r.json[1].data.repository.nameWithOwner === "octocat/demo", "graphql batch");

  // MCP
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }) });
  assert(r.status === 200 && r.json.result.supportedVersions.length > 0, "mcp discover");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } } }) });
  assert(r.status === 200 && r.json.result.protocolVersion === "2025-11-25" && r.headers.get("mcp-session-id"), "mcp initialize/session");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert(r.status === 202, "mcp notification");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  const tools = r.json.result.tools;
  assert(tools.length >= 6, "mcp tools");
  const names2 = tools.map((t) => t.name);
  for (const n of ["create_repo", "get_repo", "create_issue", "list_issues", "create_pull_request", "merge_pull_request"]) assert(names2.includes(n), "tool " + n);
  const list1 = JSON.stringify(r.json.result.tools);
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
  assert(JSON.stringify(r.json.result.tools) === list1, "tools/list deterministic");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "xcreate_issue", arguments: { repo: "demo", title: "mcp issue", body: "b" } } }) });
  assert(r.status === 200 && !r.json.result.isError, "mcp create issue");
  const mcpIssue = r.json.result.structuredContent;
  r = await req("/api/v3/repos/octocat/demo/issues/" + mcpIssue.number);
  assert(r.json.id === mcpIssue.id, "mcp/rest same issue id");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_issue", arguments: { repo: "demo" } } }) });
  assert(r.status === 200 && r.json.result.isError === true, "mcp missing arg isError");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "not_a_tool", arguments: {} } }) });
  assert(r.status === 200 && (r.json.error.code === -32602 || r.json.error.code === -32601), "mcp unknown tool");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "forge_create_repo", arguments: { name: "mcp-repo", description: "d" } } }) });
  assert(r.status === 200 && !r.json.result.isError, "mcp create repo suffix");
  const mcpRepo = r.json.result.structuredContent;
  r = await req("/api/v3/repos/octocat/mcp-repo");
  assert(r.json.id === mcpRepo.id, "mcp/rest same repo id");
  r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert(r.status === 400 && r.json.error.code === -32700, "mcp parse error");
  r = await req("/mcp", { auth: false, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }) });
  assert(r.status === 401, "mcp 401");

  console.log("PROBE OK");
} finally {
  server.close();
}
