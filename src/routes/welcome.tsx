import { useState, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";

const STORE_KEY = "recent_repos";
const MAX_RECENT = 10;

async function getStore() {
  return load("waypoint.json", { defaults: {} });
}

export function WelcomeScreen() {
  const { openTab } = useStore();
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStore().then((s) => s.get<string[]>(STORE_KEY)).then((r) => {
      if (r) setRecent(r);
    });
  }, []);

  async function openRepo(path: string) {
    setError(null);
    try {
      const id = await ipc.openRepo(path);
      // Persist to recent list.
      const updated = [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
      const store = await getStore();
      await store.set(STORE_KEY, updated);
      setRecent(updated);
      openTab(id, path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function pickFolder() {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open Repository" });
    if (selected) await openRepo(selected as string);
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 select-none">
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

      {recent.length > 0 && (
        <div className="w-full max-w-sm">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Recent</p>
          <ul className="space-y-0.5">
            {recent.map((path) => {
              const sep = path.includes("/") ? "/" : "\\";
              const parts = path.split(sep).filter(Boolean);
              const name = parts[parts.length - 1] || path;
              const displayPath = path.length > 48 ? "…" + path.slice(-(47)) : path;
              return (
                <li key={path}>
                  <button
                    className="w-full text-left px-3 py-2 rounded hover:bg-white/5 min-w-0"
                    onClick={() => openRepo(path)}
                  >
                    <div className="text-sm font-medium text-foreground/85 truncate">{name}</div>
                    <div className="text-[11px] font-mono text-muted-foreground/45 truncate">
                      {displayPath}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
