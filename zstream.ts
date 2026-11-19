// zstream.ts - small wrappers around Node's zlib.  Packs are made of
// concatenated zlib streams, so `inflateOne` reports how many input bytes the
// stream consumed.  HTTP payloads are deflated at level 1 while they are
// small and at level 6 once they grow; that keeps the hot 1 KiB path cheap.

import { deflateSync, inflateSync, gzipSync } from "node:zlib";

export interface Inflated {
  data: Buffer;
  consumed: number;
}

export function inflateOne(input: Buffer): Inflated {
  const result: any = inflateSync(input, { info: true });
  // For inflate, engine.bytesWritten is the number of input bytes consumed.
  const consumed: number = result.engine && typeof result.engine.bytesWritten === "number"
    ? result.engine.bytesWritten
    : input.length;
  return { data: result.buffer, consumed };
}

export function deflate(data: Buffer, level = 6): Buffer {
  return deflateSync(data, { level });
}

export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}

export function gzip(data: Buffer, level = 6): Buffer {
  return gzipSync(data, { level });
}

export type HttpEncoding = "deflate" | "gzip" | "identity";

// Pick a content encoding only when the client explicitly asked for one.
// The caller writes Content-Encoding and Vary headers based on the result.
export function compressForHttp(
  data: Buffer,
  acceptEncoding: string | undefined,
): { body: Buffer; encoding: HttpEncoding } {
  if (!acceptEncoding || data.length < 256) {
    return { body: data, encoding: "identity" };
  }
  const accept = acceptEncoding.toLowerCase();
  const level = data.length < 4096 ? 1 : 6;
  if (accept.includes("deflate")) {
    return { body: deflate(data, level), encoding: "deflate" };
  }
  if (accept.includes("gzip")) {
    return { body: gzip(data, level), encoding: "gzip" };
  }
  return { body: data, encoding: "identity" };
}
