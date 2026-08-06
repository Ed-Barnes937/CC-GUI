import { describe, expect, it } from "vitest";
import { rankByRelevance, resolveTarget, type MdFile } from "./markdownRelevance";

/** `path@mtime` (a trailing `*` marks it changed on the session's branch). */
function files(...specs: string[]): MdFile[] {
  return specs.map((spec) => {
    const changedOnBranch = spec.endsWith("*");
    const [path, mtime] = (changedOnBranch ? spec.slice(0, -1) : spec).split("@");
    return { path, mtime: Number(mtime), changedOnBranch };
  });
}

function paths(list: MdFile[]): string[] {
  return list.map((f) => f.path);
}

describe("rankByRelevance", () => {
  it("puts branch-changed docs first, newest mtime first within each band", () => {
    const ranked = rankByRelevance(
      files("README.md@500", "plans/old.md@100*", "docs/notes.md@200", "plans/new.md@300*"),
    );
    expect(paths(ranked)).toEqual([
      "plans/new.md",
      "plans/old.md",
      "README.md",
      "docs/notes.md",
    ]);
  });

  it("breaks mtime ties case-insensitively by path", () => {
    const ranked = rankByRelevance(files("b.md@100", "A.md@100", "a.md@100"));
    expect(paths(ranked)).toEqual(["A.md", "a.md", "b.md"]);
  });

  it("does not mutate its input", () => {
    const input = files("a.md@100", "b.md@200*");
    rankByRelevance(input);
    expect(paths(input)).toEqual(["a.md", "b.md"]);
  });
});

describe("resolveTarget", () => {
  it("opens the newest branch-changed doc", () => {
    const target = resolveTarget(files("README.md@900", "plans/plan.md@300*", "docs/a.md@400*"), null);
    expect(target).toBe("docs/a.md");
  });

  it("falls back to README when nothing changed on the branch", () => {
    expect(resolveTarget(files("docs/a.md@400", "README.md@100"), null)).toBe("README.md");
  });

  it("matches README case-insensitively but only at the repo root", () => {
    expect(resolveTarget(files("docs/README.md@100"), null)).toBeNull();
    expect(resolveTarget(files("Readme.md@100"), null)).toBe("Readme.md");
  });

  it("returns null (→ the picker) with neither changed docs nor a README", () => {
    expect(resolveTarget(files("docs/a.md@400"), null)).toBeNull();
    expect(resolveTarget([], null)).toBeNull();
  });

  it("returns to the last-viewed doc ahead of the ladder", () => {
    const target = resolveTarget(files("plans/plan.md@300*", "docs/a.md@100"), {
      path: "docs/a.md",
      at: 400,
    });
    expect(target).toBe("docs/a.md");
  });

  it("lets a changed doc newer than the last view win", () => {
    const target = resolveTarget(files("plans/plan.md@500*", "docs/a.md@100"), {
      path: "docs/a.md",
      at: 400,
    });
    expect(target).toBe("plans/plan.md");
  });

  it("ignores a last-viewed doc that has left the listing", () => {
    const target = resolveTarget(files("README.md@100"), { path: "gone.md", at: 400 });
    expect(target).toBe("README.md");
  });
});
