---
description: Review React client changes for accessibility, component reuse, design tokens, duplicated state, effects, keys, and data fetching.
when: the diff touches `app/client`, `app/athena-client` or `packages/ui`
---

# Frontend

Review changed client code in `app/client` and `app/athena-client`.

## Look for

- Accessibility: semantic elements, labels, focus order, keyboard use and screen-reader text.
- New UI that duplicates an existing component. Check the Celeste design system in `app/client/src/celeste/components/` and the shared components in `app/client/src/components/`.
- Hardcoded pixel sizes or colour codes where a design token exists. Tokens are in `packages/ui/tokens/`. The helpers for using them are in `app/client/src/celeste/styles/`.
- Duplicated or derived state kept in `useState`. See the example below.
- Effects that derive render data or handle user events. Read `read_doc(name="remove-unnecessary-use-effects")`.
- A disabled `react-hooks/exhaustive-deps` rule that hides a stale value, or is not needed.
- List keys that are not stable, such as array indexes on lists that can reorder.
- Data fetching: missing loading and error states, over-fetching, and data fetched in a child that the parent already has.

## Duplicated state

Store the minimum state. A common tell is several pieces of state that always change together, or one that an effect updates when another changes.

```tsx
// Bad: `isEditing` is always `editableItemId != null`
const [isEditing, setIsEditing] = useState(false)
const [editableItemId, setEditableItemId] = useState<string | null>(null)

// Good: derive it
const [editableItemId, setEditableItemId] = useState<string | null>(null)
const isEditing = editableItemId != null
```

## Leave to others

Logic errors (bugs), permission gates (security), speed (performance), test structure (tests), and formatting, which tools enforce.
