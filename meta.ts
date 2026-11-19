// meta.ts - users, repositories, labels, issues and pull requests.  This is
// the shared model used by REST, GraphQL and MCP, so an object created over any
// surface is literally the same object (and id) on the other surfaces.

import { buildCommit, parseCommit, signature } from "./gitobj.ts";
import {
  RepoStore,
  readTreeFlat,
  writeTreeFromFlat,
  type FileEntry,
} from "./store.ts";

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  repo: Repo;
  comments: IssueComment[];
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  issueNumber: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string | undefined;
  baseSha: string | undefined;
  user: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  repo: Repo;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  store: RepoStore;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  issueCounter: number;
  pullCounter: number;
  labelCounter: number;
}

export interface MergeResult {
  ok: boolean;
  conflict?: boolean;
  sha?: string;
  message: string;
}

const nowIso = (): string => new Date().toISOString();

function entryEq(a: FileEntry | undefined, b: FileEntry | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.mode === b.mode && a.sha === b.sha;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly users = new Map<string, User>();
  readonly defaultLogin: string;
  private repoCounter = 0;
  private entityCounter = 0;
  private issueCounter = 0;
  private pullCounter = 0;
  private labelCounter = 0;

  constructor(defaultLogin: string) {
    this.defaultLogin = defaultLogin;
    this.ensureUser(defaultLogin);
  }

  ensureUser(login: string): User {
    const key = login.toLowerCase();
    let user = this.users.get(key);
    if (!user) {
      user = {
        id: ++this.entityCounter,
        login,
        name: login,
        email: login + "@users.noreply.github.com",
      };
      this.users.set(key, user);
    }
    return user;
  }

  getUser(login: string): User | undefined {
    return this.users.get(login.toLowerCase());
  }

  repoKey(owner: string, name: string): string {
    return owner + "/" + name;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    const prefix = owner + "/";
    for (const repo of this.repos.values()) {
      if ((repo.owner + "/").toLowerCase() === prefix.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  createRepo(
    owner: string,
    name: string,
    opts: { description?: string | null; isPrivate?: boolean; autoInit?: boolean } = {},
  ): Repo {
    const key = this.repoKey(owner, name);
    const existing = this.repos.get(key);
    if (existing) return existing;
    this.ensureUser(owner);
    const repo: Repo = {
      id: ++this.repoCounter,
      owner,
      name,
      description: opts.description ?? null,
      private: !!opts.isPrivate,
      defaultBranch: "main",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      store: new RepoStore(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      issueCounter: 0,
      pullCounter: 0,
      labelCounter: 0,
    };
    this.repos.set(key, repo);
    if (opts.autoInit) {
      const readme = "# " + name + "\n";
      const sha = repo.store.putObject("blob", Buffer.from(readme, "utf8"));
      const files = new Map<string, FileEntry>();
      files.set("README.md", { mode: "100644", sha });
      this.commitFiles(repo, repo.defaultBranch, files, "Initial commit", owner);
    }
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  createLabel(repo: Repo, name: string, color = "ededed", description: string | null = null): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = {
      id: ++this.labelCounter,
      name,
      color,
      description,
    };
    repo.labels.set(name, label);
    repo.updatedAt = nowIso();
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[], login: string): Issue {
    const number = ++repo.issueCounter;
    const issue: Issue = {
      id: ++this.issueCounter,
      number,
      title,
      body,
      state: "open",
      labels,
      user: login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      repo,
      comments: [],
    };
    repo.issues.set(number, issue);
    repo.updatedAt = nowIso();
    return issue;
  }

  addIssueComment(repo: Repo, issue: Issue, body: string, login: string): IssueComment {
    const comment: IssueComment = {
      id: ++this.entityCounter,
      body,
      user: login,
      createdAt: nowIso(),
      issueNumber: issue.number,
    };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    repo.updatedAt = comment.createdAt;
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    login: string,
  ): Pull {
    const number = ++repo.pullCounter;
    const pull: Pull = {
      id: ++this.pullCounter,
      number,
      title,
      body,
      state: "open",
      merged: false,
      headRef,
      baseRef,
      headSha: repo.store.getRef("refs/heads/" + headRef),
      baseSha: repo.store.getRef("refs/heads/" + baseRef),
      user: login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      mergedAt: null,
      mergeCommitSha: null,
      repo,
    };
    repo.pulls.set(number, pull);
    repo.updatedAt = nowIso();
    return pull;
  }

  // Create (or replace) a commit on a branch from a flat file map.
  commitFiles(
    repo: Repo,
    branch: string,
    files: Map<string, FileEntry>,
    message: string,
    login: string,
  ): string {
    const user = this.ensureUser(login);
    const tree = writeTreeFromFlat(repo.store, files);
    const ref = "refs/heads/" + branch;
    let parent = repo.store.getRef(ref);
    if (!parent && branch !== repo.defaultBranch) {
      parent = repo.store.getRef("refs/heads/" + repo.defaultBranch);
    }
    const parents = parent ? [parent] : [];
    const secs = Math.floor(Date.now() / 1000);
    const sig = signature(user.name, user.email, secs);
    const body = buildCommit(tree, parents, sig, sig, message);
    const sha = repo.store.putObject("commit", body);
    repo.store.setRef(ref, sha);
    if (!repo.store.refs.has(repo.store.headRef)) {
      repo.store.headRef = ref;
    }
    repo.updatedAt = nowIso();
    return sha;
  }

  mergePull(repo: Repo, pull: Pull): MergeResult {
    if (pull.merged && pull.mergeCommitSha) {
      return { ok: true, sha: pull.mergeCommitSha, message: "Pull Request already merged" };
    }
    const baseRef = "refs/heads/" + pull.baseRef;
    const headRef = "refs/heads/" + pull.headRef;
    const baseSha = repo.store.getRef(baseRef);
    const headSha = repo.store.getRef(headRef);
    if (!baseSha || !headSha) {
      return { ok: false, conflict: true, message: "Pull Request cannot be merged" };
    }

    const merged = threeWayMerge(repo.store, baseSha, headSha);
    if (!merged) {
      return { ok: false, conflict: true, message: "Pull Request has conflicts" };
    }

    const user = this.ensureUser(pull.user);
    const tree = writeTreeFromFlat(repo.store, merged);
    const secs = Math.floor(Date.now() / 1000);
    const sig = signature(user.name, user.email, secs);
    const message = "Merge pull request #" + pull.number + " from " + pull.headRef + "\n\n" + pull.title;
    const parents = baseSha === headSha ? [baseSha] : [baseSha, headSha];
    const body = buildCommit(tree, parents, sig, sig, message);
    const sha = repo.store.putObject("commit", body);
    repo.store.setRef(baseRef, sha);
    pull.state = "closed";
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.updatedAt = nowIso();
    pull.mergeCommitSha = sha;
    repo.updatedAt = nowIso();
    return { ok: true, sha, message: "Pull Request successfully merged" };
  }
}

function threeWayMerge(
  store: RepoStore,
  baseSha: string,
  headSha: string,
): Map<string, FileEntry> | undefined {
  const baseTree = store.commitTree(baseSha);
  const headTree = store.commitTree(headSha);
  if (!baseTree || !headTree) return undefined;
  const mergeBase = findMergeBase(store, baseSha, headSha);
  if (!mergeBase) return undefined;
  const mbTree = store.commitTree(mergeBase);
  const mbFiles = mbTree ? readTreeFlat(store, mbTree) : new Map<string, FileEntry>();
  const baseFiles = readTreeFlat(store, baseTree);
  const headFiles = readTreeFlat(store, headTree);

  const merged = new Map<string, FileEntry>();
  const paths = new Set<string>();
  for (const p of mbFiles.keys()) paths.add(p);
  for (const p of baseFiles.keys()) paths.add(p);
  for (const p of headFiles.keys()) paths.add(p);

  for (const path of paths) {
    const m = mbFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (entryEq(h, m)) {
      if (b) merged.set(path, b);
    } else if (entryEq(b, m)) {
      if (h) merged.set(path, h);
    } else if (entryEq(b, h)) {
      if (b) merged.set(path, b);
    } else {
      return undefined;
    }
  }
  return merged;
}

export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const baseSha = repo.store.getRef("refs/heads/" + pull.baseRef);
  const headSha = repo.store.getRef("refs/heads/" + pull.headRef);
  if (!baseSha || !headSha) return false;
  return threeWayMerge(repo.store, baseSha, headSha) !== undefined;
}

// Find the best common ancestor by BFS from both sides and taking the common
// commit with the smallest combined distance.  Linear histories reduce to the
// obvious merge base; branchy histories still get a sensible answer.
export function findMergeBase(store: RepoStore, a: string, b: string): string | undefined {
  const distA = ancestorDistances(store, a);
  const distB = ancestorDistances(store, b);
  let best: string | undefined;
  let bestScore = Infinity;
  for (const [sha, da] of distA) {
    const db = distB.get(sha);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      best = sha;
      bestScore = score;
    }
  }
  return best;
}

function ancestorDistances(store: RepoStore, start: string): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [[start, 0]];
  let head = 0;
  while (head < queue.length) {
    const [sha, d] = queue[head++];
    const prev = dist.get(sha);
    if (prev !== undefined && prev <= d) continue;
    dist.set(sha, d);
    const commit = store.getCommit(sha);
    if (!commit) continue;
    for (const p of commit.parents) queue.push([p, d + 1]);
  }
  return dist;
}

export function flatFilesForBranch(repo: Repo, branch: string): Map<string, FileEntry> {
  const sha = repo.store.getRef("refs/heads/" + branch);
  if (!sha) return new Map();
  const tree = repo.store.commitTree(sha);
  if (!tree) return new Map();
  return readTreeFlat(repo.store, tree);
}

export function fileAt(repo: Repo, branch: string, path: string): FileEntry | undefined {
  return flatFilesForBranch(repo, branch).get(path);
}

export function commitInfoFor(store: RepoStore, sha: string) {
  const obj = store.getObject(sha);
  if (!obj || obj.type !== "commit") return undefined;
  return parseCommit(obj.body);
}
