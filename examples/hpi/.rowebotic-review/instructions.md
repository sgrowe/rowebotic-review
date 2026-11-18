This is the Humaans monorepo.

## Reporting findings

Weigh how likely users are to encounter an issue against the severity of its consequences. Skip low-impact issues that require an unusual sequence, but keep rare failures when the consequences are serious, such as data loss, unauthorized access, or incorrect execution of a workflow.

## Guidance files

- For each file you review, read every `AGENTS.md` in the directories between the repo root and that file. Skip the root `AGENTS.md`. For Athena paths (`app/athena-*`, `packages/athena-shared`), also read `ATHENA.md` at the repo root.
- Read guidance files with `jj_file_show` at `to`, so a guidance file that the diff changes is read as changed.

## The psql functions

- The psql functions show the schema of the local Humaans DB. Use them when your concern asks, or when a specific schema fact would confirm or rule out a finding, such as "does `timeAway` have an index on (`companyId`, `startDate`)?".
- Call `psql_describe` directly with the bare table name (`requests`, not `public."requests"`). The table name is in the SQL or Knex code, or in the `name` option of the service's `.service.ts`. Call `psql_list_tables` only if the name is not found or your concern asks you to find views.
- Enum-like columns are usually `varchar` with a CHECK constraint, which `psql_describe` shows. `psql_list_enums` lists only native Postgres enums.
- The DB is normally migrated to `trunk()`. It normally has none of the PR's own migrations: read those in the diff. It has no Athena tables.
- If the DB differs from `from`, the difference is trunk migrations after `from`. Check them with `jj_diff_range` from `from` to `trunk()` under `app/server/migrations/`, and judge the PR against trunk, which is what it merges into.
- The DB holds schema only, with no production data. Don't infer table sizes or lock times from it.
