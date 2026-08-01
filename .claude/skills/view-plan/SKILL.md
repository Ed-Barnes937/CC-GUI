---
name: view-plan
description: >
  Offer to open a markdown file (a plan, design doc, or repo doc) in CC-GUI's
  built-in markdown viewer. Use after writing or updating a plan .md file, or
  when pointing the user at an existing markdown doc worth reading
  (plans/*.md, docs/*.md, README, DESIGN docs).
---

# View plan in the markdown viewer

CC-GUI has a built-in markdown reader (`Cmd+M`) that renders any `.md` in the
session's repo as a distraction-free reading column, with a fuzzy file picker
(`/`) and in-repo link navigation.

When you have just written or updated a markdown document the user should
read (a plan, a design doc, research notes), end your message with a viewer
pointer instead of dumping the document into the terminal:

```
📄 Read it in the markdown viewer: press ⌘M and pick `plans/split-screen.md`
```

Rules:

- Use the repo-relative path, exactly as the viewer's file list shows it.
- Offer the viewer only for documents worth reading in full — not for
  one-paragraph notes you can just say inline.
- Don't re-print the document's contents in the terminal when you offer the
  viewer; a one-line summary plus the pointer is enough.

There is no programmatic "open this file in the GUI" channel from a session
yet — the pointer is the offer; the user presses `⌘M` themselves.
