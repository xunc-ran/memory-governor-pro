---
name: memory-governor-pro
description: TypeScript memory-governance skill with memory-lancedb-pro and bundled self-improvement (same repo).
---

# memory-governor-pro

This skill implements:

1. Daily 24:00 job for current agent only.
2. Threshold flush jobs at 50/70/85 context usage.
3. Same-day multi-session aggregation.
4. Direct LanceDB writes (no `memory/YYYY-MM-DD.md` persistence).
5. Strict session rotation:
   - delete only if a whole file belongs to date D
   - otherwise rewrite and remove only D messages.
6. Bootstrap backfill for historical sessions, with deletion allowed.
7. Self-improvement **rules** in the **main** MemoryStore (`opencl_si_rule`); workspace markdown only for `SI_IMPLEMENTATION_AUDIT.md` trail.
8. TOON-first injection block generation (JSON fallback).
9. Governance with agent-only-day exclusion from hit/degrade/retire calculations.
10. Default layout: OpenClaw plugin + governor CLI + bundled self-improvement in one tree; optional `upstream/memory-lancedb-pro` for forked layouts.
   - Self-improvement skill path: `bundled/self-improvement` (see `INTEGRATION.md` there)

## Important Safety Rules

- Single injector only: memory-lancedb autoRecall.
- This skill never performs per-turn direct injection.
- Session deletion runs only after successful ingestion and audit writes.
- Audit / rollback CLI: `audit-inspect`, `audit-restore-sessions`, `audit-clear-rotation`, `audit-purge-memories`; optional `preRefineSessionSnapshot` in `config.json` for merge-target restore.

