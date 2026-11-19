// githttp.ts - git smart HTTP: pkt-lines, advertisements, upload-pack v0/v2,
// receive-pack v0, pack parsing/building and shallow boundaries.
//
// The representation is deliberately simple: outgoing packs contain full
// objects (no deltas), incoming packs may use both ofs-delta and ref-delta.

import {
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  sha1,
  type GitObject,
} from "./gitobj.ts";
import { RepoStore } from "./store.ts";
import { deflate, inflateOne } from "./zstream.ts";

const FLUSH = Buffer.from("0000", "ascii");
const DELIM = Buffer.from("0001", "ascii");
const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface PktLine {
  kind: "data" | "flush" | "delim" | "response-end";
  data: Buffer;
}

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const length = body.length + 4;
  const hex = length.toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(hex, "ascii"), body]);
}

export function pktLines(lines: Array<string | Buffer>, end = true): Buffer {
  const parts = lines.map(pkt);
  if (end) parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function parsePktLines(
  input: Buffer,
  start = 0,
  stopAtFlush = true,
): { lines: PktLine[]; end: number } {
  const lines: PktLine[] = [];
  let pos = start;
  while (pos + 4 <= input.length) {
    const hex = input.subarray(pos, pos + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    pos += 4;
    if (length === 0) {
      lines.push({ kind: "flush", data: Buffer.alloc(0) });
    } else if (length === 1) {
      lines.push({ kind: "delim", data: Buffer.alloc(0) });
    } else if (length === 2) {
      lines.push({ kind: "response-end", data: Buffer.alloc(0) });
    } else {
      const end = Math.min(pos + length - 4, input.length);
      lines.push({ kind: "data", data: input.subarray(pos, end) });
      pos = end;
    }
    if (lines[lines.length - 1].kind === "flush" && stopAtFlush) break;
  }
  return { lines, end: pos };
}

export function lineText(line: PktLine): string {
  return line.data.toString("utf8").replace(/\n$/, "");
}

interface AdvertisedRef {
  name: string;
  sha: string;
  symref?: string;
  peeled?: string;
}

function advertisedRefs(store: RepoStore, peel: boolean): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const head = store.headSha();
  if (head) out.push({ name: "HEAD", sha: head, symref: store.headRef });
  for (const [name, sha] of store.sortedRefs()) {
    out.push({ name, sha });
    if (peel && name.startsWith("refs/tags/")) {
      const obj = store.getObject(sha);
      if (obj && obj.type === "tag") {
        try {
          const tag = parseTag(obj.body);
          out.push({ name: name + "^{}", sha: tag.object, peeled: tag.object });
        } catch {
          // A malformed tag does not make the advertisement fail.
        }
      }
    }
  }
  return out;
}

const UPLOAD_CAPS =
  "side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative " +
  "no-progress include-tag object-format=sha1 agent=ghforge/1.0";

export function uploadAdvertisement(store: RepoStore, v2: boolean): Buffer {
  if (v2) {
    // Protocol v2's advertisement opens with the version pkt-line.  No
    // "# service=" preamble is used for v2.
    return pktLines([
      "version 2\n",
      "agent=ghforge/1.0\n",
      "ls-refs=unborn\n",
      "fetch=shallow wait-for-done\n",
      "object-format=sha1\n",
    ]);
  }
  const caps =
    UPLOAD_CAPS +
    " symref=HEAD:" +
    store.headRef +
    " multi_ack_detailed";
  const refs = advertisedRefs(store, false);
  const lines: Buffer[] = [];
  lines.push(pkt("# service=git-upload-pack\n"));
  lines.push(FLUSH);
  if (refs.length === 0) {
    lines.push(pkt(ZERO_SHA + " capabilities^{}\0" + caps + "\n"));
  } else {
    refs.forEach((ref, i) => {
      const suffix = i === 0 ? "\0" + caps : "";
      lines.push(pkt(ref.sha + " " + ref.name + suffix + "\n"));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

export function receiveAdvertisement(store: RepoStore): Buffer {
  const caps =
    "report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=ghforge/1.0";
  const refs = advertisedRefs(store, false);
  const lines: Buffer[] = [];
  lines.push(pkt("# service=git-receive-pack\n"));
  lines.push(FLUSH);
  if (refs.length === 0) {
    lines.push(pkt(ZERO_SHA + " capabilities^{}\0" + caps + "\n"));
  } else {
    refs.forEach((ref, i) => {
      const suffix = i === 0 ? "\0" + caps : "";
      lines.push(pkt(ref.sha + " " + ref.name + suffix + "\n"));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

function refMatches(name: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  for (const p of prefixes) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

function lsRefs(store: RepoStore, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === "peel") peel = true;
    else if (arg === "symrefs") symrefs = true;
    else if (arg === "unborn") unborn = true;
    else if (arg.startsWith("ref-prefix ")) prefixes.push(arg.slice("ref-prefix ".length));
  }

  const out: Buffer[] = [];
  const refs = advertisedRefs(store, false);
  for (const ref of refs) {
    if (!refMatches(ref.name, prefixes)) continue;
    let line = ref.sha + " " + ref.name;
    if (symrefs && ref.symref) line += " symref-target:" + ref.symref;
    if (peel && ref.name.startsWith("refs/tags/")) {
      const obj = store.getObject(ref.sha);
      if (obj && obj.type === "tag") {
        try {
          line += " peeled:" + parseTag(obj.body).object;
        } catch {
          // Ignore malformed tag bodies.
        }
      }
    }
    out.push(pkt(line + "\n"));
  }
  if (unborn && !store.headSha() && refMatches("HEAD", prefixes)) {
    out.push(pkt("unborn HEAD symref-target:" + store.headRef + "\n"));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

interface CollectOptions {
  depth?: number;
  oldShallow?: string[];
  relative?: boolean;
  haves?: string[];
}

interface Collected {
  objects: string[];
  shallow: string[];
  unshallow: string[];
}

function derefCommit(store: RepoStore, sha: string): string | undefined {
  let current = sha;
  for (let i = 0; i < 10; i++) {
    const obj = store.getObject(current);
    if (!obj) return undefined;
    if (obj.type === "commit") return current;
    if (obj.type === "tag") {
      try {
        current = parseTag(obj.body).object;
        continue;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  return undefined;
}

function addTreeObjects(store: RepoStore, treeSha: string, out: Set<string>): void {
  if (out.has(treeSha)) return;
  const obj = store.getObject(treeSha);
  if (!obj) return;
  out.add(treeSha);
  if (obj.type !== "tree") return;
  for (const entry of parseTree(obj.body)) {
    if (entry.mode === "40000") {
      addTreeObjects(store, entry.sha, out);
    } else if (entry.mode !== "160000") {
      const child = store.getObject(entry.sha);
      if (child) out.add(entry.sha);
    }
  }
}

function commitDistances(
  store: RepoStore,
  roots: string[],
  maxDistance: number = Infinity,
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const sha of roots) queue.push([sha, 0]);
  let head = 0;
  while (head < queue.length) {
    const [sha, d] = queue[head++];
    if (d > maxDistance) continue;
    const prev = dist.get(sha);
    if (prev !== undefined && prev <= d) continue;
    dist.set(sha, d);
    if (d === maxDistance) continue;
    const commit = store.getCommit(sha);
    if (!commit) continue;
    for (const p of commit.parents) queue.push([p, d + 1]);
  }
  return dist;
}

function collectObjects(store: RepoStore, wants: string[], opts: CollectOptions): Collected {
  const objectSet = new Set<string>();
  const rootCommits: string[] = [];
  const extraRoots: string[] = [];
  // A fetch that names what the client already has (`have` lines) asks only for the objects
  // reachable from the wants but not from the haves: an incremental fetch must not re-send them.
  const haveSet = new Set(opts.haves ?? []);
  // Every object reachable from a `have` — commits and, recursively, their trees and blobs.
  const haveReachable = new Set<string>();
  if (haveSet.size) {
    for (const sha of haveSet) {
      const obj = store.getObject(sha);
      if (!obj) continue;
      haveReachable.add(sha);
      if (obj.type === "commit") {
        const c = store.getCommit(sha);
        if (c) addTreeObjects(store, c.tree, haveReachable);
      } else if (obj.type === "tree") {
        addTreeObjects(store, sha, haveReachable);
      } else if (obj.type === "tag") {
        try {
          const tag = parseTag(obj.body);
          const t = store.getObject(tag.object);
          if (t) {
            haveReachable.add(tag.object);
            if (t.type === "commit") { const c = store.getCommit(tag.object); if (c) addTreeObjects(store, c.tree, haveReachable); }
            else if (t.type === "tree") addTreeObjects(store, tag.object, haveReachable);
          }
        } catch { /* ignore */ }
      }
    }
  }

  for (const want of wants) {
    const obj = store.getObject(want);
    if (!obj) continue;
    // A `have` that names the want means the client already holds the tip itself; only the
    // shallow boundary may move. Skip it as a new object but still walk from it below.
    if (haveSet.has(want)) {
      if (obj.type === "commit") rootCommits.push(want);
      continue;
    }
    objectSet.add(want);
    if (obj.type === "tag") {
      // Keep the tag and walk its target; annotated tag pushes/clones need it.
      try {
        const tag = parseTag(obj.body);
        const target = store.getObject(tag.object);
        if (target) {
          objectSet.add(tag.object);
          if (target.type === "commit") rootCommits.push(tag.object);
          else if (target.type === "tree") addTreeObjects(store, tag.object, objectSet);
        }
      } catch {
        // ignore bad tag body
      }
    } else if (obj.type === "commit") {
      rootCommits.push(want);
    } else if (obj.type === "tree") {
      addTreeObjects(store, want, objectSet);
    }
  }

  const oldShallow = opts.oldShallow ?? [];
  const oldSet = new Set(oldShallow);
  let depth = opts.depth && opts.depth > 0 ? opts.depth : Infinity;
  const relativeShallow = !!opts.relative && oldShallow.length > 0;
  // A plain `deepen N` on an existing shallow clone means "N generations deep from the tip",
  // measured against the OLD shallow boundary: the old shallow commits sit at depth N-1 and are
  // unshallowed, and anything at depth N becomes the new shallow line. So the walk must reach
  // depth N from the want, and the inclusion cut is `d < depth` measured the same way.
  const walkLimit = Number.isFinite(depth) ? Math.max(0, depth) : Infinity;
  const distances = commitDistances(store, rootCommits, walkLimit);

  if (Number.isFinite(depth) && oldShallow.length > 0) {
    // Deepening an existing shallow clone: the boundary moves by the old shallow's distance.
    let existing = 0;
    for (const s of oldShallow) {
      const d = distances.get(s);
      if (d !== undefined && d + 1 > existing) existing = d + 1;
    }
    if (opts.relative) depth = existing + depth;
    else depth = Math.max(depth, existing);
  }

  const includedCommits = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();

  if (!Number.isFinite(depth)) {
    for (const sha of distances.keys()) includedCommits.add(sha);
  } else {
    for (const [sha, d] of distances) {
      if (d < depth) includedCommits.add(sha);
      if (d === depth - 1) {
        const commit = store.getCommit(sha);
        if (commit && commit.parents.length > 0) shallow.add(sha);
      }
    }
    for (const s of oldShallow) {
      const d = distances.get(s);
      if (d !== undefined && d < depth - 1) unshallow.add(s);
    }
  }

  // Objects reachable from regular wants that are not commits.
  for (const sha of extraRoots) objectSet.add(sha);

  for (const sha of includedCommits) {
    // Skip anything reachable from a `have`: the client already has it.
    if (haveReachable.has(sha)) continue;
    objectSet.add(sha);
    const commit = store.getCommit(sha);
    if (commit) addTreeObjects(store, commit.tree, objectSet);
  }

  // Drop anything the client already holds (reachable from a `have`), commits and their trees/blobs.
  for (const sha of [...objectSet]) {
    if (haveReachable.has(sha)) objectSet.delete(sha);
  }

  // `oldSet` is currently only informational; keeping it out of the result
  // avoids accidentally sending an unshallow line for an unrelated shallow.
  void oldSet;

  return {
    objects: Array.from(objectSet).filter((sha) => store.hasObject(sha)),
    shallow: Array.from(shallow),
    unshallow: Array.from(unshallow),
  };
}

function encodePackHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let c = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(c | 0x80);
    c = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(c);
  return Buffer.from(bytes);
}

export function buildPack(store: RepoStore, shas: string[]): Buffer {
  const seen = new Set<string>();
  const entries: Buffer[] = [];
  let count = 0;
  for (const sha of shas) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.getObject(sha);
    if (!obj) continue;
    let type = 0;
    if (obj.type === "commit") type = 1;
    else if (obj.type === "tree") type = 2;
    else if (obj.type === "blob") type = 3;
    else if (obj.type === "tag") type = 4;
    else continue;
    const header = encodePackHeader(type, obj.body.length);
    const compressed = deflate(obj.body, 6);
    entries.push(header, compressed);
    count++;
  }
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "ascii");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(count, 8);
  const payload = Buffer.concat([head, ...entries]);
  // A pack ends with the SHA-1 trailer over everything before it.
  return Buffer.concat([payload, Buffer.from(sha1(payload), "hex")]);
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 65000;
  for (let i = 0; i < pack.length; i += chunkSize) {
    const chunk = pack.subarray(i, i + chunkSize);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  relative: boolean;
  done: boolean;
  sidebandAll: boolean;
  sideband64k: boolean;
}

function parseFetchArgs(args: string[]): FetchRequest {
  const req: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    relative: false,
    done: false,
    sidebandAll: false,
    sideband64k: false,
  };
  for (const arg of args) {
    const sp = arg.indexOf(" ");
    const key = sp < 0 ? arg : arg.slice(0, sp);
    const value = sp < 0 ? "" : arg.slice(sp + 1);
    if (key === "want") req.wants.push(value.split(" ")[0]);
    else if (key === "have") req.haves.push(value.split(" ")[0]);
    else if (key === "shallow") req.shallow.push(value.split(" ")[0]);
    else if (key === "deepen") req.depth = parseInt(value, 10);
    else if (key === "deepen-relative") req.relative = true;
    else if (key === "done") req.done = true;
    else if (key === "sideband-all") req.sidebandAll = true;
    else if (key === "side-band-64k") req.sideband64k = true;
  }
  return req;
}

function packResponseV2(store: RepoStore, req: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  if (!req.done) {
    // Stateless negotiation: answer with acknowledgments only.  The client
    // will follow up with "done" and then we send shallow-info/packfile.
    parts.push(pkt("acknowledgments\n"));
    parts.push(pkt("NAK\n"));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const collected = collectObjects(store, req.wants, {
    depth: req.depth,
    oldShallow: req.shallow,
    relative: req.relative,
    haves: req.haves,
  });
  const pack = buildPack(store, collected.objects);
  if (collected.shallow.length > 0 || collected.unshallow.length > 0) {
    parts.push(pkt("shallow-info\n"));
    for (const sha of collected.shallow) parts.push(pkt("shallow " + sha + "\n"));
    for (const sha of collected.unshallow) parts.push(pkt("unshallow " + sha + "\n"));
    parts.push(DELIM);
  }
  parts.push(pkt("packfile\n"));
  // In protocol v2 the packfile section is always multiplexed with
  // side-band-64k semantics, independently of the sideband-all option.
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

export function uploadPackV2(store: RepoStore, body: Buffer): GitHttpResult {
  const parsed = parsePktLines(body);
  const before: string[] = [];
  const args: string[] = [];
  let afterDelim = false;
  let command = "";
  for (const line of parsed.lines) {
    if (line.kind === "delim") {
      afterDelim = true;
      continue;
    }
    if (line.kind !== "data") continue;
    const text = lineText(line);
    if (!afterDelim) {
      before.push(text);
      if (text.startsWith("command=")) command = text.slice("command=".length);
    } else {
      args.push(text);
    }
  }
  if (command === "ls-refs") {
    return {
      status: 200,
      contentType: "application/x-git-upload-pack-result",
      body: lsRefs(store, args),
    };
  }
  if (command === "fetch") {
    const req = parseFetchArgs(args);
    return {
      status: 200,
      contentType: "application/x-git-upload-pack-result",
      body: packResponseV2(store, req),
    };
  }
  return {
    status: 200,
    contentType: "application/x-git-upload-pack-result",
    body: pktLines([]),
  };
}

export function uploadPackV0(store: RepoStore, body: Buffer): GitHttpResult {
  const parsed = parsePktLines(body, 0, false);
  const strings: string[] = [];
  for (const line of parsed.lines) {
    if (line.kind === "data") strings.push(lineText(line));
  }
  let sideband = false;
  let depth: number | undefined;
  let relative = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let done = false;
  let firstWant = true;
  for (const text of strings) {
    if (text.startsWith("want ")) {
      const rest = text.slice(5).trim();
      const parts = rest.split(/\s+/);
      wants.push(parts[0]);
      if (firstWant) {
        firstWant = false;
        if (parts.includes("side-band-64k") || parts.includes("side-band")) sideband = true;
        if (parts.includes("deepen-relative")) relative = true;
      }
    } else if (text.startsWith("shallow ")) {
      shallow.push(text.slice(8).trim());
    } else if (text.startsWith("have ")) {
      haves.push(text.slice(5).trim().split(/\s+/)[0]);
    } else if (text.startsWith("deepen ")) {
      depth = parseInt(text.slice(7).trim(), 10);
    } else if (text === "deepen-relative") {
      relative = true;
    } else if (text === "done") {
      done = true;
    }
  }
  const collected = collectObjects(store, wants, { depth, oldShallow: shallow, relative, haves });
  const pack = buildPack(store, collected.objects);
  const parts: Buffer[] = [];
  for (const sha of collected.shallow) parts.push(pkt("shallow " + sha + "\n"));
  for (const sha of collected.unshallow) parts.push(pkt("unshallow " + sha + "\n"));
  const hasDepthRequest = depth !== undefined && depth > 0;
  if (hasDepthRequest) parts.push(FLUSH);
  // Stateless RPC uses one request for the shallow update and a second one
  // carrying "done" for the pack. Do not append negotiation/pack bytes to the
  // shallow-update response or the client desynchronizes.
  if (!done) {
    if (!hasDepthRequest) parts.push(pkt("NAK\n"));
    return {
      status: 200,
      contentType: "application/x-git-upload-pack-result",
      body: Buffer.concat(parts),
    };
  }
  parts.push(pkt("NAK\n"));
  if (sideband) {
    parts.push(sidebandPack(pack));
  } else {
    parts.push(pack);
  }
  return {
    status: 200,
    contentType: "application/x-git-upload-pack-result",
    body: Buffer.concat(parts),
  };
}

function deltaSize(buf: Buffer, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  while (pos.i < buf.length) {
    const b = buf[pos.i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return result;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const pos = { i: 0 };
  const baseSize = deltaSize(delta, pos);
  const resultSize = deltaSize(delta, pos);
  if (baseSize !== base.length) throw new Error("delta base size mismatch");
  const out = Buffer.alloc(resultSize);
  let outPos = 0;
  while (pos.i < delta.length) {
    const cmd = delta[pos.i++];
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) offset |= delta[pos.i++];
      if (cmd & 0x02) offset |= delta[pos.i++] << 8;
      if (cmd & 0x04) offset |= delta[pos.i++] << 16;
      if (cmd & 0x08) offset |= delta[pos.i++] << 24;
      if (cmd & 0x10) size |= delta[pos.i++];
      if (cmd & 0x20) size |= delta[pos.i++] << 8;
      if (cmd & 0x40) size |= delta[pos.i++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, outPos, offset, offset + size);
      outPos += size;
    } else if (cmd !== 0) {
      delta.copy(out, outPos, pos.i, pos.i + cmd);
      pos.i += cmd;
      outPos += cmd;
    } else {
      throw new Error("invalid delta opcode");
    }
  }
  if (outPos !== resultSize) throw new Error("delta result size mismatch");
  return out;
}

interface PackEntry {
  offset: number;
  typeCode: number;
  baseOffset?: number;
  baseSha?: string;
  type?: string;
  body?: Buffer;
  delta?: Buffer;
  sha?: string;
}

function typeName(code: number): string | undefined {
  if (code === 1) return "commit";
  if (code === 2) return "tree";
  if (code === 3) return "blob";
  if (code === 4) return "tag";
  return undefined;
}

export function receivePack(store: RepoStore, body: Buffer): GitHttpResult {
  const parsed = parsePktLines(body);
  const commands: Array<{ oldSha: string; newSha: string; ref: string }> = [];
  let caps = "";
  for (const line of parsed.lines) {
    if (line.kind !== "data") continue;
    let text = lineText(line);
    const nul = text.indexOf("\0");
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length >= 3 && /^[0-9a-f]{40}$/i.test(parts[0]) && /^[0-9a-f]{40}$/i.test(parts[1])) {
      commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
    }
  }

  let unpackError = "";
  const packStart = parsed.end;
  if (packStart < body.length && body.subarray(packStart, packStart + 4).toString("ascii") === "PACK") {
    try {
      storePack(store, body.subarray(packStart));
    } catch (err: any) {
      unpackError = err && err.message ? String(err.message) : "unpack failed";
    }
  }

  const results: Array<{ ok: boolean; ref: string; reason?: string }> = [];
  if (!unpackError) {
    for (const cmd of commands) {
      const current = store.getRef(cmd.ref);
      if (cmd.newSha === ZERO_SHA) {
        if ((current ?? ZERO_SHA) !== cmd.oldSha) {
          results.push({ ok: false, ref: cmd.ref, reason: "stale info" });
        } else {
          store.deleteRef(cmd.ref);
          results.push({ ok: true, ref: cmd.ref });
        }
        continue;
      }

      if (cmd.oldSha !== ZERO_SHA) {
        if (current !== cmd.oldSha) {
          results.push({ ok: false, ref: cmd.ref, reason: "stale info" });
          continue;
        }
        if (cmd.ref.startsWith("refs/heads/")) {
          if (!isAncestor(store, cmd.oldSha, cmd.newSha)) {
            results.push({ ok: false, ref: cmd.ref, reason: "non-fast-forward" });
            continue;
          }
        }
      } else if (current !== undefined) {
        results.push({ ok: false, ref: cmd.ref, reason: "stale info" });
        continue;
      }

      if (!store.hasObject(cmd.newSha)) {
        results.push({ ok: false, ref: cmd.ref, reason: "missing necessary objects" });
        continue;
      }

      store.setRef(cmd.ref, cmd.newSha);
      if (!store.refs.has(store.headRef)) store.headRef = cmd.ref;
      results.push({ ok: true, ref: cmd.ref });
    }
  }

  const sideband = /\bside-band-64k\b/.test(caps) || /\bside-band\b/.test(caps);
  const inner: Buffer[] = [];
  inner.push(pkt("unpack " + (unpackError || "ok") + "\n"));
  if (!unpackError) {
    for (const r of results) {
      inner.push(pkt((r.ok ? "ok " : "ng ") + r.ref + (r.ok ? "" : " " + (r.reason ?? "failed")) + "\n"));
    }
  }
  inner.push(FLUSH);
  const report = Buffer.concat(inner);

  let bodyOut: Buffer;
  if (sideband) {
    const outer: Buffer[] = [];
    const chunkSize = 65000;
    for (let i = 0; i < report.length; i += chunkSize) {
      outer.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + chunkSize)])));
    }
    outer.push(FLUSH);
    bodyOut = Buffer.concat(outer);
  } else {
    bodyOut = report;
  }

  return {
    status: 200,
    contentType: "application/x-git-receive-pack-result",
    body: bodyOut,
  };
}

function storePack(store: RepoStore, pack: Buffer): void {
  if (pack.length < 12 || pack.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("invalid pack header");
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error("unsupported pack version");
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let pos = 12;

  for (let i = 0; i < count; i++) {
    const start = pos;
    let c = pack[pos++];
    const typeCode = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) {
      c = pack[pos++];
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { offset: start, typeCode };
    if (typeCode === 6) {
      let oc = pack[pos++];
      let offset = oc & 0x7f;
      while (oc & 0x80) {
        oc = pack[pos++];
        offset = ((offset + 1) << 7) | (oc & 0x7f);
      }
      entry.baseOffset = start - offset;
    } else if (typeCode === 7) {
      entry.baseSha = pack.subarray(pos, pos + 20).toString("hex");
      pos += 20;
    }
    const inflated = inflateOne(pack.subarray(pos));
    pos += inflated.consumed;
    const tn = typeName(typeCode);
    if (tn) {
      entry.type = tn;
      entry.body = inflated.data;
      entry.sha = hashObject(tn, entry.body);
    } else {
      entry.delta = inflated.data;
    }
    entries.push(entry);
    byOffset.set(start, entry);
    if (size < 0) throw new Error("invalid pack object size");
  }

  const resolvedBySha = new Map<string, PackEntry>();
  for (const e of entries) {
    if (e.sha) resolvedBySha.set(e.sha, e);
  }

  const resolve = (entry: PackEntry, stack: Set<PackEntry>): PackEntry | undefined => {
    if (entry.body) return entry;
    if (stack.has(entry)) throw new Error("delta cycle in pack");
    stack.add(entry);
    let base: PackEntry | undefined;
    if (entry.typeCode === 6) {
      base = byOffset.get(entry.baseOffset!);
    } else if (entry.typeCode === 7) {
      base = resolvedBySha.get(entry.baseSha!);
      if (!base) {
        const obj = store.getObject(entry.baseSha!);
        if (obj) {
          base = {
            offset: -1,
            typeCode: 0,
            type: obj.type,
            body: obj.body,
            sha: entry.baseSha,
          };
        }
      }
    }
    // A ref-delta may point at an object that appears later in the pack.
    // Returning undefined lets the outer loop retry after other entries have
    // been resolved; cycle/base-body errors are still fatal.
    if (!base) {
      stack.delete(entry);
      return undefined;
    }
    const resolvedBase = resolve(base, stack);
    if (!resolvedBase) {
      stack.delete(entry);
      return undefined;
    }
    if (!resolvedBase.body || !resolvedBase.type) throw new Error("missing delta base body");
    if (!entry.delta) throw new Error("missing delta data");
    entry.body = applyDelta(resolvedBase.body, entry.delta);
    entry.type = resolvedBase.type;
    entry.sha = hashObject(entry.type, entry.body);
    resolvedBySha.set(entry.sha, entry);
    stack.delete(entry);
    return entry;
  };

  const unresolved = new Set<PackEntry>(entries);
  let progress = true;
  while (unresolved.size > 0 && progress) {
    progress = false;
    for (const entry of entries) {
      if (!unresolved.has(entry)) continue;
      const resolved = resolve(entry, new Set());
      if (resolved && resolved.type && resolved.body) {
        store.putObject(resolved.type, resolved.body);
        unresolved.delete(entry);
        progress = true;
      }
    }
  }
  if (unresolved.size > 0) throw new Error("missing delta base");
}

export function isAncestor(store: RepoStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = store.getCommit(sha);
    if (!commit) continue;
    for (const p of commit.parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}
