# ghforge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/JustinRzx/ghforge-entry3/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/JustinRzx/ghforge-entry3/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One Node 22 process, no dependencies, no git binary, no network: git smart HTTP (upload-pack v2,
receive-pack v0) for clone/fetch/push, the REST v3 API under /api/v3, GraphQL v4 at /api/graphql and
MCP at /mcp, all over one in-memory object store per repository.

Entry for make.fun's [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01), $500 in USDC.

## Run

```sh
node --experimental-strip-types main.ts
```

It binds an ephemeral port, POSTs it to $MAKEFUN_ENV_URL/register, and long-polls /done until the
trial ends. With MAKEFUN_ENV_URL unset it exits 1.

## License

MIT. See LICENSE.
