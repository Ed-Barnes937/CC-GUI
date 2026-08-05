// Page-side backend fake. esbuild bundles this to an IIFE that an addInitScript
// runs before the app boots (see globalSetup + launchApp). It installs the real
// Tauri mockIPC and answers the command surface from seeded, mutable in-memory
// state — a fake, not a mock: tests assert on resulting state, not on which
// calls fired.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { confirmDialog, promptDialog, deleteSessionDialog } from "../../../toast";
import type { Comment, ReviewSnapshot } from "../../../review/model";
import type { FsEntry, ProgramInfo, Seed, SessionRow, Snapshot } from "./types.testHelper";

type CreateCommentArgs = {
  id: string;
  file: string;
  side: "old" | "new";
  lineRange: [number, number];
  snippet: string;
  comment: string;
};

class TauriSimulator {
  private snapshot: Snapshot;
  private reviews: Record<string, ReviewSnapshot>;
  private comments: Record<string, Comment[]>; // by session id
  private reviewed: Record<string, Set<string>>; // reviewed file paths, by session id
  private config: Record<string, unknown>;
  private keybindings: Record<string, string[]>;
  private customThemes: unknown[];
  private savedConfig: Record<string, unknown> | null = null;
  // Per-tmux-session PTY byte channels captured from attach(), keyed by name.
  private ptyChannels: Record<string, { channel: { id: number }; index: number }> = {};
  private nextComment = 1;
  private nextSession = 1;
  private nextProject = 1;
  private dirs: string[];
  private programs: ProgramInfo[];
  private defaultProgram: string;
  private browsePath: string | null;
  private fileTree: Record<string, FsEntry[]>;
  // The markdown viewer's fake repo: .md path → content + mtime.
  private markdownFiles: Record<string, { content: string; mtime: number }>;
  // Repo-relative image path → base64 bytes (read_session_image).
  private sessionImages: Record<string, string>;
  // Live-reload seams: reads counted (to assert polling stopped) and a
  // failure toggle (a failed poll must keep the last good rendering).
  private markdownReadCount = 0;
  private markdownReadsFail = false;
  private diffStats: Record<string, string>;
  private openedUrls: string[] = [];
  // Bytes the frontend wrote to a PTY (write_pty) — the file explorer's @path
  // reference lands here, in order.
  private ptyWrites: { tmuxSession: string; data: string }[] = [];
  // Section moves the frontend actually dispatched (a no-op drop short-circuits
  // before invoke, so this stays empty — how a negative test tells them apart).
  private sectionMoves: { id: string; section: string | null }[] = [];

  constructor(seed: Seed) {
    this.snapshot = seed.snapshot;
    this.reviews = seed.reviews;
    this.config = seed.config ?? {};
    this.keybindings = seed.keybindings ?? {};
    this.customThemes = seed.customThemes ?? [];
    this.dirs = seed.dirs ?? [];
    this.programs = seed.programs ?? [];
    this.defaultProgram = seed.defaultProgram ?? "claude";
    this.browsePath = seed.browsePath ?? null;
    this.fileTree = seed.fileTree ?? {};
    this.markdownFiles = Object.fromEntries(
      Object.entries(seed.markdownFiles ?? {}).map(([path, v]) => [
        path,
        typeof v === "string" ? { content: v, mtime: 0 } : v,
      ]),
    );
    this.sessionImages = seed.sessionImages ?? {};
    this.diffStats = seed.diffStats ?? {};
    this.comments = {};
    this.reviewed = {};
    for (const [id, review] of Object.entries(seed.reviews)) {
      this.comments[id] = [...review.comments];
      this.reviewed[id] = new Set(review.reviewed);
    }
    this.handle = this.handle.bind(this);
  }

  /** The config last persisted via save_config — what a settings test asserts. */
  getSavedConfig(): Record<string, unknown> | null {
    return this.savedConfig;
  }

  // ----- assertion getters (called from tests via page.evaluate) -----
  getComments(sessionId: string): Comment[] {
    return this.comments[sessionId] ?? [];
  }

  /** Reviewed file paths the fake now holds for a session — the state a
   *  reviewed-toggle test asserts against. */
  getReviewed(sessionId: string): string[] {
    return [...(this.reviewed[sessionId] ?? [])];
  }

