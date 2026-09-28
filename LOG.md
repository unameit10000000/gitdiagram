# LOG — Everything done to get gitdiagram running locally on Windows

Goal: run gitdiagram locally, generate a diagram for a private repo
(`cogniframe-dev/pace`) with no external accounts (no Upstash, no Cloudflare R2),
using OpenRouter + a GitHub PAT.

Machine: Windows 10 (PowerShell), `C:\dev\gitdiagram`.

---

## 1. Fix `bun install` (minimatch patch ENOTEMPTY error)

`bun install` failed on Windows:

```
error: renaming changes to cache dir: ENOTEMPTY: minimatch@3.1.5@@@1_patch_hash=...
error: failed to apply patchfile (patches/minimatch@3.1.5.patch)
```

Changes in `package.json`:
- Removed `patchedDependencies` (`minimatch@3.1.5` patch) — Bun couldn't apply
  patches on Windows.
- Removed overrides that conflicted with direct dependencies (`npm` `EOVERRIDE`):
  `dompurify`, `eslint`, `postcss` (all were listed in both `dependencies` /
  `devDependencies` and `overrides`).
- Fixed a JSON syntax error left behind (missing comma after `patchedDependencies`).

Result: `npm install` works, then `bun install` also works. The `prepare` script
fails on Windows (`git rev-parse ... >/dev/null 2>&1` redirection), which is a
harmless git-hooks setup issue.

## 2. Run the dev server on Windows

The `dev` script (`./scripts/dev-turbo.sh`) is a bash script. On Windows run:

```
bun run --bun next dev --turbo
```

## 3. Private repo generation was 503-blocked by Redis (Upstash)

Generating `cogniframe-dev/pace` failed with `503`:

```
generate.cancellation.registration_failed  ...  Cancellation registration is temporarily unavailable.
diagram_state.read_failed                  ...  Diagram state is temporarily unavailable.
generate.infrastructure_rate_limit.unavailable
repo_page.stored_state_failed              ...  Missing R2_PUBLIC_BUCKET.
```

Diagnosis:
- The frontend always sends `session_id` + `cancel_token`; the server registers
  the session in Redis (Upstash) before starting, and that call throws when
  `UPSTASH_REDIS_REST_URL`/`TOKEN` are missing → hard `503` on `/api/generate/stream`.
- Rate limiting soft-fails (allows the request) but cancellation registration is
  a hard fail.
- R2 is only needed to *cache* diagrams. Persistence failures are caught and
  non-fatal — the diagram still streams. R2 was a red herring for generation.

Decision: no accounts/services. Add an in-memory Redis fallback for local dev.

### New file: `src/server/storage/memory-redis.ts`

A self-contained in-memory Redis plus a mini Lua interpreter for `EVAL` scripts,
used when Upstash env vars are absent.

- Commands implemented: `GET SET DEL INCR DECR EXPIRE PEXPIRE TTL EXISTS MGET`,
  `HSET HGET HGETALL HDEL HEXISTS HVALS`, `ZADD ZREM ZCARD ZRANGEBYSCORE
  ZREMRANGEBYSCORE`, `RPUSH LRANGE LTRIM` (strings, hashes, sorted sets, lists,
  TTLs, lazy expiry).
- Mini Lua interpreter (tokenizer → recursive-descent parser → evaluator) that
  supports exactly the Lua subset the app's scripts use: `local`, assignment,
  `if/elseif/else`, numeric `for`, `for .. in ipairs()`, `return` (incl. table
  literals), `redis.call`, `tonumber`/`tostring`, `math.max/min`,
  `string.find/sub/match`, `unpack`, `#length`, `and/or/not`, comparisons,
  arithmetic, string concat `..`.
- State is kept on `globalThis` so it survives Next.js hot reloads, and resets on
  server restart (documented behavior, fine for dev).
- Exports `memoryRedisCommand`, `memoryRedisEval`, `resetMemoryRedisForTests`.

### Edited: `src/server/storage/upstash.ts`

