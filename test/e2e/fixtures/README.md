# PM acceptance fixtures

`pmOpsLive.ts` (run via `npm run e2e:acceptance`) reads `it-planner-board.json` from this folder. That file is a
**real customer Planner export and is gitignored on purpose** (privacy) — it is
not committed. To run the PM acceptance test you provide your own fixture here
with the same shape.

## Fixture schema (`it-planner-board.json`)

```jsonc
{
  "source": "IT Planner Board.xlsx",
  "meta": { "Project name": "...", "Plan owner": "...", "...": "..." },
  "buckets": ["DevOps & Infrastructure", "SAP", "..."],   // distinct bucket names
  "taskCount": 642,
  "tasks": [
    {
      "taskNumber": 141,                 // unique int; referenced by dependsOn
      "outline": "9.3.5.1.1",            // dotted outline number → hierarchy depth
      "name": "…",                       // task subject
      "priority": 1,                     // int option value (Urgent=1/Important=3/Medium=5/Low=9)
      "progressPercent": 100,            // 0–100 or null
      "start": "2025-05-13T09:00:00",    // ISO or null
      "finish": "2025-09-29T17:00:00",   // ISO or null
      "bucket": "SAP",                   // bucket name or null (→ "(Unbucketed)")
      "effortHours": 80,                 // number or null
      "milestone": false,
      "notes": "…",                      // or null  → task description
      "parentTaskNumber": 140,           // null for a top-level task
      "dependsOn": [ { "onTaskNumber": 12, "type": "SS" } ]  // FS/SS/FF/SF
    }
  ]
}
```

The test derives everything else (levels, leaf/summary split, createable vs
summary-linked dependencies) from these fields. An Excel export can be converted
to this shape with a small openpyxl script (see the project history).

## Running

```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
DATAVERSE_LINK_TYPE_STYLE=eu E2E_TOOL_TIMEOUT_MS=290000 \
  npx tsx --env-file .env test/e2e/pmOpsLive.ts
```

Set `KEEP_PLAN=1` to keep the created plan even on a fully-green run. A failing
run keeps the plan automatically so it can be inspected/re-tested.
