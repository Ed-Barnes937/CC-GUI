# ADR-0008: Optional-feature registry (tier 0 of a plugin story)

Date: 2026-08-19
Status: accepted

## Context

Some GUI features are worth building but not worth switching on for
everyone — a workflow UI a subset of users will care about, say. Today the
only way to add one is another import at the top of `main.ts` and more
unconditional wiring inside it, which is why that file is now ~4,600 lines.

The obvious framing is "we need a plugin system". That framing conflates two
different problems:

- **A.** Not every user wants a given feature. This is a toggle problem.
- **B.** *Other people* want to ship features we don't want to maintain.
  This is a distribution, API-versioning and sandboxing problem.

CC-GUI has problem A now and does not have problem B yet: there is no
third-party author pool. Solving B first would mean designing an extension
API against hypothetical consumers, and — since the frontend is bundled by
Vite and the webview has the whole `invoke` surface, with `csp: null` —
loading third-party code from disk today would amount to arbitrary code
execution with commit rights over the user's repositories.

The GUI already has the seams a feature needs: `registerPaletteProvider`, the
string-keyed `KEY_ACTIONS` table behind `initKeybindings`, and a Settings pane
with a precedent (`Appearance`) for GUI-owned preferences held in localStorage
rather than the claude-commander config.

## Decision

Solve A only, by naming the seams that already exist as a contract. `Feature`
(in `src/features.ts`) declares an id, a name and description for Settings, a
default, and two optional contributions:

- `palette?: () => PaletteEntry[]` — read on every palette open.
- `actions?: Record<string, { label, run }>` — the same shape as `KEY_ACTIONS`,
  so the two merge and the help overlay picks up labels for free.

Both contributions are gathered from the registry at the point of use, so a
toggle takes effect immediately: the palette re-asks each time it opens, and
`rebindActions` (new in `keys.ts`) rebuilds the keybinding dispatch table from
the bindings already loaded. Nothing restarts, and no second keydown listener
is installed.

A disabled feature's actions are **absent** rather than inert, so the `?`
overlay never advertises a key that would do nothing.

Enabled state is GUI-owned, mirroring theming: a `cc-features` localStorage
object holding **only explicit user choices**, so a feature absent from it
follows its `defaultEnabled` and changing that default later moves users who
never expressed a preference. Toggles write straight through and sit outside
the Settings Save/Cancel flow, like the appearance controls.

Features register themselves in `src/featureList.ts`, which `main.ts` imports
for its side effects — one line per feature instead of another edit inside
`main.ts`.

## Consequences

- Adding an optional feature is: write the module, add one line to
  `featureList.ts`. `main.ts` stops growing per feature.
- Nothing is registered yet, so Settings → Features shows an empty state. This
  lands as mechanism ahead of its first consumer deliberately — the first
  consumer is the wayfinder workflow UI.
- Backend capability is a hard boundary: `claude-commander` is pinned to a git
  tag, so a feature gets the existing `invoke` surface or nothing. Anything
  needing a new Rust command is first-party by definition.
- Contributions are limited to palette entries and keybindings on purpose.
  Overlay panels, sidebar chips and settings fields are not extension points
  yet; add them when a real feature needs them, not in advance.
- A later **tier 1** (declarative, data-only plugins loaded from disk, on the
  model of custom themes) would reuse this contract as its target shape, and
  should be designed by trying to re-express a shipped first-party feature as a
  manifest — not in the abstract. **Tier 2** (sandboxed code plugins) needs a
  capability model, a CSP and a real CSP review, and is out of scope.
- Risk to watch: a toggle list is a way to avoid deciding. Opinionated defaults
  are what this app is for, and forty switches is a worse product than twelve
  considered ones.
