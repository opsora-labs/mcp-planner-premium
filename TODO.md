# TODO — mcp-planner-premium

Backlog for autonomous development. Claude works top-to-bottom, one item at a time.
Each item becomes a `feat/<slug>` branch, passes typecheck + unit tests, and is
merged via PR before moving to the next item. Check off items as branches merge.

---

## Read tools

- [ ] `list_plan_tasks`: add `remainingEffortHours`, `durationHours`, `actualStart`, `actualFinish` with try-with-fallback for tenants that don't expose them (Project Operations only)
- [ ] `list_dependencies`: 404-fallback to empty + warning for tenants that don't expose `msdyn_projecttaskdependency`; investigate alternate query path

## Write tools

- [ ] `delete_tasks_batch`: auto-fetch and delete live `msdyn_projecttaskdependency` entries before deleting tasks (cascade), rather than requiring the caller to track and remove them first
- [ ] `update_tasks`: support `parent` field (`msdyn_parenttask`) — run e2e confirmation first to verify PSS accepts the field; add unit test
- [ ] `add_tasks` / `update_tasks`: support sprint assignment via `msdyn_projectsprint@odata.bind` (currently only reachable via raw `*_batch` escape hatches)
- [ ] Resource assignments: new tool or extension for creating/removing `msdyn_resourceassignment` records

## Infrastructure

- [ ] `describe_option_set` auto-detect: probe at startup to determine the correct `DATAVERSE_LINK_TYPE_STYLE` value instead of requiring a manual env var; cache the result
- [ ] Schema capability cache: cache the `get_task` extended-field probe result at startup so it doesn't retry the fallback path on every subsequent call for tenants that lack those fields
