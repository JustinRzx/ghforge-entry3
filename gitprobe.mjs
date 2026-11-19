import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForgeServer } from "./app.ts";
import { Forge } from "./meta.ts";

const run = promisify(execFile);
const token = "probe-token";
const login = "octocat";
const forge = new Forge(login);
const server = createForgeServer(forge, { token, login });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const root = mkdtempSync(join(tmpdir(), "ghf-git-"));
const work = join(root, "work");
const clone = join(root, "clone");
const shallow = join(root, "shallow");

async function git(args, cwd) {
  const res = await run("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return res.stdout;
}
async function sh(file, args, cwd) {
  const res = await run(file, args, { cwd, encoding: "utf8" });
  return res.stdout;
}
function log(...a) {
  process.stderr.write(a.map(String).join(" ") + "\n");
}
function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}
async function httpJson(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.auth !== false) headers.authorization = "Bearer " + token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { ...opts, headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

try {
  forge.createRepo(login, "gitdemo", { autoInit: false });

  // A push cannot invent a repository.
  const bogus = join(root, "bogus");
  await sh("git", ["init", "-b", "main", bogus], root);
  writeFileSync(join(bogus, "x.txt"), "x\n");
  await git(["add", "."], bogus);
  await git(["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "x"], bogus);
  await git(["remote", "add", "origin", base + "/octocat/missing.git"], bogus);
  let refused = false;
  try { await git(["push", "origin", "main"], bogus); } catch { refused = true; }
  assert(refused, "push to missing repo refused");

  await sh("git", ["init", "-b", "main", work], root);
  await git(["config", "user.name", "Test"], work);
  await git(["config", "user.email", "test@example.com"], work);
  writeFileSync(join(work, "a.txt"), "one\n");
  await git(["add", "."], work);
  await git(["commit", "-m", "one"], work);
  await git(["remote", "add", "origin", base + "/octocat/gitdemo.git"], work);
  log("push 1");
  await git(["push", "origin", "main"], work);

  log("clone");
  await git(["clone", base + "/octocat/gitdemo.git", clone], root);
  assert(readFileSync(join(clone, "a.txt"), "utf8") === "one\n", "clone file");
  assert((await git(["rev-list", "--count", "HEAD"], clone)).trim() === "1", "clone count 1");

  const clone0 = join(root, "clone0");
  await git(["-c", "protocol.version=0", "clone", base + "/octocat/gitdemo.git", clone0], root);
  assert(readFileSync(join(clone0, "a.txt"), "utf8") === "one\n", "v0 clone file");

  writeFileSync(join(work, "a.txt"), "two\n");
  await git(["commit", "-am", "two"], work);
  log("push 2");
  await git(["push", "origin", "main"], work);

  // A non-fast-forward push must be refused and the ref must not move.
  await git(["reset", "--hard", "HEAD~1"], work);
  writeFileSync(join(work, "a.txt"), "diverged\n");
  await git(["commit", "-am", "diverged"], work);
  let ffRefused = false;
  let pushOut = "";
  try {
    pushOut = await git(["push", "origin", "main"], work);
  } catch (err) {
    ffRefused = true;
    pushOut = String(err.stderr || "") + String(err.stdout || "");
  }
  log("nonff", pushOut.split("\n").slice(-4).join(" | "));
  assert(ffRefused && /non-fast-forward|rejected/i.test(pushOut), "non-ff refused: " + pushOut);

  await git(["fetch", "origin"], work);
  await git(["reset", "--hard", "origin/main"], work);
  writeFileSync(join(work, "b.txt"), "b\n");
  await git(["add", "."], work);
  await git(["commit", "-m", "fast"], work);
  const fast = (await git(["rev-parse", "HEAD"], work)).trim();
  await git(["push", "origin", "main"], work);
  assert((await git(["rev-parse", "origin/main"], work)).trim() === fast, "fast-forward applied");

  // One fast-forward and one non-fast-forward in the same push: both get a
  // report line, the fast-forward moves, the other ref does not.
  log("mixed refs push");
  await git(["branch", "ff", "origin/main"], work);
  await git(["branch", "bad", "origin/main"], work);
  await git(["push", "origin", "ff:refs/heads/ff", "bad:refs/heads/bad"], work);
  const badBefore = (await git(["rev-parse", "origin/bad"], work)).trim();
  const old = (await git(["rev-parse", "origin/main~2"], work)).trim();
  await git(["checkout", "ff"], work);
  writeFileSync(join(work, "ff.txt"), "ff\n");
  await git(["add", "."], work);
  await git(["commit", "-m", "ff work"], work);
  const ffTip = (await git(["rev-parse", "HEAD"], work)).trim();
  await git(["checkout", "bad"], work);
  await git(["reset", "--hard", old], work);
  writeFileSync(join(work, "bad.txt"), "bad\n");
  await git(["add", "."], work);
  await git(["commit", "-m", "bad work"], work);
  let mixed = "";
  let mixedFailed = false;
  try { mixed = await git(["push", "origin", "ff", "bad"], work); } catch (err) {
    mixedFailed = true;
    mixed = String(err.stderr || "") + String(err.stdout || "");
  }
  assert(mixedFailed, "mixed push has a rejected ref");
  assert(/non-fast-forward|rejected/i.test(mixed), "mixed push refuses non-ff: " + mixed);
  await git(["fetch", "origin"], work);
  assert((await git(["rev-parse", "origin/ff"], work)).trim() === ffTip, "mixed ff ref moved");
  assert((await git(["rev-parse", "origin/bad"], work)).trim() === badBefore, "mixed bad ref did not move");
  await git(["push", "origin", "--delete", "bad"], work);
  const deleted = await git(["ls-remote", "origin", "refs/heads/bad"], work);
  assert(deleted.trim() === "", "delete ref");
  await git(["checkout", "main"], work);

  for (let i = 0; i < 9; i++) {
    writeFileSync(join(work, "c.txt"), "c" + i + "\n");
    await git(["add", "."], work);
    await git(["commit", "-m", "c" + i], work);
  }
  const full = (await git(["rev-list", "--count", "HEAD"], work)).trim();
  log("full history", full);
  await git(["push", "origin", "main"], work);

  log("tag push/clone");
  await git(["tag", "-a", "v1", "-m", "release"], work);
  await git(["push", "origin", "v1"], work);
  const tagClone = join(root, "tagclone");
  await git(["clone", base + "/octocat/gitdemo.git", tagClone], root);
  const tagType = (await git(["cat-file", "-t", "v1"], tagClone)).trim();
  assert(tagType === "tag", "annotated tag cloned, got " + tagType);

  // GraphQL opener + REST read-back + squash merge.
  log("pull request flow");
  await git(["checkout", "-b", "feature"], work);
  writeFileSync(join(work, "d.txt"), "feature\n");
  await git(["add", "."], work);
  await git(["commit", "-m", "feature work"], work);
  await git(["push", "origin", "feature"], work);

  let gr = await httpJson("/api/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: 'query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id name } }',
      variables: { owner: "octocat", name: "gitdemo" },
    }),
  });
  const gid = gr.json.data.repository.id;
  assert(gr.json.data.repository.name === "gitdemo", "graphql repo");
  gr = await httpJson("/api/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: 'mutation Create($input: CreatePullRequestInput!){ createPullRequest(input:$input){ pullRequest { number headRefName baseRefName state } } }',
      variables: { input: { repositoryId: gid, headRefName: "feature", baseRefName: "main", title: "feat" } },
    }),
  });
  const pr = gr.json.data.createPullRequest.pullRequest;
  assert(pr && pr.headRefName === "feature" && pr.baseRefName === "main", "graphql create PR");
  let restPr = await httpJson("/api/v3/repos/octocat/gitdemo/pulls/" + pr.number);
  assert(restPr.status === 200 && restPr.json.head.ref === "feature" && restPr.json.base.ref === "main", "REST reads PR");
  const merged = await httpJson("/api/v3/repos/octocat/gitdemo/pulls/" + pr.number + "/merge", { method: "PUT", body: "{}" });
  assert(merged.status === 200 && merged.json.merged === true && merged.json.sha, "merge PR");
  restPr = await httpJson("/api/v3/repos/octocat/gitdemo/pulls/" + pr.number);
  assert(restPr.json.merged === true && restPr.json.state === "closed", "PR closed after merge");
  const mergedFile = await httpJson("/api/v3/repos/octocat/gitdemo/contents/d.txt");
  assert(mergedFile.status === 200, "squash commit on default branch");

  // Conflicted merge must be 405.
  log("conflict flow");
  await git(["checkout", "main"], work);
  await git(["fetch", "origin"], work);
  await git(["reset", "--hard", "origin/main"], work);
  await git(["checkout", "-b", "conflict"], work);
  writeFileSync(join(work, "d.txt"), "head side\n");
  await git(["commit", "-am", "head side"], work);
  await git(["push", "origin", "conflict"], work);
  await git(["checkout", "main"], work);
  writeFileSync(join(work, "d.txt"), "base side\n");
  await git(["commit", "-am", "base side"], work);
  await git(["push", "origin", "main"], work);
  const conflictPr = await httpJson("/api/v3/repos/octocat/gitdemo/pulls", {
    method: "POST",
    body: JSON.stringify({ title: "conflict", head: "conflict", base: "main" }),
  });
  assert(conflictPr.status === 201, "conflict PR created");
  assert(conflictPr.json.mergeable === false && conflictPr.json.mergeable_state === "dirty", "conflict PR mergeable false");
  const conflictGql = await httpJson("/api/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: '{ repository(owner:"octocat", name:"gitdemo") { pullRequest(number:' + conflictPr.json.number + ") { mergeable } } }",
    }),
  });
  assert(
    conflictGql.json.data.repository.pullRequest.mergeable === "CONFLICTING",
    "GraphQL conflict mergeable",
  );
  const conflictMerge = await httpJson(
    "/api/v3/repos/octocat/gitdemo/pulls/" + conflictPr.json.number + "/merge",
    { method: "PUT", body: "{}" },
  );
  assert(conflictMerge.status === 405, "conflicted merge 405: " + conflictMerge.status);

  log("shallow clone");
  await git(["clone", "--depth", "1", base + "/octocat/gitdemo.git", shallow], root);
  const shallowCount = (await git(["rev-list", "--count", "HEAD"], shallow)).trim();
  assert(shallowCount === "1", "depth 1 count: " + shallowCount);
  assert(existsSync(join(shallow, ".git", "shallow")), "shallow file");
  const shallow0 = join(root, "shallow0");
  await git(["-c", "protocol.version=0", "clone", "--depth", "1", base + "/octocat/gitdemo.git", shallow0], root);
  assert((await git(["rev-list", "--count", "HEAD"], shallow0)).trim() === "1", "v0 depth 1 count");
  await git(["-c", "protocol.version=0", "fetch", "--deepen=1", "origin", "main"], shallow0);
  const v0deep = (await git(["rev-list", "--count", "HEAD"], shallow0)).trim();
  assert(v0deep === "2", "v0 deepen count: " + v0deep);

  log("deepen");
  await git(["fetch", "--deepen=1", "origin"], shallow);
  const after = (await git(["rev-list", "--count", "HEAD"], shallow)).trim();
  log("after deepen count", after);
  assert(Number(after) > 1, "deepen added commits");

  log("rest-created repositories");
  const autoRepo = await httpJson("/api/v3/user/repos", {
    method: "POST",
    body: JSON.stringify({ name: "auto", auto_init: true }),
  });
  assert(autoRepo.status === 201, "auto-init repo created");
  const autoClone = join(root, "autoclone");
  await git(["clone", base + "/octocat/auto.git", autoClone], root);
  assert(readFileSync(join(autoClone, "README.md"), "utf8") === "# auto\n", "clone auto-init readme");

  const contentsRepo = await httpJson("/api/v3/user/repos", {
    method: "POST",
    body: JSON.stringify({ name: "via-rest" }),
  });
  assert(contentsRepo.status === 201, "rest repo created");
  const put = await httpJson("/api/v3/repos/octocat/via-rest/contents/hello.txt", {
    method: "PUT",
    body: JSON.stringify({ message: "add hello", content: Buffer.from("hello\n").toString("base64") }),
  });
  assert(put.status === 201 && put.json.commit.sha, "content commit created");
  const restClone = join(root, "restclone");
  await git(["clone", base + "/octocat/via-rest.git", restClone], root);
  assert(readFileSync(join(restClone, "hello.txt"), "utf8") === "hello\n", "clone REST content");

  log("GIT PROBE OK");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
