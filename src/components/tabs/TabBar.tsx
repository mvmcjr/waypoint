import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderGit2 } from "lucide-react";
import { useStore, tabLabels } from "@/lib/store";
import { repoLabel } from "@/lib/utils";
import { useOpenRepo } from "@/lib/useOpenRepo";

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const { switchTab, closeTab } = useStore();
  const openRepo = useOpenRepo();
  const labels = tabLabels(tabs);

  async function handleOpenNew() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Open Repository",
    });
    if (!selected) return;
    try {
      await openRepo(selected as string);
    } catch {
      // Non-git directory — silently ignore; the user will see no tab opened.
    }
  }

  return (
    <div className="flex items-end h-9 bg-muted/10 border-b border-border shrink-0 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = labels.get(tab.id) ?? tab.label;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-label={tab.mainPath ? `${label}, worktree of ${repoLabel(tab.mainPath)}` : undefined}
            title={tab.path}
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

            {/* Linked-worktree glyph */}
            {tab.mainPath && <FolderGit2 size={11} className="shrink-0 opacity-60" />}

            {/* Repo folder name */}
            <span className="truncate text-xs font-medium">{label}</span>

            {/* Close button — always visible on active, hover-visible on inactive */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              aria-label={`Close ${label}`}
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

      {/* Spacer to push everything else to the right */}
      <div className="flex-grow min-w-4" />

      {/* Settings button */}
      <button
        onClick={() => useStore.getState().setSettingsOpen(true)}
        aria-label="Open settings"
        className="flex items-center justify-center h-full px-3 text-muted-foreground hover:text-foreground hover:bg-muted/20 shrink-0 transition-colors text-xs border-l border-border/40"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3.5 animate-[spin_12s_linear_infinite] hover:animate-[spin_3s_linear_infinite]"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
  );
}
