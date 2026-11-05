---
description: Review a diff for material slowdowns such as service calls in loops, unbatched writes, over-fetching, and sequential independent work.
when: the diff touches services, queries, loops over data, queues or client data fetching
---

# Performance

Find changes that make a hot path much slower. Ignore micro-optimisations.

## Look for

- Service calls or queries inside a loop (N+1) where one call could fetch everything.
- Repeated writes that one batched write could replace (e.g. `.multiCreate` or `.multiPatch`). First confirm that the service enables `multi` in its service options.
- New filters, joins or sorts on Humaans tables with no supporting index. Check the table's indexes with `psql_describe`. Don't guess at query plans.
- Over-fetching: whole records where a narrow `$select` would do, or large results that are only counted or filtered in memory.
- Independent work run one after another. Never suggest running writes in parallel unless you have shown that order and transactions stay safe. In Athena, use `promiseAllSettledAndFulfilled`, not `Promise.all`.
- Client requests for data that is already in core data or Zero.

## Leave to others

Logic errors (bugs), permission gaps (security), and style.
