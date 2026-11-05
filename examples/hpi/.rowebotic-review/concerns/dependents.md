---
description: Review code outside a diff that depends on the changed code, such as related services, delete guards, queue workers, MCP and AI tools, and package consumers.
when: the diff changes a service, schema, queue, MCP or AI tool, or a `packages/**` export
---

# Dependents

Find code outside the diff that breaks, or needs the same update, because of the change. Search for callers first, then decide if each one still works.

## Look for

- Services that read the changed service through service calls or raw SQL. Search for both. For example, `api/tasks` collects data from `api/workflow-tasks` and other services, so a change to `api/workflow-tasks` can break `api/tasks`.
- Deletes that leave dependent data broken. For example, a request type with requests must not be deleted, and custom fields used in other services' configuration must be protected from deletion or cleaned up with `removeRelated`.
- DB triggers, functions and views that use a changed table or column. `psql_describe` on the table shows its triggers and the foreign keys that reference it; read the trigger functions it names with `psql_function_source`. Find views by the ` (view)` suffix in `psql_list_tables`, then read them with `psql_describe` and `verbose: true`.
- Queue workers in `app/server/queues/` that call the changed service or read its data.
- MCP and AI tool definitions that describe or call the changed service and now need an update: `app/server/mcp/tools/`, `app/server/queues/companion/tools.ts` and `app/server/queues/workflowAi/tools/`.
- Consumers of changed exports under `packages/**`. Check compatibility, types that got wider or narrower, and callers that the diff did not update. Changes to package internals that keep the public contract are fine.

## Leave to others

Bugs inside the diff itself (bugs), permission gaps (security), style, and duplicated code (design).
