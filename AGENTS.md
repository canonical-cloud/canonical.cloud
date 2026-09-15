# Agent guidelines — canonical.cloud

> [!CAUTION]
> **Do not edit mirrored application copies in this umbrella checkout.**
> Work in each authoritative repository under `canonical-cloud/*`; this repo is
> an integration/umbrella surface and contains mirrors or pins used for stack
> assembly and validation.

This repository coordinates the **canonical.cloud** stack. In particular:

- `canonical-monorepo` owns the deployable release graph and release publishing.
- `canonical-web-server.rs` owns the customer Rust/HTMX/web runtime.
- `canonical-api-server.rs` owns the customer API runtime.
- `canonical-marketing-site.web` owns the Astro marketing application.
- `canonical-interfaces` owns typed cross-runtime contracts.
- `canonical-mcp-server.rs` provides read-only operational visibility.

Make source changes in the authoritative repository and then update reviewed
integration pins or mirrors here. Never treat a copied subtree as the authority.

## Read-only operations tooling

The Canonical MCP server is intentionally read-only. Its GitHub, Cloudflare,
Kubernetes, health, docs, domain, and related operational tools must not acquire
provider write capabilities merely for convenience. Never log or persist tokens,
credentials, private evidence payloads, or secret values.

## Command safety

Do not use destructive, history-rewriting, state-concealing, or policy-bypass
operations. In particular, do not use `git rebase`, `git stash`, destructive
`git reset`, `git clean`, force-pushes, `rm -rf`, destructive infrastructure or
data commands, or bypass flags such as `--no-verify` to make a check pass.

Prefer explicit additive commits, `git merge`/`git pull`, reviewed `git rm` or
`git mv`, reversible migrations, read-only inspection, and feature branches when
protected-branch policy requires them. Preserve unrelated work and resolve merge
conflicts semantically from both sides with surrounding history and contracts.

## Git worktrees

Create or use a worktree only when the human operator explicitly asks for one
for the current task. Put authorized worktrees under `tmp/worktrees/` and keep
that path ignored. Concurrency alone is not permission to create a worktree.

## Syncing with the remote

“Sync with the remote” is a two-way exchange: inspect/fetch the remote, merge
reviewed upstream changes without rebasing, and publish the resulting commits.
A clean local tree or a push alone is not proof that synchronization is complete.
Before integrating remote changes, preserve any intended local work in an
additive commit/branch rather than hiding or discarding it.

## Validation and release boundaries

Keep reusable validation read-only unless a narrowly scoped maintenance workflow
has a documented write boundary. Pin external GitHub Actions and reusable
workflows to immutable revisions, disable checkout credential persistence for
validation jobs, bound runner jobs with timeouts, and require exact-head stepful
CI evidence for promotion. A zero-step/admission-refused run is non-evidence.

`canonical-monorepo` remains the sole release publisher. Validation workflows in
this umbrella or application repositories must not silently become deployment or
package-publishing paths.
