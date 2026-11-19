// Minimal ambient declarations for the Node.js API surface used by this
// project.  The runtime is Node 22; this file only exists so `tsc` can check
// the source without pulling in @types/node (the project has no dependencies).

declare type Buffer = any;
declare const Buffer: any;

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
  stdout: { write(data: string): void };
  stderr: { write(data: string): void };
};

declare const console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
};

declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearTimeout(handle: any): void;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string);
  decode(input?: any): string;
}

declare class URL {
  constructor(input: string, base?: string);
  pathname: string;
  search: string;
  searchParams: URLSearchParams;
  host: string;
  protocol: string;
  toString(): string;
}
declare class URLSearchParams {
  constructor(init?: string | Record<string, string>);
  get(name: string): string | null;
  getAll(name: string): string[];
  set(name: string, value: string): void;
  has(name: string): boolean;
  toString(): string;
}

declare function fetch(input: string, init?: any): Promise<any>;

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    httpVersion?: string;
    socket: any;
    on(event: string, listener: (...args: any[]) => void): this;
    [key: string]: any;
  }
  export interface ServerResponse {
    statusCode: number;
    headersSent: boolean;
    setHeader(name: string, value: any): void;
    getHeader(name: string): any;
    removeHeader(name: string): void;
    writeHead(statusCode: number, headers?: any): this;
    write(chunk: any, cb?: () => void): boolean;
    end(chunk?: any, cb?: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    [key: string]: any;
  }
  export interface Server {
    listen(port: number, host?: string, cb?: () => void): this;
    listen(options: any, cb?: () => void): this;
    address(): any;
    close(cb?: (err?: any) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    [key: string]: any;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => any): Server;
  const http: { createServer: typeof createServer };
  export default http;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: any, inputEncoding?: string): Hash;
    digest(): Buffer;
    digest(encoding: "hex" | "base64"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function timingSafeEqual(a: any, b: any): boolean;
  const crypto: {
    createHash: typeof createHash;
    randomBytes: typeof randomBytes;
    randomUUID: typeof randomUUID;
    timingSafeEqual: typeof timingSafeEqual;
  };
  export default crypto;
}

declare module "node:zlib" {
  export function deflateSync(data: any, options?: any): Buffer;
  export function inflateSync(data: any, options?: any): Buffer;
  export function deflateRawSync(data: any, options?: any): Buffer;
  export function inflateRawSync(data: any, options?: any): Buffer;
  export function gzipSync(data: any, options?: any): Buffer;
  export function gunzipSync(data: any, options?: any): Buffer;
  const zlib: {
    deflateSync: typeof deflateSync;
    inflateSync: typeof inflateSync;
    deflateRawSync: typeof deflateRawSync;
    inflateRawSync: typeof inflateRawSync;
    gzipSync: typeof gzipSync;
    gunzipSync: typeof gunzipSync;
  };
  export default zlib;
}

declare module "node:buffer" {
  export const Buffer: any;
  export type Buffer = any;
}
