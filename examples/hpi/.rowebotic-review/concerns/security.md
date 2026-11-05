---
description: Review a diff for authorization gaps, cross-company access, PII and credential exposure, and new API, MCP or UI reachability.
when: the diff touches services, hooks, permissions, schemas, auth, MCP or UI permissions
---

# Security

Find changes that let a caller see or do something they should not.

For each changed policy, hook, schema or service option, state what new data or action it permits and to whom. Start with cross-company access, PII and credentials. Trace the real caller: authentication, service hooks, validation, policy, nested calls, then result cleaning.

For more depth on how a service is reached, read `.agents/skills/authorization-review/access-control.md`.

## Failure classes

Guards that do less than they seem to:

- `authorize()` does nothing without `params.user`. It needs `auth()` for external callers.
- `auth()` proves identity, not tenancy. A service with no policy and no `companyId` filter lets any logged-in user of any company through.
- Service `scope: 'internal'` only rejects API tokens and hides the service from the API docs and MCP. It does not block sessions or anonymous callers. `disallow('external')` blocks external callers.
- Code before `await next()` in an `around` hook runs before `auth()` and query validation.
- The schema keyword `internal: true` blocks the field in create and patch bodies. It does nothing on a query schema.
- `getCompanyId` can read `query.companyId` when there is no user.
- An early `return` in one branch can skip the permission check that the other branches run.
- `skipAuthorization: true` must only appear on internal calls that need to cross the caller's permissions.

Caller-controlled data:

- `generateId({ overwrite: false })` accepts the caller's primary key.
- A reference ID needs an existence check and a tenant check. The `foreignKey` schema keyword does both.
- A missing `additionalProperties: false` matters when a policy permits a field that the schema never validates.
- Dynamic URL path segments need `encodeURIComponent`. Credentials in URLs must be redacted in logs, for example with `redactUrlQuery`.

Transactions and nested calls:

- Result cleaning can fail after the transaction commits. Work that must follow the commit belongs in `afterTransaction`.
- Nested service calls must keep the caller and permissions through `params.forward()`.
- A guard helper with no call site protects nothing.

Reachability:

- New or changed services, methods and fields exposed through the public API or MCP. Check the service scope, `accessTokenScope`, the `mcp` and `mcpOnly` schema keywords, and `app/server/mcp/tools/`.
- PII in new response fields, logs, webhooks, AI tool results or error messages.
- UI actions without a `can()` gate from `usePermissions()`. A missing gate is a UX issue when the server also checks. It is a security issue only when the server does not.

## Before you propose a restriction

Find the legitimate callers first: browser, workers, API tokens, webhooks and MCP. Say which caller the fix would break, or why it breaks none.

## Leave to others

Logic errors (bugs), breakage in other code (dependents), speed (performance), and whether the tests prove the permission paths (tests).
