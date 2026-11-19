// store.ts - the in-memory object database and ref namespace for one repo.
// Everything is keyed directly: refs by name, objects by their 40-char id.
// No Map is ever scanned to allocate a number or find a value.

import {
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type CommitInfo,
  type GitObject,
  type TreeEntry,
} from "./gitobj.ts";

export interface FileEntry {
  mode: string;
  sha: string;
}

export class RepoStore {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  headRef = "refs/heads/main";

  putObject(type: string, body: Buffer): string {
    const sha = hashObject(type, body);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, body });
    return sha;
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  hasObject(sha: string): boolean {
    return this.objects.has(sha);
  }

  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, sha: string): void {
    this.refs.set(name, sha);
  }

  deleteRef(name: string): boolean {
    return this.refs.delete(name);
  }

  headSha(): string | undefined {
    return this.refs.get(this.headRef);
  }

  sortedRefs(): Array<[string, string]> {
    return Array.from(this.refs.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  getCommit(sha: string): CommitInfo | undefined {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== "commit") return undefined;
    return parseCommit(obj.body);
  }

  commitTree(sha: string): string | undefined {
    return this.getCommit(sha)?.tree;
  }
}

const emptyFiles = (): Map<string, FileEntry> => new Map();

// Flatten a tree recursively into path -> {mode, sha}.  Submodules (mode
// 160000) are kept as leaf entries; directories are not.
export function readTreeFlat(
  store: RepoStore,
  treeSha: string,
  prefix = "",
  out: Map<string, FileEntry> = emptyFiles(),
): Map<string, FileEntry> {
  const obj = store.getObject(treeSha);
  if (!obj || obj.type !== "tree") return out;
  for (const entry of parseTree(obj.body)) {
    const path = prefix + entry.name;
    if (entry.mode === "40000") {
      readTreeFlat(store, entry.sha, path + "/", out);
    } else {
      out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  }
  return out;
}

interface TreeNode {
  files: TreeEntry[];
  dirs: Map<string, TreeNode>;
}

function newTreeNode(): TreeNode {
  return { files: [], dirs: new Map() };
}

// Build (and store) nested trees from a flat path map.  Returns the root tree
// object id.  This is used by REST content writes and by squash merges.
export function writeTreeFromFlat(store: RepoStore, files: Map<string, FileEntry>): string {
  const root = newTreeNode();
  for (const [path, entry] of files) {
    const parts = path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let child = node.dirs.get(name);
      if (!child) {
        child = newTreeNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1], sha: entry.sha });
  }

  function build(node: TreeNode): string {
    const entries = node.files.slice();
    for (const [name, child] of node.dirs) {
      entries.push({ mode: "40000", name, sha: build(child) });
    }
    const body = buildTree(entries);
    return store.putObject("tree", body);
  }

  return build(root);
}
