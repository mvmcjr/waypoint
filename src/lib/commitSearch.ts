import type { PositionedCommit } from "./ipc";
import { isStashCommit, stashLabel } from "./utils";

// No real stash oids are available where the index is built (repo.tsx doesn't
// fetch the stash list) — the summary-prefix heuristic in isStashCommit still
// catches the normal case (auto-generated "WIP on …" messages), which is
// enough to let a stash's display label participate in matching.
const EMPTY_STASH_OIDS: Set<string> = new Set();

export interface CommitIndexEntry {
  item: PositionedCommit;
  oidLower: string;
  /** summary, author name, author email, and (for stash-shaped commits) the display label. */
  searchableLower: string[];
  refsLower: string[];
}

export interface CommitIndex {
  entries: CommitIndexEntry[];
}

/** Build once per commits array (memoize in the consumer) — every lookup below is pure string matching. */
export function buildCommitIndex(commits: PositionedCommit[]): CommitIndex {
  const entries = commits.map((item) => {
    const c = item.commit;
    const refsLower = [...c.refs, ...c.local_branches, ...c.remote_branches].map((r) => r.toLowerCase());
    const searchableLower = [c.summary.toLowerCase(), c.author_name.toLowerCase(), c.author_email.toLowerCase()];
    if (isStashCommit(c.oid, c.summary, EMPTY_STASH_OIDS)) {
      searchableLower.push(stashLabel(c.summary).toLowerCase());
    }
    return { item, oidLower: c.oid.toLowerCase(), searchableLower, refsLower };
  });
  return { entries };
}

export interface MatchResult {
  /** Matching oids, in timeline (input) order. */
  oids: string[];
  tokens: string[];
}

// Tokens shorter than this are excluded from oid-prefix matching — "add" or
// "fab" would otherwise pull in commits whose hash happens to start that way.
const MIN_OID_TOKEN_LEN = 4;

/**
 * Find commits matching a "go to commit" query. Every whitespace-separated
 * token must match (AND) at least one of: summary, author name/email, any
 * ref name, or a stash's display label, as a substring — or the oid, but only
 * as a prefix and only when the token is long enough to be meaningful.
 */
export function findMatches(index: CommitIndex, query: string): MatchResult {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { oids: [], tokens: [] };

  const oids: string[] = [];
  for (const entry of index.entries) {
    const matchesAll = tokens.every(
      (tok) =>
        entry.searchableLower.some((s) => s.includes(tok)) ||
        entry.refsLower.some((r) => r.includes(tok)) ||
        (tok.length >= MIN_OID_TOKEN_LEN && entry.oidLower.startsWith(tok)),
    );
    if (matchesAll) oids.push(entry.item.commit.oid);
  }
  return { oids, tokens };
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split text into segments alternating matched/unmatched runs, for rendering
 * <mark> highlights. Handles overlapping/adjacent token occurrences by merging
 * them into a single covered run rather than double-marking.
 */
export function splitHighlights(text: string, tokens: string[]): HighlightSegment[] {
  const meaningfulTokens = tokens.filter(Boolean);
  if (meaningfulTokens.length === 0 || text.length === 0) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const mask = new Array<boolean>(text.length).fill(false);
  for (const tok of meaningfulTokens) {
    let start = 0;
    while (start <= lower.length - tok.length) {
      const idx = lower.indexOf(tok, start);
      if (idx === -1) break;
      for (let i = idx; i < idx + tok.length; i++) mask[i] = true;
      start = idx + 1; // allow overlapping occurrences
    }
  }

  const segments: HighlightSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const runStart = i;
    const runMatch = mask[i];
    while (i < text.length && mask[i] === runMatch) i++;
    segments.push({ text: text.slice(runStart, i), match: runMatch });
  }
  return segments;
}
