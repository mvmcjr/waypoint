import { useState, useEffect, useCallback } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/lib/store";
import { TabBar } from "@/components/tabs/TabBar";
import { WelcomeScreen } from "@/routes/welcome";
import { RepoView } from "@/routes/repo";
import { CommandPalette } from "@/components/CommandPalette";

const queryClient = new QueryClient();

function Inner() {
  const activeTabId = useStore((s) => s.activeTabId);
  const hasTabs = useStore((s) => s.tabs.length > 0);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const togglePalette = useCallback(() => setPaletteOpen((v) => !v), []);

  useEffect(() => {
    const shortcut = "CommandOrControl+Shift+P";
    register(shortcut, (e) => { if (e.state === "Pressed") togglePalette(); }).catch(console.error);
    return () => { unregister(shortcut).catch(console.error); };
  }, [togglePalette]);

  return (
    <>
      {hasTabs && <TabBar />}
      {activeTabId ? <RepoView /> : <WelcomeScreen />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
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
