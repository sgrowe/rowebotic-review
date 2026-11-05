---
description: Review a diff's structure for encapsulation, single sources of truth, clear interfaces, type safety, brittleness, and needless complexity.
when: always
---

# Design

Find structural problems that will make the code harder to change safely. Prefer the simplest readable change, and patterns that the next maintainer can copy safely.

## Look for

- Implementation details that leak across modules, services or components.
- The same state or logic kept in more than one place, so the copies can drift apart.
- Unclear interfaces between components and services, or responsibilities mixed in one place.
- Weak types between distant code, such as `any`, casts, or stringly typed values where a shared type exists.
- Brittle code: it breaks on a likely future change, or depends on an order or shape that nothing enforces.
- Complexity that a simpler change would avoid. Search for an existing helper before accepting a new one.

Report only problems with a concrete cost. Say what will go wrong, and suggest the simpler shape.

## Leave to others

Bugs (bugs), security (security), breakage in other code (dependents), frontend details (frontend), speed (performance), and test structure (tests).
