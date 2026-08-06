# ADR-0005: Shiki for markdown viewer code blocks

Date: 2026-08-01
Status: accepted

## Context

The markdown viewer rendered code blocks as plain `<pre>`. The repo already
uses Shiki for review-diff highlighting (`review.ts`), with the theme system
mapping CC-GUI themes to Shiki themes. The alternative was TanStack
Markdown's own highlight adapter — render-time integration, but a second
package from the same pre-1.0 ecosystem (see ADR-0003) and no wiring to our
theme system.

## Decision

Highlight the viewer's code blocks with **Shiki**, post-processing the
rendered document's `<pre><code class="language-x">` blocks, reusing the
existing theme→Shiki mapping from the review view.

## Consequences

- Code blocks match the review view and follow theme switches for free.
- No new dependency; TanStack exposure stays at one pinned package.
- Post-processing the DOM is less elegant than a render-time adapter, but it
  is one contained function and keeps the renderer swappable (ADR-0003).
