# ADR-0006: Relative images via a base64 read command

Date: 2026-08-01
Status: accepted

## Context

Repo-relative images (`![x](assets/foo.png)`) can't resolve inside the
webview — the document is rendered from a string, not served from the repo.
Remote `http(s)` images already load natively (the app's CSP is `null`), so
only relative paths are broken. The review view already solves the same
problem with `read_review_image`: base64 over invoke, frontend builds a
`data:` URI.

## Decision

- New Tauri command `read_session_image(session_id, rel_path)` in
  `files.rs`, with the same canonicalize + worktree-escape guard as
  `read_session_file`, returning base64 — mirroring `read_review_image`.
- The frontend post-processes `<img>` tags after render: a relative `src` is
  resolved against the current document's directory (reusing
  `resolveRelative`), fetched, and swapped to a `data:` URI. MIME is
  inferred from the extension, whitelisted to `png/jpg/jpeg/gif/svg/webp`.
- Remote `http(s)` images are left untouched — they already work, and
  READMEs lean on badge images.
- Missing file, non-whitelisted extension, or a file over ~10MB renders a
  quiet broken-image placeholder; it never errors the whole document.

## Consequences

- SVG via `data:` URI in an `<img>` tag is inert (no script execution) —
  safe as long as these only ever land in `<img>`, which they do.
- Each open re-fetches images (no cache), consistent with the viewer's
  no-cache freshness stance.
