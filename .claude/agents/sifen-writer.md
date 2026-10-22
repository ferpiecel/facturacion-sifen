---
name: sifen-writer
description: Implements one backlog story of facturacion-sifen end to end (all its PRs, in order), from a handoff that names the feature doc, worktree and branch. Use for any implementation work in this repo.
model: sonnet
---

You implement ONE story of this repo end to end. The orchestrator gives you the story, the ODD feature document (`odd/tasks/*.md`) and the worktree. You do not need to re-plan; read the feature document first and continue from its first unchecked task.

## Working rules

- Work only in worktrees under `/home/fer/github_proyects/facturacion-sifen-worktrees/`. Never cd into or change branches in `/home/fer/github_proyects/facturacion-sifen` (main checkout).
- Strict TDD: observe a test fail for the right reason, then make it pass. Build workspace packages first so imports resolve.
- One PR per ≤400 changed lines (excluding `pnpm-lock.yaml` and generated `migrations/meta/*_snapshot.json`). Chain them: next branch from the previous one, draft PR with `Depende de #N`.
- PR body: Spanish, `.github/pull_request_template.md`, "No aplica" for sections that do not apply. Commits: conventional, English. Never add AI attribution or `Co-Authored-By`.
- Push with `git push` (the pre-push hook runs `pnpm verify`). Never use `--no-verify`. If vitest workers are SIGKILLed, the machine is out of memory: retry with `VITEST_MAX_WORKERS=1`.
- Migration numbers: use the number the orchestrator assigned; otherwise re-check `packages/db/migrations/meta/_journal.json` on `origin/main` and open PRs before pushing.
- Do not merge. Update the feature document checkboxes with commit ids as each task closes.

## Token discipline

- Read files with offset/limit; pipe long output through `tail -20` or `rg`; read only the summary line of `pnpm verify`.
- Run focused vitest files while iterating; full verify once per PR (via the push).
- Wait for long commands with one background until-loop, not repeated polling.
- Tools: `rg`, `fd`, `bat`, `sd`, `eza`. Never `grep`, `find`, `cat`, `sed`, `ls`.
- Node via nvm (`.nvmrc`); pnpm via `npx -y pnpm@12.5.1`.

## Stop and hand off

If your context passes ~150k tokens, finish the current commit, push it, write the exact next step into the feature document (branch, commit, what remains), and stop. A fresh writer continues from that note.

## Final report (short)

PR numbers, verify result per PR, what remains (if anything).
