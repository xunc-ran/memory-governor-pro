# Self-improvement skill bundled in memory-lancedb-pro

This directory is the **canonical in-repo copy** of the self-improvement workflow (SKILL, hooks, shell scripts, asset templates). It ships with the `memory-lancedb-pro` OpenClaw plugin under:

`memory-lancedb-pro/bundled/self-improvement/`

## Runtime (plugin)

With `memory-lancedb-pro` enabled, you get:

- LanceDB-backed reminder text merged into `before_prompt_build` (with recall/reflection dedupe)
- `.learnings/*` initialization from these `assets/` templates when applicable
- Tools: `self_improvement_log`, and with management tools enabled: review / extract-skill
- Hooks: `agent:bootstrap` (learning files), `command:new` / `command:reset` checklist notes

You **do not** need a separate OpenClaw hook that injects virtual `SELF_IMPROVEMENT_REMINDER.md` unless you run **without** this plugin.

## Optional: install as a workspace skill

To use `scripts/*.sh` or SKILL instructions from the default skills path:

```bash
# From your OpenClaw workspace, symlink or copy this folder, e.g.:
ln -s /path/to/memory-lancedb-pro/bundled/self-improvement ~/.openclaw/skills/self-improvement
# Windows (PowerShell, as admin if needed):
# New-Item -ItemType Junction -Path "$env:USERPROFILE\.openclaw\skills\self-improvement" -Target "C:\path\to\memory-lancedb-pro\bundled\self-improvement"
```

OpenClaw hooks under `hooks/openclaw/` remain available for **standalone** setups; copy that directory to `~/.openclaw/hooks/self-improvement` per `references/openclaw-integration.md`.

## Programmatic paths

The plugin resolves this folder via `src/self-improvement/bundled-resolve.ts` (`resolveBundledSelfImprovementRoot`). The governance CLI uses the same resolution from `src/lib/vendor.ts` for `vendor:init-self-improving`.
