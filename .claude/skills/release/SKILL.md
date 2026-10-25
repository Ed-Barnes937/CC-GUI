---
name: release
description: Cut a CC-GUI release end to end - pick the version bump, run scripts/release.sh, watch the build, write user-facing release notes into the GitHub release, bump the Homebrew cask, and produce a Slack-ready blurb on the clipboard. Use when the user says "cut a release", "release a new version", "bump the cask", or asks for release notes or Slack notes for a CC-GUI version.
---

# Release CC-GUI

Run from the main checkout, on `main`, after the feature PRs have merged. `scripts/release.sh` checks its own preconditions and fails loudly; let it.

If the user asks for only part of this (notes, the cask, the Slack blurb), do just that step.

## 1. Pick the version

Set `last` to the latest tag (`git describe --tags --abbrev=0`). List what has landed since: `git log --merges --oneline <last>..origin/main`, plus `gh pr view` for any titles that are unclear.

- **Minor**: anything user-visible is new.
- **Patch**: fixes and internals only.

If the user didn't say which, propose a bump with a one-line reason and wait.

## 2. Draft the notes while you wait

Read the bodies of the last three releases (`gh release view <tag> --json body`) and match their voice and structure.

- **A headline feature** gets its own `##` heading with an emoji, a short plain-English pitch, then **What you can do** and **Good to know** bullets with bold lead-ins.
- **Everything else** goes under `## Also in this release` as one-line bullets. Fixes start with **Fix:**. Mention a claude-commander bump with its version.
- **Leave out** refactors, CI and test-only changes unless users would notice.

Show the draft to the user. They usually tweak it.

## 3. Cut and watch

Run `scripts/release.sh <patch|minor|major|X.Y.Z>`. It bumps the manifests, merges a release PR and pushes the tag. Then watch the build: `gh run list --workflow release.yml --limit 1`, then `gh run watch <id> --exit-status`. A failed build stops the release; report the failing job and its log tail.

## 4. Publish the notes

CI writes the install instructions into the release body. Once the user approves the draft, put the notes above that text, separated by `---`:

1. `gh release view vX.Y.Z --json body -q .body > <scratch>/ci-body.md`
2. Write `<scratch>/notes.md` as the approved notes, then `---`, then `ci-body.md`.
3. `gh release edit vX.Y.Z --notes-file <scratch>/notes.md`

## 5. Bump the cask

The CI cask job is disabled (`if: false` in `release.yml`), so bump the cask by hand in `Ed-Barnes937/homebrew-tap`:

```bash
gh release download vX.Y.Z --pattern '*aarch64.dmg' --dir <scratch>
shasum -a 256 <scratch>/CC-GUI_X.Y.Z_aarch64.dmg
gh repo clone Ed-Barnes937/homebrew-tap <scratch>/tap
```

In `Casks/cc-gui.rb`, change only the `version` and `sha256` lines. Commit as `cc-gui X.Y.Z` and push. To confirm, read the cask back with `gh api repos/Ed-Barnes937/homebrew-tap/contents/Casks/cc-gui.rb`.

## 6. Slack blurb

Write a short, informal version for colleagues: 4-8 lines with a casual one-line opener, the headline feature in a sentence, a few bullets, and the upgrade command `brew upgrade --cask cc-gui`. New installs use `brew install --cask ed-barnes937/tap/cc-gui`. Use plain markdown, since Slack pastes it as-is. Copy it with `pbcopy` and print it.

The release is complete when the tag's build is green, the release body has the notes, the cask points at the new version, and the Slack blurb is on the clipboard.
