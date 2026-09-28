# IDEAS

## Feature: Target a specific branch

**Status:** idea (not implemented)

### Requested behavior
Let the user diagram a specific branch instead of always the repo's default
branch, e.g. `https://gitdiagram.com/owner/repo?branch=feat/foo`.

### Current behavior
GitDiagram always analyzes the repo's default branch. `getRepoMetadata`
(`src/server/generate/github.ts`) reads `default_branch` and the file tree /
README are fetched at that branch. Branch appears only in the diagram's GitHub
link URLs, never as an input.

### Proposed change (summary)
- **URL/UI:** read `?branch=` as a query param on the repo page, validate it,
  pass it down through `RepoPageClient` → `useDiagram` →
  `streamDiagramGeneration` (add to the POST body and `getDiagramState`).
- **Schema:** add optional `branch` to `generateRequestSchema`
  (`src/server/generate/types.ts`) with a strict GitHub branch-name regex (no
  `..`, `.lock`, control chars, spaces, `~^:?*[\]`, leading/trailing `/` or `.`)
  and a length cap.
- **GitHub fetch:** add `branch?: string` to `getGithubData`/`fetchGithubData`;
  resolve `branch ?? defaultBranch ?? "main"` and use it for the tree and README
  (both already `encodeURIComponent` the ref).
- **Generate route:** pass `branch` into `getGithubData`; feed the resolved
  branch to the graph link URLs (`graph.ts` already accepts a `branch` arg).
- **Storage keying:** append the branch to artifact cache keys
  (`cache-key.ts` / `artifact-store.ts` / `diagram-state.ts`) and repo-page
  cache tags so branches don't overwrite each other.
- **Tests:** schema validation, tree-URL branch encoding, route threading.

### Notes / constraints
- Prefer a query param over a third path segment so the proxy's lowercase
  URL-normalization regex (`src/proxy.ts`) doesn't need to change.
- Branch input must be validated strictly — it is interpolated into GitHub
  tree/raw URLs (though already `encodeURIComponent`-escaped).
- Storage collision: without branch-aware keys, diagrams for different branches
  of the same repo would overwrite each other.
