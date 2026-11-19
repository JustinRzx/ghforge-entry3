// app.ts - the router.  The path prefix is chosen before any body is parsed,
// so git traffic never enters the REST router.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleApi, nextRequestId, readBody, sendBody, sendJson, type Ctx } from "./api.ts";
import {
  receiveAdvertisement,
  receivePack,
  uploadAdvertisement,
  uploadPackV0,
  uploadPackV2,
  type GitHttpResult,
} from "./githttp.ts";
import { handleGraphql } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import type { Forge } from "./meta.ts";

export interface ServerOptions {
  token: string;
  login: string;
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function gitContentType(kind: string): string {
  return "application/x-git-" + kind;
}

function sendGit(ctx: Ctx, result: GitHttpResult): void {
  const headers: Record<string, string> = {
    "Content-Type": result.contentType,
    "Content-Length": String(result.body.length),
    "Cache-Control": "no-cache, max-age=0, must-revalidate",
    "X-GitHub-Request-Id": nextRequestId(),
    ...(result.headers ?? {}),
  };
  ctx.res.writeHead(result.status, headers);
  ctx.res.end(result.body);
}

function sendPlain(ctx: Ctx, status: number, message: string): void {
  const body = Buffer.from(message + "\n", "utf8");
  ctx.res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
    "X-GitHub-Request-Id": nextRequestId(),
  });
  ctx.res.end(body);
}

export function createForgeServer(forge: Forge, options: ServerOptions): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const rawUrl = req.url || "/";
      const q = rawUrl.indexOf("?");
      const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
      const url = new URL(rawUrl, "http://localhost");
      const method = (req.method || "GET").toUpperCase();
      const segments = pathname.split("/").filter((s) => s.length > 0);

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1].endsWith(".git")) {
        const owner = decodeSeg(segments[0]);
        const repoName = decodeSeg(segments[1].slice(0, -4));
        const sub = segments.slice(2).join("/");
        const repo = forge.getRepo(owner, repoName);
        if (!repo) {
          sendPlain(
            {
              req,
              res,
              method,
              path: pathname,
              url,
              body: Buffer.alloc(0),
              expectedToken: options.token,
              login: options.login,
              forge,
            },
            404,
            "Repository not found",
          );
          return;
        }
        const gitProtocol = req.headers["git-protocol"];
        const wantsV2 =
          typeof gitProtocol === "string" && /(^|,)\s*version=2\s*($|,)/i.test(gitProtocol);

        if (method === "GET" && sub === "info/refs") {
          const service = url.searchParams.get("service");
          const ctx: Ctx = {
            req,
            res,
            method,
            path: pathname,
            url,
            body: Buffer.alloc(0),
            expectedToken: options.token,
            login: options.login,
            forge,
          };
          if (service === "git-upload-pack") {
            const body = uploadAdvertisement(repo.store, wantsV2);
            sendGit(ctx, {
              status: 200,
              contentType: gitContentType("upload-pack-advertisement"),
              body,
            });
            return;
          }
          if (service === "git-receive-pack") {
            // receive-pack is v0 only.
            sendGit(ctx, {
              status: 200,
              contentType: gitContentType("receive-pack-advertisement"),
              body: receiveAdvertisement(repo.store),
            });
            return;
          }
          sendPlain(ctx, 400, "Unsupported service");
          return;
        }

        if (method === "POST" && sub === "git-upload-pack") {
          const body = await readBody(req);
          const ctx: Ctx = {
            req,
            res,
            method,
            path: pathname,
            url,
            body,
            expectedToken: options.token,
            login: options.login,
            forge,
          };
          const result = wantsV2 ? uploadPackV2(repo.store, body) : uploadPackV0(repo.store, body);
          sendGit(ctx, result);
          return;
        }

        if (method === "POST" && sub === "git-receive-pack") {
          const body = await readBody(req);
          const ctx: Ctx = {
            req,
            res,
            method,
            path: pathname,
            url,
            body,
            expectedToken: options.token,
            login: options.login,
            forge,
          };
          const result = receivePack(repo.store, body);
          // If the first pushed branch is not the repository's nominal
          // default (for example a client that still uses master), follow it
          // so REST/GraphQL content and pull operations use a real branch.
          const headRef = repo.store.headRef;
          if (headRef.startsWith("refs/heads/") && repo.store.refs.has(headRef)) {
            const branch = headRef.slice("refs/heads/".length);
            if (!repo.store.refs.has("refs/heads/" + repo.defaultBranch)) {
              repo.defaultBranch = branch;
            }
          }
          repo.updatedAt = new Date().toISOString();
          sendGit(ctx, result);
          return;
        }

        const ctx: Ctx = {
          req,
          res,
          method,
          path: pathname,
          url,
          body: Buffer.alloc(0),
          expectedToken: options.token,
          login: options.login,
          forge,
        };
        sendPlain(ctx, 404, "Not Found");
        return;
      }

      const makeCtx = (body: Buffer): Ctx => ({
        req,
        res,
        method,
        path: pathname,
        url,
        body,
        expectedToken: options.token,
        login: options.login,
        forge,
      });

      // Boot check: the env calls this twice before it dials anything else.
      if (pathname === "/healthz" || pathname === "/healthz/") {
        const body = Buffer.from('{"ok":true}', "utf8");
        sendBody(makeCtx(Buffer.alloc(0)), 200, body, "application/json");
        return;
      }

      if (pathname === "/api/graphql" || pathname === "/api/graphql/") {
        const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
        await handleGraphql(makeCtx(body));
        return;
      }

      if (pathname === "/mcp" || pathname === "/mcp/") {
        const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
        await handleMcp(makeCtx(body));
        return;
      }

      if (pathname === "/api/v3" || pathname === "/api/v3/" || pathname.startsWith("/api/v3/")) {
        const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
        await handleApi(makeCtx(body));
        return;
      }

      if (pathname === "/" || pathname === "") {
        const body = Buffer.from(JSON.stringify({ status: "ok" }), "utf8");
        sendBody(makeCtx(Buffer.alloc(0)), 200, body, "application/json; charset=utf-8");
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(makeCtx(Buffer.alloc(0)), 404, { message: "Not Found" });
        return;
      }
      sendPlain(makeCtx(Buffer.alloc(0)), 404, "Not Found");
    } catch (err: any) {
      try {
        if (!res.headersSent) {
          const body = Buffer.from(
            JSON.stringify({ message: err && err.message ? String(err.message) : "Internal Server Error" }),
            "utf8",
          );
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(body.length),
            "X-GitHub-Request-Id": nextRequestId(),
          });
          res.end(body);
        } else {
          res.end();
        }
      } catch {
        // The socket is already gone; nothing useful remains to do.
      }
    }
  });

  // Keep idle keep-alive connections alive long enough for the read workload.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0;

  return server;
}
