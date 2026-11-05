---
description: Review added or changed tests for inadequate proof, weak assertions, flakiness, isolation, and test conventions.
when: the diff adds or changes a test file, test helper, fixture, setup file or `.snap`
---

# Tests

Find tests in the diff that will fail for the wrong reason, pass for the wrong reason, or prove less than they claim.

## Scope

Review tests, test helpers, fixtures, setup and snapshots. Apply convention checks to newly introduced patterns; placement checks to new files only.

Use scoped test guidance, including `app/server/test/AGENTS.md` and `app/client/test/AGENTS.md` guidance for tests outside those directories. Follow relevant links in those instructions. E2E conventions live in `packages/e2e/AGENTS.md`.

## Look for

- Stubs and spies on our own services: test through the public API with real services and fixtures; follow scoped guidance for external-boundary and deliberate failure-injection exceptions.
- Inadequate proof: assertions only on setup or stub output; tests that would pass with the fix reverted; permission tests missing denied paths or meaningful positive controls.
- Weak assertions: unchecked errors, broad matches hiding important fields, and truthiness or snapshots where an exact assertion is short.
- Reliability: calendar-dependent expectations, queue or after-commit races, and shared state escaping test isolation. Check scoped guidance for the mechanisms and safe alternatives.
- Lost coverage or concealed flakiness: unexplained deletions, weakened assertions, skips, retries, raised timeouts, or serialization without a documented reason.
- Convention violations with a concrete cost: params, fixtures, placement, unrelated assertions, unclear titles, and generated cases. Use the package's rules and exceptions.

## Findings

CI only exposes flakiness when it happens, so report it despite the usual CI exclusion. Identify the mechanism and line; drop speculative "could be flaky" claims. Leave deterministic failures caught by CI to CI.

A test hiding a real bug or removal of security or tenancy coverage is `major`. Flaky or weak tests and substantive convention issues are `minor`.

## Leave to others

Changed behaviour with no test at all belongs to bugs; an existing test that fails to prove it belongs here. Production correctness, security, speed, structure and UI belong to their respective reviewers.
