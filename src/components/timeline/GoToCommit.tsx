import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PositionedCommit } from "@/lib/ipc";
import { buildCommitIndex, findMatches } from "@/lib/commitSearch";

const DEBOUNCE_MS = 120;

export interface MatchesChange {
  matchOids: Set<string> | null;
  tokens: string[];
}

interface Props {
  commits: PositionedCommit[];
  selectedOid: string | null;
  onGo: (oid: string) => void;
  onMatchesChange: (change: MatchesChange) => void;
}

function isMac() {
  return navigator.userAgent.includes("Mac");
}

function isForeignEditableTarget(el: Element | null, ownInput: HTMLInputElement | null): boolean {
  if (!el || el === ownInput) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

/**
 * Toolbar "find in timeline" control. There is no popup: matching rows are
 * highlighted in place and non-matching rows dim, so the graph and surrounding
 * context (what the user actually wants when hunting for a commit) never
 * disappear. See src/lib/commitSearch.ts for the matching rules.
 */
export function GoToCommit({ commits, selectedOid, onGo, onMatchesChange }: Props) {
  const [queryInput, setQueryInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Where focus was before Ctrl+F moved it here — Escape returns it there.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const counterId = useId();

  const index = useMemo(() => buildCommitIndex(commits), [commits]);
  const matches = useMemo(() => findMatches(index, debouncedQuery), [index, debouncedQuery]);

  // Refs so the stable goToRelative/global-shortcut callbacks always read
  // current values without re-registering their window listeners every render.
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const selectedOidRef = useRef(selectedOid);
  selectedOidRef.current = selectedOid;
  const onGoRef = useRef(onGo);
  onGoRef.current = onGo;
  const onMatchesChangeRef = useRef(onMatchesChange);
  onMatchesChangeRef.current = onMatchesChange;
  const debouncedQueryRef = useRef(debouncedQuery);
  debouncedQueryRef.current = debouncedQuery;
  const queryInputRef = useRef(queryInput);
  queryInputRef.current = queryInput;
  const indexRef = useRef(index);
  indexRef.current = index;

  // Report matches upward (and announce the settled count) whenever the
  // debounced query — not every keystroke — actually changes the result set.
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length === 0) {
      onMatchesChangeRef.current({ matchOids: null, tokens: [] });
      setLiveMessage("");
      return;
    }
    onMatchesChangeRef.current({ matchOids: new Set(matches.oids), tokens: matches.tokens });
    // Commits still loading/empty — nothing meaningful to announce yet.
    if (commits.length === 0) {
      setLiveMessage("");
      return;
    }
    const n = matches.oids.length;
    setLiveMessage(n === 0 ? "No matches" : `${n} match${n === 1 ? "" : "es"}`);
  }, [matches, debouncedQuery, commits.length]);

  function handleChange(value: string) {
    setQueryInput(value);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      setDebouncedQuery(value);
    }, DEBOUNCE_MS);
  }

  const goToRelative = useCallback((direction: 1 | -1) => {
    let oids = matchesRef.current.oids;
    // A debounce may still be pending (e.g. Enter right after pasting a hash) —
    // flush it so navigation never acts on the previous query's matches.
    if (queryInputRef.current !== debouncedQueryRef.current) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      oids = findMatches(indexRef.current, queryInputRef.current).oids;
      setDebouncedQuery(queryInputRef.current);
    }
    if (oids.length === 0) return;
    const curIdx = selectedOidRef.current ? oids.indexOf(selectedOidRef.current) : -1;
    let nextIdx: number;
    let wrapped = false;
    if (curIdx === -1) {
      nextIdx = direction === 1 ? 0 : oids.length - 1;
    } else {
      nextIdx = curIdx + direction;
      if (nextIdx < 0) {
        nextIdx = oids.length - 1;
        wrapped = true;
      } else if (nextIdx >= oids.length) {
        nextIdx = 0;
        wrapped = true;
      }
    }
    onGoRef.current(oids[nextIdx]);
    const wrapMsg = wrapped ? (direction === 1 ? "Wrapped to top. " : "Wrapped to bottom. ") : "";
    setLiveMessage(`${wrapMsg}${nextIdx + 1} of ${oids.length}`);
  }, []);

  function restoreFocus() {
    const el = previousFocusRef.current;
    previousFocusRef.current = null;
    if (el && document.contains(el)) el.focus();
    else inputRef.current?.blur();
  }

  function handleEscape() {
    if (queryInput.trim().length > 0) {
      setQueryInput("");
      setDebouncedQuery("");
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    }
    restoreFocus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      goToRelative(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleEscape();
    }
  }

  // Global Ctrl+F / Cmd+F focuses the field, remembering where focus came from.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isShortcut = e.key.toLowerCase() === "f" && (isMac() ? e.metaKey : e.ctrlKey);
      if (!isShortcut) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      if (active !== inputRef.current) previousFocusRef.current = active;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Global Ctrl+G / F3 (and Shift variants) navigate matches even when focus
  // is in the timeline — but not while the user is typing somewhere else.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const key = e.key.toLowerCase();
      const isNext = (e.key === "F3" && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "g");
      const isPrev = (e.key === "F3" && e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "g");
      if (!isNext && !isPrev) return;
      if (debouncedQueryRef.current.trim().length === 0) return;
      if (isForeignEditableTarget(document.activeElement, inputRef.current)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault();
      goToRelative(isNext ? 1 : -1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToRelative]);

  const n = matches.oids.length;
  const curIdx = selectedOid ? matches.oids.indexOf(selectedOid) : -1;
  const counterText = n === 0 ? "No matches" : curIdx === -1 ? `${n} match${n === 1 ? "" : "es"}` : `${curIdx + 1} / ${n}`;

  const trimmedInput = queryInput.trim();
  const showHint = trimmedInput.length === 0 && !focused;
  const showFeedback = trimmedInput.length > 0 && commits.length > 0;
  const keyShortcut = isMac() ? "Meta+F" : "Control+F";

  return (
    <div className="relative w-80">
      <Input
        ref={inputRef}
        role="searchbox"
        aria-label="Go to commit — find by message, author, hash, or branch"
        aria-keyshortcuts={keyShortcut}
        aria-describedby={counterId}
        className="h-7 text-xs pr-[92px]"
        placeholder="Go to commit…"
        value={queryInput}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />

      <div className="absolute inset-y-0 right-1.5 flex items-center gap-1">
        {showHint && (
          <kbd
            aria-hidden
            className="pointer-events-none inline-flex h-4 items-center justify-center rounded border border-foreground/10 px-1 font-mono text-[10px] text-muted-foreground"
          >
            {isMac() ? "⌘F" : "Ctrl F"}
          </kbd>
        )}
        {showFeedback && (
          <>
            <span
              id={counterId}
              data-testid="match-counter"
              className="text-[11px] tabular-nums text-muted-foreground select-none whitespace-nowrap"
            >
              {counterText}
            </span>
            <button
              type="button"
              aria-label="Previous match (Shift+Enter)"
              disabled={n === 0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => goToRelative(-1)}
              className={cn(
                "size-5 shrink-0 inline-flex items-center justify-center rounded text-muted-foreground",
                "hover:bg-white/[0.07] disabled:opacity-40 disabled:pointer-events-none",
              )}
            >
              <ChevronUp size={13} />
            </button>
            <button
              type="button"
              aria-label="Next match (Enter)"
              disabled={n === 0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => goToRelative(1)}
              className={cn(
                "size-5 shrink-0 inline-flex items-center justify-center rounded text-muted-foreground",
                "hover:bg-white/[0.07] disabled:opacity-40 disabled:pointer-events-none",
              )}
            >
              <ChevronDown size={13} />
            </button>
          </>
        )}
      </div>

      <span className="sr-only" aria-live="polite">
        {liveMessage}
      </span>
    </div>
  );
}
