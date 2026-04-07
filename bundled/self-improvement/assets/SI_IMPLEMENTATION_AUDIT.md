# Self-improvement — implementation audit (实现审计)

**Canonical rules** live in **LanceDB** (metadata `opencl_si_rule`, field `si_entry_id` like `LRN-…` / `ERR-…`).

This file is **append-only**: each line records when an entry was created or marked implemented / promoted. It is **not** the source of truth.

**Line format:** `ISO-8601 | EVENT | human_id | memory_id | kind | si_status | one_line_summary`

---
