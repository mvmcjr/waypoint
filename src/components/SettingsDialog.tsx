import { useState, useEffect } from "react";
import { useStore } from "@/lib/store";
import { ipc } from "@/lib/ipc";
import { load } from "@tauri-apps/plugin-store";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Sliders, HelpCircle, Terminal, RefreshCw, AlertCircle, Puzzle } from "lucide-react";
import { PluginsSettings } from "@/components/plugins/PluginsSettings";

type SettingsTab = "general" | "integrations" | "plugins" | "about";

export function SettingsDialog() {
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [isWin, setIsWin] = useState(false);

  // ── Explorer context menu (Windows only) ──────────────────────────────────
  const [contextMenuEnabled, setContextMenuEnabled] = useState(false);
  const [savingCtx, setSavingCtx] = useState(false);

  // ── CLI shim (all platforms) ──────────────────────────────────────────────
  const [shimInstalled, setShimInstalled] = useState(false);
  const [savingShim, setSavingShim] = useState(false);
  const [shimPath, setShimPath] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [shimError, setShimError] = useState<string | null>(null);

  // One-time init: platform detection + context-menu stored preference +
  // event listener for cross-view sync.
  useEffect(() => {
    let active = true;
    ipc.isWindows().then(async (win) => {
      if (!active) return;
      setIsWin(win);
      if (win) {
        try {
          const store = await load("waypoint.json", { defaults: {} });
          const enabled = (await store.get<boolean>("context_menu_enabled")) ?? false;
          if (active) setContextMenuEnabled(enabled);
        } catch (err) {
          console.error("Failed to load settings:", err);
        }
      }
    });

    const handleSync = (e: Event) => {
      if (active) {
        const isEnabled = (e as CustomEvent<boolean>).detail;
        setContextMenuEnabled(isEnabled);
      }
    };
    window.addEventListener("context-menu-preference-updated", handleSync);

    return () => {
      active = false;
      window.removeEventListener("context-menu-preference-updated", handleSync);
    };
  }, []);

  // Re-check shim state every time the dialog is opened.
  // The component renders null when closed (not unmounted), so the one-time
  // effect above would never re-run — leaving shimInstalled permanently stale
  // if the shim was added or removed externally between openings.
  useEffect(() => {
    if (!settingsOpen) return;
    ipc.checkCliShim().then(setShimInstalled).catch(() => {});
  }, [settingsOpen]);

  async function handleToggleContextMenu(checked: boolean) {
    setSavingCtx(true);
    try {
      await ipc.registerExplorerContextMenu(checked);
      const store = await load("waypoint.json", { defaults: {} });
      await store.set("context_menu_asked", true);
      await store.set("context_menu_enabled", checked);
      await store.save();
      setContextMenuEnabled(checked);

      window.dispatchEvent(
        new CustomEvent("context-menu-preference-updated", { detail: checked })
      );
    } catch (err) {
      console.error("Failed to update context menu integration:", err);
    } finally {
      setSavingCtx(false);
    }
  }

  async function handleToggleCliShim(checked: boolean) {
    setSavingShim(true);
    setNeedsRestart(false);
    setShimError(null);
    try {
      if (checked) {
        const info = await ipc.registerCliShim();
        setShimInstalled(true);
        setShimPath(info.shim_path);
        setNeedsRestart(info.path_was_updated);
      } else {
        await ipc.unregisterCliShim();
        setShimInstalled(false);
        setShimPath(null);
        setNeedsRestart(false);
      }
    } catch (err) {
      console.error("Failed to toggle CLI shim:", err);
      setShimError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingShim(false);
    }
  }

  if (!settingsOpen) return null;

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent showCloseButton className="sm:max-w-[720px] h-[460px] p-0 gap-0 overflow-hidden flex flex-row rounded-xl border border-foreground/10 bg-popover text-popover-foreground shadow-2xl">
        {/* Left Sidebar */}
        <div className="w-[200px] bg-muted/20 border-r border-border/80 flex flex-col pt-10 pb-4">
          <div className="px-4 mb-4 select-none">
            <span className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-[0.14em]">
              Preferences
            </span>
          </div>
          <nav className="flex-1 px-2 space-y-0.5">
            <button
              onClick={() => setActiveTab("general")}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-left cursor-pointer transition-colors ${
                activeTab === "general"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/10"
              }`}
            >
              <Sliders className="size-3.5" />
              General
            </button>
            <button
              onClick={() => setActiveTab("integrations")}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-left cursor-pointer transition-colors ${
                activeTab === "integrations"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/10"
              }`}
            >
              <Terminal className="size-3.5" />
              Integrations
            </button>
            <button
              onClick={() => setActiveTab("plugins")}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-left cursor-pointer transition-colors ${
                activeTab === "plugins"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/10"
              }`}
            >
              <Puzzle className="size-3.5" />
              Plugins
            </button>
            <button
              onClick={() => setActiveTab("about")}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-left cursor-pointer transition-colors ${
                activeTab === "about"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/10"
              }`}
            >
              <HelpCircle className="size-3.5" />
              About
            </button>
          </nav>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 flex flex-col h-full bg-background pt-10 px-6 pb-6 overflow-y-auto">
          {activeTab === "general" && (
            <div className="space-y-5 animate-in fade-in-50 duration-150">
              <div>
                <h3 className="text-sm font-semibold text-foreground">General Settings</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">Configure global Waypoint options.</p>
              </div>

              <div className="space-y-4 pt-2">
                <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/10">
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-foreground">Theme</span>
                    <p className="text-[10px] text-muted-foreground">The application color mode.</p>
                  </div>
                  <span className="text-[11px] text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded border border-border/20">
                    Dark Mode
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/10">
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-foreground">Git Path</span>
                    <p className="text-[10px] text-muted-foreground">The Git executable used by Waypoint.</p>
                  </div>
                  <span className="text-[11px] text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded border border-border/20">
                    System Default
                  </span>
                </div>
              </div>
            </div>
          )}

          {activeTab === "integrations" && (
            <div className="space-y-5 animate-in fade-in-50 duration-150">
              <div>
                <h3 className="text-sm font-semibold text-foreground">System Integrations</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">Connect Waypoint with your local desktop environment.</p>
              </div>

              <div className="space-y-3 pt-2">
                {/* ── CLI Shim ─────────────────────────────────────────── */}
                <div className="rounded-lg border border-border/40 bg-muted/10 overflow-hidden">
                  <div className="flex items-start justify-between p-3.5 gap-4">
                    <div className="space-y-1 min-w-0">
                      <span className="text-xs font-medium text-foreground">Terminal Command</span>
                      <p className="text-[10px] text-muted-foreground leading-normal max-w-sm">
                        Register <code className="font-mono bg-muted/60 px-1 py-0.5 rounded text-foreground/80">waypoint</code> as a shell command.
                        Use <code className="font-mono bg-muted/60 px-1 py-0.5 rounded text-foreground/80">waypoint .</code> or{" "}
                        <code className="font-mono bg-muted/60 px-1 py-0.5 rounded text-foreground/80">waypoint ~/projects/foo</code> to open a
                        repository directly from any terminal.
                      </p>
                      {shimInstalled && shimPath && (
                        <p className="text-[10px] text-muted-foreground/60 font-mono truncate pt-0.5" title={shimPath}>
                          {shimPath}
                        </p>
                      )}
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer select-none shrink-0 mt-0.5">
                      <input
                        type="checkbox"
                        checked={shimInstalled}
                        disabled={savingShim}
                        onChange={(e) => handleToggleCliShim(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-8 h-4.5 bg-muted rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-foreground/70 peer-checked:after:bg-background after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-primary border border-border/30 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50" />
                    </label>
                  </div>

                  {/* Terminal-restart notice */}
                  {needsRestart && (
                    <div className="flex items-center gap-2 px-3.5 py-2 border-t border-border/40 bg-primary/5">
                      <RefreshCw className="size-3 text-primary shrink-0" />
                      <p className="text-[10px] text-primary/80 leading-normal">
                        Restart your terminal (or open a new tab) for{" "}
                        <code className="font-mono">waypoint</code> to appear in your PATH.
                      </p>
                    </div>
                  )}

                  {/* Error notice */}
                  {shimError && (
                    <div className="flex items-start gap-2 px-3.5 py-2 border-t border-border/40 bg-destructive/5">
                      <AlertCircle className="size-3 text-destructive shrink-0 mt-0.5" />
                      <p className="text-[10px] text-destructive/80 leading-normal break-all">
                        {shimError}
                      </p>
                    </div>
                  )}
                </div>

                {/* ── Windows Explorer Context Menu ─────────────────────── */}
                {isWin && (
                  <div className="flex items-start justify-between p-3.5 rounded-lg border border-border/40 bg-muted/10 gap-4">
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-foreground">Explorer Context Menu</span>
                      <p className="text-[10px] text-muted-foreground leading-normal max-w-sm">
                        Adds a right-click <strong className="text-foreground/80">&quot;Open in Waypoint&quot;</strong> item to folders
                        and directory backgrounds in Windows Explorer.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer select-none shrink-0 mt-0.5">
                      <input
                        type="checkbox"
                        checked={contextMenuEnabled}
                        disabled={savingCtx}
                        onChange={(e) => handleToggleContextMenu(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-8 h-4.5 bg-muted rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-foreground/70 peer-checked:after:bg-background after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-primary border border-border/30 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50" />
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "plugins" && <PluginsSettings />}

          {activeTab === "about" && (
            <div className="space-y-6 flex flex-col h-full animate-in fade-in-50 duration-150">
              <div className="flex-1 flex flex-col items-center justify-center pt-4 text-center">
                <div className="size-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-4 font-bold text-lg select-none">
                  W
                </div>
                <h3 className="text-base font-semibold text-foreground tracking-tight">Waypoint</h3>
                <span className="text-[10px] font-mono text-muted-foreground mt-0.5">v0.1.0 (Beta)</span>
                <p className="text-xs text-muted-foreground mt-3 leading-relaxed max-w-xs">
                  A beautiful, lightweight, local-first Git client. Fully client-side, zero accounts required.
                </p>
              </div>

              <div className="mt-auto border-t border-border/40 pt-4 flex justify-between items-center text-[10px] text-muted-foreground select-none shrink-0">
                <span>Designed for Developers</span>
                <span>© 2026 Waypoint contributors</span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
