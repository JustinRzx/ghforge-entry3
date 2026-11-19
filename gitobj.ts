// gitobj.ts - git object encoding, hashing, tree/commit/tag parsing.
//
// An object id is sha1("<type> <byte-length>\0<body>").  The body of a tree is
// a sequence of "<mode> <name>\0<20 raw sha bytes>" entries in git's sort
// order.  Commit and tag bodies are plain text with a few header lines.

import { createHash } from "node:crypto";

export type GitObjectType = "blob" | "tree" | "commit" | "tag" | (string & {});

export interface GitObject {
  type: GitObjectType;
  body: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function sha1(data: Buffer | Uint8Array | string): string {
  return createHash("sha1").update(data as any).digest("hex");
}

export function objectHeader(type: string, length: number): Buffer {
  return Buffer.from(type + " " + String(length) + "\0", "utf8");
}

export function hashObject(type: string, body: Buffer): string {
  const h = createHash("sha1");
  h.update(objectHeader(type, body.length));
  h.update(body);
  return h.digest("hex");
}

export function encodeObject(type: string, body: Buffer): Buffer {
  return Buffer.concat([objectHeader(type, body.length), body]);
}

export function decodeObject(raw: Buffer): GitObject {
  let nul = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) {
      nul = i;
      break;
    }
  }
  if (nul < 0) throw new Error("invalid git object: missing header");
  const header = raw.subarray(0, nul).toString("utf8");
  const sp = header.indexOf(" ");
  if (sp < 0) throw new Error("invalid git object header");
  const type = header.slice(0, sp);
  const length = parseInt(header.slice(sp + 1), 10);
  const body = raw.subarray(nul + 1);
  if (!Number.isFinite(length) || body.length !== length) {
    throw new Error("invalid git object length");
  }
  return { type, body };
}

function hexToRaw(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  // Git compares names bytewise, treating directory names as if they had a
  // trailing slash.  This matters for entries like "foo" vs "foo.txt".
  const ak = Buffer.from(a.name + (a.mode === "40000" ? "/" : ""), "utf8");
  const bk = Buffer.from(b.name + (b.mode === "40000" ? "/" : ""), "utf8");
  return Buffer.compare(ak, bk);
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.slice().sort(compareTreeEntries);
}

export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < body.length) {
    let sp = pos;
    while (sp < body.length && body[sp] !== 0x20) sp++;
    if (sp >= body.length) throw new Error("invalid tree entry: no mode space");
    const mode = body.subarray(pos, sp).toString("utf8");
    pos = sp + 1;
    let nul = pos;
    while (nul < body.length && body[nul] !== 0) nul++;
    if (nul >= body.length) throw new Error("invalid tree entry: no name terminator");
    const name = body.subarray(pos, nul).toString("utf8");
    pos = nul + 1;
    if (pos + 20 > body.length) throw new Error("invalid tree entry: truncated sha");
    const sha = body.subarray(pos, pos + 20).toString("hex");
    pos += 20;
    out.push({ mode, name, sha });
  }
  return out;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of sortTreeEntries(entries)) {
    parts.push(Buffer.from(e.mode + " " + e.name + "\0", "utf8"));
    parts.push(hexToRaw(e.sha));
  }
  return Buffer.concat(parts);
}

export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString("utf8");
  const sep = text.indexOf("\n\n");
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : "";
  const info: CommitInfo = { tree: "", parents: [], author: "", committer: "", message };
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "tree") info.tree = value;
    else if (key === "parent") info.parents.push(value);
    else if (key === "author") info.author = value;
    else if (key === "committer") info.committer = value;
  }
  return info;
}

export function parseTag(body: Buffer): TagInfo {
  const text = body.toString("utf8");
  const sep = text.indexOf("\n\n");
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : "";
  const info: TagInfo = { object: "", type: "", tag: "", tagger: "", message };
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "object") info.object = value;
    else if (key === "type") info.type = value;
    else if (key === "tag") info.tag = value;
    else if (key === "tagger") info.tagger = value;
  }
  return info;
}

export function signature(name: string, email: string, seconds: number): string {
  return `${name} <${email}> ${seconds} +0000`;
}

export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  let text = "tree " + tree + "\n";
  for (const p of parents) text += "parent " + p + "\n";
  text += "author " + author + "\n";
  text += "committer " + committer + "\n\n";
  text += message;
  if (!message.endsWith("\n")) text += "\n";
  return Buffer.from(text, "utf8");
}
