import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";

const STORE_KEY = "recent_repos";
const MAX_RECENT = 10;

async function persistRecent(path: string) {
  const store = await load("waypoint.json", { defaults: {} });
  const current = (await store.get<string[]>(STORE_KEY)) ?? [];
  const updated = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT);
  await store.set(STORE_KEY, updated);
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const { switchTab, closeTab, openTab } = useStore();

  async function handleOpenNew() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Open Repository",
    });
    if (!selected) return;
    const path = selected as string;
    try {
      const id = await ipc.openRepo(path);
      await persistRecent(path);
      openTab(id, path);
    } catch {
      // Non-git directory — silently ignore; the user will see no tab opened.
    }
  }

  return (
    <div className="flex items-end h-9 bg-muted/10 border-b border-border shrink-0 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => switchTab(tab.id)}
            className={[
              "group relative flex items-center gap-2 h-full pl-3 pr-2 min-w-0 max-w-52",
              "border-r border-border cursor-pointer shrink-0 select-none",
              isActive
                ? "bg-background text-foreground after:absolute after:bottom-0 after:inset-x-0 after:h-0.5 after:bg-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/20",
            ].join(" ")}
          >
            {/* Top accent line on active tab */}
            {isActive && (
              <span className="absolute top-0 inset-x-0 h-0.5 bg-primary rounded-b-full" />
            )}

            {/* Repo folder name */}
            <span className="truncate text-xs font-medium">{tab.label}</span>

            {/* Close button — always visible on active, hover-visible on inactive */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              aria-label={`Close ${tab.label}`}
              className={[
                "shrink-0 flex items-center justify-center w-4 h-4 rounded",
                "text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-opacity",
                isActive ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
              ].join(" ")}
            >
              ✕
            </button>
          </div>
        );
      })}

      {/* New-tab button */}
      <button
        onClick={handleOpenNew}
        aria-label="Open repository in new tab"
        className="flex items-center justify-center h-full px-3 text-muted-foreground hover:text-foreground hover:bg-muted/20 shrink-0 transition-colors text-sm"
      >
        +
      </button>
    </div>
  );
}
