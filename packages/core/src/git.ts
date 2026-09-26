import type { FsKind } from "./filesystem";

/** A path's standing in the work tree, as the desktop backend reports it. */
export type GitState = "ignored" | "untracked" | "added" | "deleted" | "modified" | "conflicted";

/** What the lens shows for an object: its reported state, or nothing to report. */
export type GitLensState = GitState | "clean";

export type GitStatusEntry = {
  /** Relative to the open folder, `/`-separated; empty for the folder itself. */
  path: string;
  state: GitState;
};

export type GitStatusReport = {
  entries: GitStatusEntry[];
  /** More changed than the backend would send; the rest read as clean. */
  truncated: boolean;
};

/** Weakest first, so a larger index always says more about what happened. */
const STRENGTH: readonly GitState[] = ["ignored", "untracked", "added", "deleted", "modified", "conflicted"];

function stronger(a: GitState | undefined, b: GitState): GitState {
  return a === undefined || STRENGTH.indexOf(b) > STRENGTH.indexOf(a) ? b : a;
}

type TrieNode = {
  own?: GitState;
  /** Strongest state anywhere beneath, as a folder should carry it. */
  beneath?: GitState;
  children: Map<string, TrieNode>;
};

/**
 * What a folder shows for something that happened inside it. Ignored files say nothing
 * about the folder around them — every project has a build directory — and a deleted
 * file has no object of its own left to colour, so the folder that lost it reads as
 * modified, which is what it is.
 */
function asFolderState(state: GitState): GitState | undefined {
  if (state === "ignored") return undefined;
  return state === "deleted" ? "modified" : state;
}

/**
 * Answers "what is the git state of this object" for any path under the open folder, in
 * time proportional to the path's depth rather than the size of the report.
 */
export type GitStatusIndex = {
  stateAt(segments: readonly string[], kind: FsKind): GitLensState;
  truncated: boolean;
};

export function createGitStatusIndex(report: GitStatusReport): GitStatusIndex {
  const root: TrieNode = { children: new Map() };
  for (const entry of report.entries) {
    const segments = entry.path.split("/").filter(Boolean);
    const folderState = asFolderState(entry.state);
    let node = root;
    for (const segment of segments) {
      if (folderState) node.beneath = stronger(node.beneath, folderState);
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.own = stronger(node.own, entry.state);
  }

  return {
    truncated: report.truncated,
    stateAt(segments, kind) {
      let node: TrieNode | undefined = root;
      for (const segment of segments) {
        // Everything inside a folder reported whole as untracked or ignored shares its
        // state; git collapses such a folder into one entry rather than listing it.
        if (node.own === "untracked" || node.own === "ignored") return node.own;
        node = node.children.get(segment);
        if (!node) return "clean";
      }
      if (kind === "file") return node.own ?? "clean";
      return node.own ?? node.beneath ?? "clean";
    },
  };
}