  /** Flattened live sessions across all groups — the state a sidebar test asserts. */
  getSessions(): SessionRow[] {
    return this.snapshot.groups.flatMap((g) => g.sessions);
  }

  /** Projects the fake now holds (name + repo_path) — what an add-project test
   *  asserts against. */
  getProjects(): { id: string; name: string; repo_path: string }[] {
    return this.snapshot.groups.map((g) => ({ id: g.id, name: g.name, repo_path: g.repo_path }));
  }

  /** Current section buckets (null in project view) — what a move-to-section
   *  test asserts placement against. */
  getSectionBuckets(): { name: string; session_ids: string[] }[] | null {
    return this.snapshot.sections;
  }

  /** Section moves the frontend dispatched, in order — for asserting a no-op
   *  drop fired nothing. */
  getSectionMoves(): { id: string; section: string | null }[] {
    return this.sectionMoves;
  }

  getViewMode(): string {
    return this.snapshot.view_mode;
  }

  /** URLs the frontend asked the platform opener to launch (open_external). */
  getOpenedUrls(): string[] {
    return this.openedUrls;
  }

  /** Bytes written to PTYs via write_pty, in order — what a file-explorer test
   *  asserts the `@path` reference against. */
  getPtyWrites(): { tmuxSession: string; data: string }[] {
    return this.ptyWrites;
  }

  /** Write (or create) a fake .md file — the "agent edits the doc" seam the
   *  live-reload scenarios drive. */
  setMarkdownFile(path: string, content: string): void {
    this.markdownFiles[path] = { content, mtime: 0 };
  }

  /** Make read_session_file throw until reset — a mid-write read failure. */
  setMarkdownReadsFail(fail: boolean): void {
    this.markdownReadsFail = fail;
  }

  /** read_session_file calls so far — a stable count proves polling stopped. */
  getMarkdownReadCount(): number {
    return this.markdownReadCount;
  }

  // ----- event push (the backend's role; available for sidebar scenarios) -----
  async pushSnapshot(snapshot: Snapshot): Promise<void> {
    this.snapshot = snapshot;
    await emit("sessions-updated", snapshot);
  }

