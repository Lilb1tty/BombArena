# Domain Docs

How engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root, if it exists.
- `docs/adr/` ADRs that touch the area being changed, if they exist.

If these files do not exist, proceed silently. The domain-modeling workflow creates them when terms or decisions are actually resolved.

## File structure

This is a single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When naming a domain concept in an issue, proposal, hypothesis, or test, use the terms defined in `CONTEXT.md`. If a required concept is absent, flag it for domain modeling rather than casually inventing a synonym.

## Flag ADR conflicts

If a proposed change contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
