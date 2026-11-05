---
description: Review a diff for logic errors, unsafe migrations, queue and feature-flag mistakes, and changed behaviour without tests.
when: always
---

# Bugs

Find code in the diff that does the wrong thing.

## Look for

- Wrong conditions or variables, off-by-one errors, unhandled `null` or `undefined`, and missing `await`.
- Hooks that run in the wrong order, and work that runs outside the transaction it needs.
- Nested service calls that drop or wrongly pass on the caller's context: user, company or transaction.
- Schemas that reject valid input or accept invalid input. When a server schema or a shared enum it uses changes, check with `psql_describe` that the allowed values, `nullable` and `maxLength` still fit the column's type, NOT NULL and CHECK constraints.
- Migrations that fail on existing data, lock a large table for a long time, or cannot roll back. Check existing columns, constraints, enum values and triggers with the psql tools. Code that breaks while the old and new versions run side by side during a deploy.
- Queue jobs that are unsafe to retry or to run twice. Side effects such as emails, webhooks or external API calls that have no idempotency.
- Feature flags checked in some paths but not in others. Code that breaks for companies that have the flag off.
- Changed behaviour with no test. Name the missing test. For server tests, read `app/server/test/AGENTS.md` for how tests are written here.

## Leave to others

- Authorization and data exposure: security.
- Breakage in code outside the diff: dependents.
- UI and React: frontend.
- Speed: performance.
- Structure: design.
- Tests that exist but do not prove the change, including a missing denied path: tests.