  // ----- PTY byte stream (the backend writing to a terminal's Channel) -----
  /** Push UTF-8 bytes to a session's attached terminal, as the backend's PTY would.
   *  mockIPC keeps args un-serialized, so the captured onData is the real Channel;
   *  runCallback drives its onmessage. */
  pushPtyBytes(name: string, bytes: number[]): void {
    const entry = this.ptyChannels[name];
    if (!entry) return;
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { runCallback: (id: number, msg: unknown) => void };
    }).__TAURI_INTERNALS__;
    internals.runCallback(entry.channel.id, { index: entry.index++, message: bytes });
  }

  /** Signal a PTY ended (or detached), as the backend's pty-exit event would. */
  async emitPtyExit(name: string, ended: boolean): Promise<void> {
    await emit("pty-exit", { session: name, ended });
  }

  // ----- the invoke surface -----
  handle(cmd: string, args: Record<string, unknown>): unknown {
    switch (cmd) {
      case "get_groups":
        return this.snapshot;
      case "set_view_mode":
        this.snapshot.view_mode = args.mode as string;
        return null;
      case "get_create_options":
        return { default_program: this.defaultProgram, programs: this.programs, sections: [] };
      case "create_session":
        return this.createSession(
          args.projectPath as string,
          args.title as string,
          args.program as string | undefined,
        );
      case "rename_session":
        return this.renameSession(args.id as string, args.title as string);
      case "delete_session":
        return this.deleteSession(args.id as string);
      case "restart_session":
        return this.restartSession(args.id as string);
      case "move_to_section":
        return this.moveToSection(args.id as string, (args.section as string | null) ?? null);
      case "merged_pr_sessions":
        return this.mergedPrSessions();
      case "get_session_detail":
        return this.sessionDetail(args.id as string);
      // ----- add project / scan / path autocomplete -----
      case "complete_path":
        return this.completePath(args.partial as string);
      case "add_project":
        return this.addProject(args.path as string);
      case "scan_directory":
        return this.scanDirectory(args.path as string);
      // ----- dialog plugin (native folder picker behind "Browse…") -----
      case "plugin:dialog|open":
        return this.browsePath;
      // ----- PTY lifecycle (terminal tabs) -----
      case "prepare_attach":
        return null;
      case "prepare_shell":
        return `cc-${args.id as string}-sh`;
      case "prepare_project_shell":
        return `cc-${args.id as string}-proj-sh`;
      case "prepare_commander":
        return "cc-commander";
      case "attach":
        this.ptyChannels[args.tmuxSession as string] = {
          channel: args.onData as { id: number },
          index: 0,
        };
        return null;
      case "write_pty":
        this.ptyWrites.push({
          tmuxSession: args.tmuxSession as string,
          data: args.data as string,
        });
        return null;
      case "restart_fresh":
      case "resize_pty":
      case "detach":
        return null;
      case "list_session_dir":
        return this.listSessionDir(args.subPath as string, args.showHidden as boolean);
      case "list_markdown_files": {
        // Mirrors the backend (files.rs MD_MAX_FILES): newest-first, cap
        // applied after sorting, total reported for the truncation row.
        const MD_MAX_FILES = 500;
        const all = Object.entries(this.markdownFiles)
          .map(([path, f]) => ({ path, mtime: f.mtime }))
          .sort((a, b) => b.mtime - a.mtime || a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
        return { files: all.slice(0, MD_MAX_FILES), total: all.length };
      }
      case "read_session_file": {
        this.markdownReadCount++;
        if (this.markdownReadsFail) throw "read failed";
        const file = this.markdownFiles[args.relPath as string];
        if (file === undefined) throw `cannot resolve path: ${args.relPath}`;
        return file.content;
      }
      case "read_session_image": {
        const bytes = this.sessionImages[args.relPath as string];
        if (bytes === undefined) throw `cannot resolve path: ${args.relPath}`;
        return bytes;
      }
      case "open_external":
        this.openedUrls.push(args.url as string);
        return null;
      // ----- clipboard-manager plugin (copy-on-select + Claude's OSC 52) -----
      // The native backend writes to the system pasteboard; here the page's own
      // clipboard stands in for it (tests grant clipboard permissions).
      case "plugin:clipboard-manager|write_text":
        return navigator.clipboard.writeText(args.text as string);
      case "plugin:clipboard-manager|read_text":
        return navigator.clipboard.readText();
      case "list_custom_themes":
        return this.customThemes;
      case "get_keybindings":
        return this.keybindings;
      case "get_config":
        return this.config;
      case "save_config":
        this.savedConfig = args.config as Record<string, unknown>;
        return false; // restartRequired
      case "open_review":
        return this.openReview(args.id as string);
      case "create_comment":
        return this.createComment(args as unknown as CreateCommentArgs);
      case "delete_comment":
        return this.deleteComment(args.id as string, args.commentId as string);
      case "toggle_file_reviewed":
        return this.toggleFileReviewed(args.id as string, args.path as string);
      case "apply_comments":
        return this.applyComments(args.id as string);
      case "refresh_pr_status":
        // The native command kicks the PR-poll loop; the fake has no live PR
        // state to refresh, so it's a no-op (matches the UI: a background nudge).
        return null;
      default:
        // Unhandled commands resolve to null rather than throwing, so an
        // unstubbed call surfaces as a UI no-op, not a crashed boot.
        console.warn(`[iwft] unhandled command: ${cmd}`);
        return null;
    }
  }

  // ----- sidebar mutations (frontend reads them back via refreshNow→get_groups) -----
  // Records the threaded `program` on the new session's row (the backend infers
  // the harness from it). `undefined` mirrors the backend default of "claude".
  private createSession(projectPath: string, title: string, program?: string): null {
    const group = this.snapshot.groups.find((g) => g.repo_path === projectPath);
    if (!group) return null;
    const id = `new-sess-${this.nextSession++}`;
    group.sessions.push({
      id,
      title,
      branch: `cc/${id}`,
      status: "running",
      program: program ?? "claude",
      agent_state: "idle",
      tmux_session_name: `cc-${id}`,
      pr_number: null,
      pr_url: null,
      pr_state: null,
      pr_draft: false,
      pr_labels: [],
      review_decision: null,
      has_pending_comments: false,
      unread: false,
      stacked_child: false,
      project_id: group.id,
      project_name: group.name,
      current_section: null,
    });
    // A new session is bucketed by the backend; mirror that so it shows up in
    // section views (catch-all "In Progress", since current_section is null).
    if (this.snapshot.sections !== null) this.rebuildSections();
    return null;
  }

  private renameSession(id: string, title: string): null {
    for (const g of this.snapshot.groups) {
      const s = g.sessions.find((row) => row.id === id);
      if (s) s.title = title;
    }
    return null;
  }

  private deleteSession(id: string): null {
    for (const g of this.snapshot.groups) {
      g.sessions = g.sessions.filter((row) => row.id !== id);
    }
    return null;
  }

  /** Restart (also the Wake action for a hibernated session): the backend
   *  recreates the pane and, when the session was hibernated, resumes the prior
   *  agent — so status goes Running and the hibernation marker clears. */
  private restartSession(id: string): null {
    for (const g of this.snapshot.groups) {
      const s = g.sessions.find((row) => row.id === id);
      if (s) {
        s.status = "running";
        s.hibernated = false;
      }
    }
    return null;
  }

  /** Pin (or, with section=null, unpin) a session's section, then re-bucket.
   *  Mirrors the backend move_to_section: only the section assignment changes,
   *  never the owning project/group. */
  private moveToSection(id: string, section: string | null): null {
    this.sectionMoves.push({ id, section });
    for (const g of this.snapshot.groups) {
      const s = g.sessions.find((row) => row.id === id);
      if (s) s.current_section = section;
    }
    if (this.snapshot.sections !== null) this.rebuildSections();
    return null;
  }

  /** Re-derive the section buckets from each session's current_section,
   *  mirroring the library's build_sections: bucket 0 is the reserved
   *  "In Progress" catch-all, followed by each configured section in
   *  section_names order (empties included). A session whose current_section is
   *  null or names an unknown section falls into In Progress. Predicates are not
   *  modeled (the fake tracks manual pins only); insertion order stands in for
   *  the backend's entered_section_at ordering. */
  private rebuildSections(): void {
    const names = this.snapshot.section_names;
    const buckets: { name: string; session_ids: string[] }[] = [
      { name: "In Progress", session_ids: [] },
      ...names.map((name) => ({ name, session_ids: [] as string[] })),
    ];
    for (const s of this.getSessions()) {
      const i =
        s.current_section && names.includes(s.current_section)
          ? names.indexOf(s.current_section) + 1
          : 0;
      buckets[i].session_ids.push(s.id);
    }
    this.snapshot.sections = buckets;
  }

  /** Directories that are direct children of `partial`'s parent and whose
   *  basename starts with its trailing segment — mirrors the backend's
   *  list_matching_dirs over the seeded `dirs` (no real filesystem). */
  private completePath(partial: string): string[] {
    const slash = partial.lastIndexOf("/");
    const parent = slash >= 0 ? partial.slice(0, slash + 1) : "";
    const name = slash >= 0 ? partial.slice(slash + 1) : partial;
    const results = new Set<string>();
    for (const d of this.dirs) {
      if (parent && !d.startsWith(parent)) continue;
      const rest = parent ? d.slice(parent.length) : d;
      const seg = rest.split("/")[0];
      if (seg && seg.startsWith(name)) results.add(`${parent}${seg}`);
    }
    return [...results].sort();
  }

  /** Add a project group (no sessions) keyed off the path's basename, mirroring
   *  the backend add_project; returns the new id like the real command. */
  private addProject(path: string): string {
    const id = `proj-add-${this.nextProject++}`;
    const name = path.replace(/\/+$/, "").split("/").pop() || path;
    this.snapshot.groups.push({ id, name, repo_path: path, pull_blocked: null, sessions: [] });
    return id;
  }

  /** Count seeded dirs nested under `path` as the "added" repos. */
  private scanDirectory(path: string): { added: number; skipped: number } {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const added = this.dirs.filter((d) => d.startsWith(prefix)).length;
    return { added, skipped: 0 };
  }

  /** Detail for one session, derived from its snapshot row plus the seeded
   *  diffstat — mirrors the backend's get_session_detail (null when gone). */
  private sessionDetail(id: string): Record<string, unknown> | null {
    const s = this.getSessions().find((row) => row.id === id);
    if (!s) return null;
    return {
      id: s.id,
      title: s.title,
      branch: s.branch,
      status: s.status,
      program: s.program,
      project_name: s.project_name,
      pr_number: s.pr_number,
      pr_url: s.pr_url,
      pr_state: s.pr_state ?? "",
      pr_draft: s.pr_draft,
      created_at: "2026-06-13T00:00:00Z",
      agent_state: s.agent_state,
      diff_stat: this.diffStats[s.id] ?? null,
    };
  }

  /** [id, label] pairs for sessions whose PR has merged — the merged-PR sweep source. */
  private mergedPrSessions(): [string, string][] {
    return this.getSessions()
      .filter((s) => s.pr_state === "merged")
      .map((s) => [s.id, s.title]);
  }

  /** Contents of one directory in the fake file tree, sorted directories-first
   *  then case-insensitive by name — mirroring the backend's list_session_dir. */
  private listSessionDir(
    subPath: string,
    showHidden: boolean,
  ): { rel_path: string; at_root: boolean; entries: FsEntry[] } {
    const all = this.fileTree[subPath] ?? [];
    const entries = all
      .filter((e) => showHidden || !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
    return { rel_path: subPath, at_root: subPath === "", entries };
  }

  private openReview(id: string): ReviewSnapshot {
    const review = this.reviews[id];
    return {
      base: review.base,
      diff: review.diff,
      comments: this.comments[id] ?? [],
      reviewed: [...(this.reviewed[id] ?? [])],
    };
  }

  /** Toggle a file's reviewed mark and return its new state, mirroring the
   *  backend's persisted toggle. */
  private toggleFileReviewed(id: string, path: string): boolean {
    const marks = this.reviewed[id] ?? (this.reviewed[id] = new Set());
    if (marks.has(path)) {
      marks.delete(path);
      return false;
    }
    marks.add(path);
    return true;
  }

  private createComment(a: CreateCommentArgs): null {
    const list = this.comments[a.id] ?? (this.comments[a.id] = []);
    list.push({
      id: `c${this.nextComment++}`,
      file: a.file,
      side: a.side,
      line_range: a.lineRange,
      snippet: a.snippet,
      comment: a.comment,
      status: "staged",
      created_at: "2026-06-13T00:00:00Z",
    });
    return null;
  }

  private deleteComment(sessionId: string, commentId: string): null {
    const list = this.comments[sessionId] ?? [];
    this.comments[sessionId] = list.filter((c) => c.id !== commentId);
    return null;
  }

  private applyComments(sessionId: string): unknown {
    const list = this.comments[sessionId] ?? [];
    const pending = list.filter((c) => c.status !== "applied");
    if (!pending.length) return { outcome: "nothing" };
    for (const c of pending) c.status = "applied";
    return { outcome: "applied", path: "/repos/acme/.brief.md", count: pending.length };
  }
}

declare global {
  interface Window {
    __CC_IWFT_SEED__: Seed;
    __CC_SIM__: TauriSimulator;
    /** The app's real confirm/prompt/delete dialogs, exposed for the Dialogs
     *  POM to drive directly (pure DOM + Promise, no trigger flow needed). */
    __CC_DIALOGS__: {
      confirmDialog: typeof confirmDialog;
      promptDialog: typeof promptDialog;
      deleteSessionDialog: typeof deleteSessionDialog;
    };
  }
}

const sim = new TauriSimulator(window.__CC_IWFT_SEED__);
window.__CC_SIM__ = sim;
window.__CC_DIALOGS__ = { confirmDialog, promptDialog, deleteSessionDialog };
// metadata for getCurrentWindow() (main.ts wires onThemeChanged at module load);
// mockIPC handles invoke + the event plugin.
mockWindows("main");
mockIPC(sim.handle, { shouldMockEvents: true });
