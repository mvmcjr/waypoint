import { useState, useEffect, useCallback } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/lib/store";
import { TabBar } from "@/components/tabs/TabBar";
import { WelcomeScreen } from "@/routes/welcome";
import { RepoView } from "@/routes/repo";
import { CommandPalette } from "@/components/CommandPalette";
import { SettingsDialog } from "@/components/SettingsDialog";
import { load } from "@tauri-apps/plugin-store";
import { ipc } from "@/lib/ipc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const queryClient = new QueryClient();

function Inner() {
  const activeTabId = useStore((s) => s.activeTabId);
  const hasTabs = useStore((s) => s.tabs.length > 0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showConsentDialog, setShowConsentDialog] = useState(false);

  const togglePalette = useCallback(() => setPaletteOpen((v) => !v), []);

  const handleConsentChoice = async (confirmed: boolean) => {
    setShowConsentDialog(false);
    try {
      await ipc.registerExplorerContextMenu(confirmed);
      const store = await load("waypoint.json", { defaults: {} });
      await store.set("context_menu_asked", true);
      await store.set("context_menu_enabled", confirmed);
      await store.save();

      // Notify Welcome Screen of changes
      window.dispatchEvent(
        new CustomEvent("context-menu-preference-updated", { detail: confirmed })
      );
    } catch (err) {
      console.error("Failed to save context menu preference:", err);
    }
  };

  useEffect(() => {
    const shortcut = "CommandOrControl+Shift+P";
    register(shortcut, (e) => { if (e.state === "Pressed") togglePalette(); }).catch(console.error);
    return () => { unregister(shortcut).catch(console.error); };
  }, [togglePalette]);

  // Prompt Windows Explorer integration on startup if not yet asked
  useEffect(() => {
    let active = true;
    ipc.isWindows().then(async (isWin) => {
      if (!isWin || !active) return;
      try {
        const store = await load("waypoint.json", { defaults: {} });
        const asked = await store.get<boolean>("context_menu_asked");
        if (!asked && active) {
          setShowConsentDialog(true);
        }
      } catch (err) {
        console.error("Failed to check context menu on startup:", err);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      {hasTabs && <TabBar />}
      {activeTabId ? <RepoView /> : <WelcomeScreen />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <SettingsDialog />

      <Dialog open={showConsentDialog} onOpenChange={(o) => { if (!o) handleConsentChoice(false); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-[400px]">
          <DialogHeader className="gap-2">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0 border border-primary/20">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-4"
                >
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                </svg>
              </div>
              <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
                Explorer Integration
              </DialogTitle>
            </div>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground mt-2">
              Would you like to add <strong className="text-foreground font-semibold">&quot;Open in Waypoint&quot;</strong> to your Windows Explorer context menu?
              <br /><br />
              This adds a right-click shortcut on folders and folder backgrounds so you can open repositories instantly in Waypoint.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => handleConsentChoice(false)}
            >
              Skip
            </Button>
            <Button
              variant="default"
              onClick={() => handleConsentChoice(true)}
            >
              Enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="h-screen w-screen flex flex-col bg-background text-foreground dark overflow-hidden">
          <Inner />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