- `upstashCommand` / `upstashEval` now detect whether
  `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are configured. If not,
  they log once (`storage.upstash.in_memory_fallback`) and route to
  `memoryRedisCommand` / `memoryRedisEval`. The real Upstash HTTP path is
  unchanged when env vars are set.

### New file: `src/server/storage/memory-redis.test.ts`

10 tests: store commands, TTL/NX/INCR semantics, hash/zset/list commands, and
the exact EVAL scripts (generation registration/cancel, rate limit, sponsor
claim dedupe, pending-browse upsert with `string.find`/`string.sub`, controls
script with `unpack`, distributed-lock release, `ipairs` refund).

Verified live: with no Upstash env vars, `POST /api/generate/stream` returned
`200` instead of `503`; the flow passed admission, fetched GitHub, and only
failed later at the AI-provider step (missing key at the time).

## 4. AI provider / model

Env vars in `.env` (repo root `C:\dev\gitdiagram\.env`):
```
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=<set>
OPENROUTER_MODEL=deepseek/deepseek-v4-flash-0731
OPENROUTER_SITE_URL=http://localhost:3000
GITHUB_PAT=<classic PAT with repo scope>
```
Notes:
- The provider is chosen by `AI_PROVIDER` alone — `OPENROUTER_API_KEY` being set
  does not switch providers (`src/server/generate/model-config.ts`).
- Any model must have a pricing row or the generate request is rejected with
  `ModelPricingUnavailableError` before streaming.

### Edited: `src/server/generate/pricing.ts`

Added a pricing row and resolver entry for the configured model:
```ts
"deepseek-v4-flash-0731": { inputPerMillionUsd: 0.14, outputPerMillionUsd: 0.28 },
```
and in `resolvePricingModel`:
```ts
if (withoutDate.startsWith("deepseek-v4-flash")) return "deepseek-v4-flash-0731";
```
(The USD figures are placeholders for the real OpenRouter rates; only affect the
displayed cost estimate.)

## 5. GitHub PAT / private repo access

### 5a. First PAT returned 404 (`REPOSITORY_NOT_FOUND`)

The token in `.env` was a classic PAT whose `x-oauth-scopes` header was:
```
public_repo, repo:invite, repo:status, repo_deployment, security_events
```
The parent **`repo`** scope was missing, so GitHub returns 404 on every private
repo even for an org owner. Classic PAT scopes are frozen at creation and cannot
be edited — a new token must be created with the top-level `repo` checkbox
(full control of private repositories). Verified with:
```
GET /user/repos?visibility=private   → []
GET /repos/cogniframe-dev/pace       → 404
GET /user                            → 200 (token valid, owner unameit10000000)
```

### 5b. New PAT: `GITHUB_AUTH_REQUIRED` policy

With a `repo`-scoped PAT, metadata now succeeded (private repo detected) but the
app rejected the request:

```
A GitHub token is required to analyze a private repository.
```

Root cause: the app deliberately refuses to let the **server's** GitHub
credentials authorize an anonymous caller — only a token supplied by the
*caller* (browser credential dialog) counts. This is a hosted-site security
policy that is wrong for a single-user self-hosted/local setup.

### Change: server credentials may authorize private access in dev/self-host

Edited `src/server/github-auth.ts` — new export:
```ts
export function serverCredentialsAuthorizePrivateAccess(): boolean {
  const optedIn =
    readTrimmedEnv("GITHUB_SERVER_AUTHORIZES_PRIVATE_ACCESS") === "true" ||
    process.env.NODE_ENV === "development";
  if (!optedIn) return false;
  return hasGitHubAppAuth() || readGitHubPatPool().length > 0;
}
```
- Auto-allowed in `development` when the server has GitHub credentials
  (`GITHUB_PAT`/`GITHUB_PATS`/GitHub App).
- For production self-hosting, opt in explicitly with
  `GITHUB_SERVER_AUTHORIZES_PRIVATE_ACCESS=true`.

Applied the relaxed check in the two enforcement points:
- `src/server/generate/github.ts` (private metadata/tree/readme gate)
- `src/server/generate/source-context.ts` (private source-blob reads)

Updated the mocked `github-auth` module in the two test files to export the new
function (returning `false`, preserving the "rejects private reads without
caller auth" behavior in tests).

## 6. Remaining local limitations (by design, not errors)

- **No R2 configured** → diagrams are generated and streamed to the browser but
  not cached. `Missing R2_PUBLIC_BUCKET` and `diagram_state.read_failed` (503)
  log entries are cosmetic (no saved state to show). Add a Cloudflare R2 bucket
  only if you want caching.
- **No Upstash configured** → in-memory Redis fallback. Rate-limit / cancellation
  / session state live in the server process and reset on restart.
- Tests requiring a real Redis (`*.redis.test.ts`) or real `ffmpeg` binary
  (explainer tests) are environment-dependent and were already failing before
  these changes.

## Files changed

| File | Change |
|---|---|
| `package.json` | removed minimatch patch + conflicting overrides |
| `src/server/storage/memory-redis.ts` | new: in-memory Redis + Lua EVAL interpreter |
| `src/server/storage/memory-redis.test.ts` | new: store + EVAL tests |
| `src/server/storage/upstash.ts` | memory fallback when Upstash env missing |
| `src/server/generate/pricing.ts` | pricing row + resolver for deepseek-v4-flash-0731 |
| `src/server/github-auth.ts` | `serverCredentialsAuthorizePrivateAccess()` |
| `src/server/generate/github.ts` | relaxed private-repo policy in dev/self-host |
| `src/server/generate/source-context.ts` | same, for source reads |
| `src/server/generate/github.test.ts` | mock updated |
| `src/server/generate/source-context.test.ts` | mock updated |
| `COMMANDS.md` | command cheatsheet |
| `.env` (untracked) | `AI_PROVIDER`, `OPENROUTER_*`, `GITHUB_PAT` |

## Commands that work

```
npm install                 # Windows-safe install
bun run --bun next dev --turbo
bunx vitest run src/server/storage/memory-redis.test.ts
node_modules/typescript-7/bin/tsc --noEmit
```
