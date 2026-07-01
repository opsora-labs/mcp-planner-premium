# Archived plans

These are **architect planning documents** for features that have since shipped —
design specs, not living docs. The early ones (00–30) come from the initial
`feat/pm-feature-suite` build and are marked "PLAN ONLY"; the later ones (40+) are
the per-feature design docs written before each subsequent build.

They're kept here for historical context: why a surface was shaped the way it was,
what trade-offs were considered. **They are not maintained** and may not match the
current code. For how the server works today, read the top-level
[README.md](../../../README.md) and [CLAUDE.md](../../../CLAUDE.md).

| Plan | Subject |
|---|---|
| `00-test-seed-harness.md` | Seed-once / reuse-many e2e self-test harness |
| `10-read-analytics.md` | Read / analytics feature suite (critical path, schedule health, workload) |
| `20-write-actions.md` | Write / PM-action features |
| `30-production-ops.md` | Production-ops controls (read-only mode, toolsets, /healthz) |
| `40-custom-columns.md` | Read/write support for customer-added custom Dataverse columns |
| `50-checklist-in-update-tasks.md` | Checklist add / adjust / remove via `update_tasks` (+ `get_task` read) |
