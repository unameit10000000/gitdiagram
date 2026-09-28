# Working Commands for gitdiagram

## Installation
```bash
# Original error: bun install failed with minimatch patch ENOTEMPTY error
# Fix: Remove conflicting overrides and patchedDependencies from package.json

# Then use npm to install (works on Windows)
npm install

# After npm install succeeds, bun install also works
bun install
```

## Development
```bash
# Run Next.js dev server with Turbo (Windows-compatible)
bun run --bun next dev --turbo

# The package.json "dev" script uses a bash script that doesn't work on Windows:
# "dev": "./scripts/dev-turbo.sh"
```

## Notes
- The `prepare` script in package.json fails on Windows due to shell redirection syntax (`>/dev/null 2>&1`)
- This is just a git hooks setup issue, doesn't affect the application
- Node.js version should be 22.x (current: v24.11.1 - some engine warnings but works)

## Local diagram generation (no accounts required)

Redis (Upstash) and R2 (Cloudflare) are no longer hard requirements for generating
diagrams locally:

- When `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are **unset**, the server
  uses an in-memory Redis fallback (`src/server/storage/memory-redis.ts`). Cancellation,
  rate limiting, locks, quota, and session state all work within the server process.
  State resets when the server restarts.
- R2 is only needed to **cache** diagrams. Without `R2_*` env vars, diagrams still
  stream to the browser successfully but aren't persisted (a warning is returned).

To generate diagrams locally you still need an AI provider key in `.env`:
- `OPENAI_API_KEY` (default provider), or
- `OPENROUTER_API_KEY` with `AI_PROVIDER=openrouter`

Private repositories: set `GITHUB_PAT` (or `GITHUB_PATS`) in `.env`. The server uses
it to read the private repo. The diagram streams to your browser but is not cached
unless you connect your own token in the UI.

Verified working flow (server log after the fallback engages):
```
{"event":"storage.upstash.in_memory_fallback", ...}
{"event":"generate.stream.started", ...}
{"event":"generate.stream.finished", ..., "outcome":"failed", ...}  # only if no AI key
```
The old `generate.cancellation.registration_failed` 503 is gone.

## Tests
```bash
# Run the in-memory Redis store + Lua EVAL tests
bunx vitest run src/server/storage/memory-redis.test.ts

# Typecheck and lint the storage layer
node_modules/typescript-7/bin/tsc --noEmit
bunx eslint src/server/storage/memory-redis.ts src/server/storage/upstash.ts --max-warnings 0
```
Note: `*.redis.test.ts` files require a real local Redis server, and the explainer
tests require the `ffmpeg-static` binary; both are pre-existing environment
dependencies, not related to the local fallback.