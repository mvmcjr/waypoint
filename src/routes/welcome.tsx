import { useState, useEffect, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Settings } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { getRecentRepos } from "@/lib/recentRepos";
import { useOpenRepo } from "@/lib/useOpenRepo";
import { repoLabel, truncatePath } from "@/lib/utils";
import { useStore } from "@/lib/store";

const PINNED_COUNT = 5;

export function WelcomeScreen() {
  const openRepo = useOpenRepo();
  const [recent, setRecent] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getRecentRepos().then(setRecent);
  }, []);

  // getStartupPath is consumed once; cancellation guard prevents stale setState after unmount
  useEffect(() => {
    let cancelled = false;
    ipc.getStartupPath().then((path) => { if (!cancelled && path) handleOpen(path); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleOpen(path: string) {
    setError(null);
    try {
      const updated = await openRepo(path);
      setRecent(updated);
    } catch (e) {
      setError(String(e));
    }
  }

  async function pickFolder() {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open Repository" });
    if (selected) await handleOpen(selected as string);
  }

  const isSearching = filter.length > 0;
  const visible = isSearching
    ? recent.filter((p) => p.toLowerCase().includes(filter.toLowerCase()))
    : recent.slice(0, PINNED_COUNT);

  return (
    <div className="flex flex-col h-full overflow-hidden select-none">
      <div className="flex flex-col items-center gap-6 pt-16 pb-8 shrink-0">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground">Waypoint</h1>
          <p className="text-muted-foreground mt-2">A local Git GUI, no account required.</p>
        </div>
        <Button size="lg" onClick={pickFolder}>
          Open Repository
        </Button>
        {error && (
          <p className="text-sm text-destructive max-w-sm text-center">{error}</p>
        )}
      </div>

      {recent.length > 0 && (
        <div className="flex flex-col min-h-0 flex-1 w-full max-w-sm mx-auto px-4 pb-8">
          <div className="relative shrink-0 mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/40 pointer-events-none" />
            <Input
              ref={filterRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Search ${recent.length} recent repos…`}
              className="pl-8"
            />
          </div>

          <ul className="overflow-y-auto min-h-0 space-y-0.5">
            {visible.map((path) => (
              <li key={path}>
                <button
                  className="w-full text-left px-3 py-2 rounded hover:bg-white/5 min-w-0"
                  onClick={() => handleOpen(path)}
                >
                  <div className="text-sm font-medium text-foreground/85 truncate">{repoLabel(path)}</div>
                  <div className="text-[11px] font-mono text-muted-foreground/45 truncate">
                    {truncatePath(path, 48)}
                  </div>
                </button>
              </li>
            ))}
            {isSearching && visible.length === 0 && (
              <li className="px-3 py-6 text-sm text-muted-foreground/50 text-center">
                No matches
              </li>
            )}
            {!isSearching && recent.length > PINNED_COUNT && (
              <li>
                <button
                  className="w-full text-left px-3 py-2 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  onClick={() => filterRef.current?.focus()}
                >
                  +{recent.length - PINNED_COUNT} more — search to find them
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="mt-auto pb-6 flex justify-center shrink-0">
        <button
          onClick={() => useStore.getState().setSettingsOpen(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground/35 hover:text-muted-foreground/75 cursor-pointer transition-all duration-150 select-none px-2.5 py-1 rounded-md hover:bg-muted/40 border border-transparent hover:border-border/10"
        >
          <Settings className="size-3.5 animate-[spin_8s_linear_infinite] hover:animate-[spin_2s_linear_infinite]" />
          <span>Preferences & Settings</span>
        </button>
      </div>
    </div>
  );
}
