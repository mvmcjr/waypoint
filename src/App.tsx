import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/lib/store";
import { TabBar } from "@/components/tabs/TabBar";
import { WelcomeScreen } from "@/routes/welcome";
import { RepoView } from "@/routes/repo";

const queryClient = new QueryClient();

function Inner() {
  const activeTabId = useStore((s) => s.activeTabId);
  const hasTabs = useStore((s) => s.tabs.length > 0);

  return (
    <>
      {hasTabs && <TabBar />}
      {activeTabId ? <RepoView /> : <WelcomeScreen />}
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
