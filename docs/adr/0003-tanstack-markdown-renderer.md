# ADR-0003: @tanstack/markdown as the markdown viewer's renderer

Date: 2026-08-01
Status: accepted

## Context

The markdown viewer (`src/markdownViewer.ts`, `Cmd+M`) needs a markdown → HTML
renderer. The prototype used `@tanstack/markdown` (v0.0.12 — pre-1.0, published
weeks before this decision), raising a maturity concern before building the
full feature (relative images, live reload, syntax highlighting,
session-aware open) on top of it.

Verified facts at decision time:

- GFM tables, task lists, and strikethrough render correctly (tested
  directly). The real gaps are setext headings and bare-URL autolinking —
  effectively unused in agent-written plans and repo docs.
- Deterministic output, zero runtime deps, safe defaults (raw HTML off,
  executable URLs stripped) — good properties for rendering agent-generated
  content.
- Ships a documented syntax-highlighting adapter path.

## Decision

Keep `@tanstack/markdown`, **pinned to an exact version** (no `^` range), so
a 0.0.x breaking change cannot land silently via a lockfile refresh. Upgrades
are deliberate.

All rendering stays behind a single call site in `markdownViewer.ts` so the
renderer can be swapped (e.g. for `marked`) without touching the rest of the
viewer.

## Consequences

- Pre-1.0 API churn is contained to one module and one pinned version.
- Setext headings and bare URLs won't render as headings/links — accepted.
- If the package stagnates, swapping is an isolated, small change.
