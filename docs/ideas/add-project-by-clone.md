# Idea: add a project by cloning (GitHub slug or URL)

> **Status: not implemented.** Captured idea, not shipped behaviour. Delete
> this file when the work lands. Library surface available since
> claude-commander **v0.33.0** (upstream #287).

## What this is

CC-GUI's add-project flow (`src-tauri/src/projects.rs`) only registers a
checkout that already exists on disk. CC can now clone first: give it an
`owner/name` GitHub slug or any clone URL, and it clones into the projects
directory as an async job and registers the result as a project.

## The library surface

`claude_commander_core::api::CommanderService`:

- `start_clone(CloneRequest) -> Result<CloneJob>` - kicks off the clone,
  returns immediately with a job to poll.
- `clone_job(CloneJobId) -> Option<CloneJob>` - poll for progress.

Types (from `claude-commander-protocol`, re-exported through core):

- `CloneRequest { source: CloneSource, dest_name: Option<String> }` with
  `CloneSource::Github { full_name }` or `CloneSource::Url { url }`; sources
  are validated (`validate_repo_slug` / `validate_clone_url`).
- `CloneJob { id, source_label, dest, status }` with `CloneStatus::Running` /
  `Succeeded { project_id }` / `Failed { message }` /
  `DestinationExists { dest, is_git_repo }`. `DestinationExists` is a distinct
  arm because the frontend can act on it: offer "add the existing checkout"
  (when `is_git_repo`) or "pick a different name".

## GUI integration

- `src-tauri/src/projects.rs` - thin `start_clone` / `clone_job` commands.
- Add-project UI: extend the existing add flow with a "Clone from GitHub/URL"
  input; while `Running`, show the job on the project list (a pending header
  row), then swap to the registered project on `Succeeded`.
- `DestinationExists { is_git_repo: true }` should offer one-click "add the
  existing checkout" (the idempotent register path already exists).
- Errors via `src/toast.ts`.

## Verification (when implemented)

- iwft scenario: simulate a clone job lifecycle in `TauriSimulator`
  (Running -> Succeeded, and the DestinationExists branch) and assert the
  project list follows.
