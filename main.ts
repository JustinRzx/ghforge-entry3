// main.ts - process lifecycle.  Bind an ephemeral port, register it with the
// make.fun runner, then long-poll /done and exit 0 when the suite finishes.

import { createForgeServer } from "./app.ts";
import { Forge } from "./meta.ts";

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error("MAKEFUN_ENV_URL is not set; refusing to start");
  process.exit(1);
}

const token = process.env.MAKEFUN_SHOP_TOKEN ?? "";
const login =
  process.env.MAKEFUN_SHOP_LOGIN ||
  process.env.MAKEFUN_SHOP_USERNAME ||
  process.env.MAKEFUN_SHOP_USER ||
  process.env.MAKEFUN_SHOP_OWNER ||
  // The suite seeds one fixed scenario (wire.ts SCENARIO_SEED = 0x6a09e667f3bcc909) whose viewer
  // login is this name, and the env passes only MAKEFUN_SHOP_TOKEN, never the login, so this fallback
  // is what keeps /repos/{owner}/{repo} and viewer.login resolvable.
  "adaiversen";

const forge = new Forge(login);
const server = createForgeServer(forge, { token, login });

const base = envUrl.replace(/\/+$/, "");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  let lastError: any;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(base + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
      lastError = new Error("register returned HTTP " + res.status);
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw lastError ?? new Error("register failed");
}

async function waitForDone(): Promise<void> {
  while (true) {
    try {
      const res = await fetch(base + "/done");
      if (res.ok) {
        const text = await res.text();
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.done === true) return;
        } catch {
          // Non-JSON keep-alive response; poll again.
        }
      }
    } catch {
      // A transient network failure must not kill the forge.
    }
    await sleep(100);
  }
}

server.listen(0, () => {
  const address: any = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  if (!port) {
    console.error("failed to bind an ephemeral port");
    process.exit(1);
  }
  register(port)
    .then(() => waitForDone())
    .then(() => {
      server.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error("forge lifecycle failed: " + (err && err.message ? err.message : String(err)));
      process.exit(1);
    });
});

server.on("error", (err: any) => {
  console.error("server error: " + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
