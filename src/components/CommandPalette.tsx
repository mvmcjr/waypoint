import { useState, useEffect, useRef, useCallback } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { FolderOpen, Search, ArrowLeft, ExternalLink, Download, Settings, Puzzle } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { cn, repoLabel, truncatePath } from "@/lib/utils";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { useOpenRepo } from "@/lib/useOpenRepo";
import { getRecentRepos, addManyToRecentRepos } from "@/lib/recentRepos";
import { usePluginRegistry, commandsForSurface } from "@/lib/plugins/registry";
import { usePluginRunner } from "@/components/plugins/PluginRunnerProvider";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Mode = "commands" | "repo-picker";

interface CommandDef {
  id: string;
  label: string;
  icon: React.ElementType;
  disabled?: boolean;
  execute: () => void | Promise<void>;
}

function explorerName(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Mac OS X")) return "Finder";
  if (ua.includes("Linux")) return "Files";
  return "Explorer";
}

export function CommandPalette({ open, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("commands");
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [repos, setRepos] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const openRepoAndRecent = useOpenRepo();
  const pluginList = usePluginRegistry((s) => s.plugins);
  const runner = usePluginRunner();

  useEffect(() => {
    if (open) {
      setMode("commands");
      setQuery("");
      setSelectedIdx(0);
      setFeedback(null);
      getRecentRepos().then(setRepos);
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      // Small delay lets BaseUI finish its own focus management first
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open, mode]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, mode]);

  const goBack = useCallback(() => {
    setMode("commands");
    setQuery("");
    setSelectedIdx(0);
  }, []);

  async function openRepo(path: string) {
    try {
      const updated = await openRepoAndRecent(path);
      setRepos(updated);
      onClose();
    } catch (e) {
      setFeedback(`Failed to open: ${String(e)}`);
    }
  }

  async function pickRepo() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Open Repository",
    });
    if (picked) await openRepo(picked as string);
  }

  async function openInExplorer() {
    if (!activeTab) return;
    await revealItemInDir(activeTab.path);
    onClose();
  }

  async function scanAndLoad() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Folder to Scan for Repos",
    });
    if (!picked) return;
    setFeedback("Scanning…");
    try {
      const found = await ipc.scanForGitRepos(picked as string);
      if (!found.length) {
        setFeedback("No git repositories found.");
        setTimeout(onClose, 1800);
        return;
      }
      const updated = await addManyToRecentRepos(found);
      setRepos(updated);
      setFeedback(`Added ${found.length} repo${found.length === 1 ? "" : "s"} to recent.`);
      setTimeout(onClose, 1800);
    } catch (e) {
      setFeedback(`Error: ${String(e)}`);
    }
  }

  const commands: CommandDef[] = [
    {
      id: "open-repo",
      label: "Open Repo",
      icon: FolderOpen,
      execute: () => {
        setMode("repo-picker");
        setQuery("");
      },
    },
    {
      id: "open-in-explorer",
      label: `Open in ${explorerName()}`,
      icon: ExternalLink,
      disabled: !activeTab,
      execute: openInExplorer,
    },
    {
      id: "load-recent",
      label: "Load Repos into Recent",
      icon: Download,
      execute: scanAndLoad,
    },
    {
      id: "open-settings",
      label: "Preferences: Open Settings",
      icon: Settings,
      execute: () => {
        useStore.getState().setSettingsOpen(true);
        onClose();
      },
    },
  ];

  const pluginCommands: CommandDef[] = commandsForSurface(pluginList, "commandPalette").map(
    ({ pluginId, command }) => ({
      id: `plugin:${pluginId}:${command.id}`,
      label: command.title,
      icon: Puzzle,
      execute: () => {
        onClose();
        runner.run(pluginId, command, "commandPalette");
      },
    })
  );

  const filteredCommands = [...commands, ...pluginCommands].filter(
    (c) => !query || c.label.toLowerCase().includes(query.toLowerCase())
  );

  const filteredRepos = repos.filter(
    (p) => !query || p.toLowerCase().includes(query.toLowerCase())
  );

  // Keyboard handler lives on the Popup so it works regardless of which child has focus
  function handleKeyDown(e: React.KeyboardEvent) {
    const itemCount =
      mode === "commands"
        ? filteredCommands.length
        : filteredRepos.length + 1; // +1 for Browse

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, itemCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "commands") {
        const cmd = filteredCommands[selectedIdx];
        if (cmd && !cmd.disabled) cmd.execute();
      } else {
        if (selectedIdx < filteredRepos.length) {
          openRepo(filteredRepos[selectedIdx]);
        } else {
          pickRepo();
        }
      }
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/50 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        {/* `dark` class forces dark-theme CSS variables inside the Portal, which renders outside the app's .dark div */}
        <DialogPrimitive.Popup
          onKeyDown={handleKeyDown}
          className="dark fixed top-[18%] left-1/2 z-50 -translate-x-1/2 w-full max-w-[560px] rounded-xl border border-foreground/10 bg-popover text-popover-foreground shadow-2xl overflow-hidden outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <DialogPrimitive.Title className="sr-only">Command Palette</DialogPrimitive.Title>

          {/* Input row */}
          <div className="flex items-center gap-2 px-3 border-b border-foreground/8">
            {mode === "repo-picker" ? (
              <button
                tabIndex={-1}
                onClick={goBack}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground py-3 shrink-0 cursor-pointer transition-colors"
              >
                <ArrowLeft className="size-3" />
                Open Repo
              </button>
            ) : (
              <Search className="size-4 text-muted-foreground/50 shrink-0" />
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={mode === "commands" ? "Type a command…" : "Filter recent repos…"}
              className="flex-1 bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* List area */}
          <div className="max-h-[320px] overflow-y-auto">
            {feedback ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {feedback}
              </p>
            ) : mode === "commands" ? (
              <CommandItems
                commands={filteredCommands}
                selectedIdx={selectedIdx}
                onSelect={(cmd) => cmd.execute()}
                onHover={setSelectedIdx}
              />
            ) : (
              <RepoItems
                repos={filteredRepos}
                selectedIdx={selectedIdx}
                onSelect={openRepo}
                onBrowse={pickRepo}
                onHover={setSelectedIdx}
              />
            )}
          </div>

          {/* Footer hints */}
          {!feedback && (
            <div className="px-4 py-1.5 border-t border-foreground/6 flex items-center justify-end gap-4">
              <Hint keys={["↑", "↓"]} label="navigate" />
              <Hint keys={["↵"]} label="select" />
              <Hint keys={["Esc"]} label="close" />
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CommandItems({
  commands,
  selectedIdx,
  onSelect,
  onHover,
}: {
  commands: CommandDef[];
  selectedIdx: number;
  onSelect: (cmd: CommandDef) => void;
  onHover: (i: number) => void;
}) {
  if (!commands.length) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        No commands match
      </p>
    );
  }
  return (
    <ul className="py-1">
      {commands.map((cmd, i) => (
        <li key={cmd.id}>
          <button
            tabIndex={-1}
            disabled={cmd.disabled}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(cmd)}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors",
              i === selectedIdx
                ? "bg-muted text-foreground"
                : "text-foreground/70 hover:text-foreground hover:bg-muted/50",
              cmd.disabled
                ? "opacity-40 cursor-not-allowed pointer-events-none"
                : "cursor-pointer"
            )}
          >
            <cmd.icon className="size-4 text-muted-foreground shrink-0" />
            {cmd.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function RepoItems({
  repos,
  selectedIdx,
  onSelect,
  onBrowse,
  onHover,
}: {
  repos: string[];
  selectedIdx: number;
  onSelect: (path: string) => void;
  onBrowse: () => void;
  onHover: (i: number) => void;
}) {
  const browseIdx = repos.length;
  return (
    <ul className="py-1">
      {repos.length === 0 && (
        <li className="px-4 py-3 text-sm text-muted-foreground/60 text-center">
          No recent repositories
        </li>
      )}
      {repos.map((path, i) => (
        <li key={path}>
          <button
            tabIndex={-1}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(path)}
            className={cn(
              "w-full flex items-start gap-3 px-4 py-2.5 text-left cursor-pointer transition-colors",
              i === selectedIdx ? "bg-muted" : "hover:bg-muted/50"
            )}
          >
            <FolderOpen className="size-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm text-foreground/85 truncate">{repoLabel(path)}</div>
              <div className="text-[11px] font-mono text-muted-foreground/50 truncate">
                {truncatePath(path)}
              </div>
            </div>
          </button>
        </li>
      ))}
      {repos.length > 0 && (
        <li className="mx-4 my-1 h-px bg-border" />
      )}
      <li>
        <button
          tabIndex={-1}
          onMouseEnter={() => onHover(browseIdx)}
          onClick={onBrowse}
          className={cn(
            "w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left cursor-pointer transition-colors",
            browseIdx === selectedIdx
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
        >
          <FolderOpen className="size-4 text-muted-foreground shrink-0" />
          Browse for Repository…
        </button>
      </li>
    </ul>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-1 text-muted-foreground/40 text-[10px]">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex h-4 items-center justify-center rounded border border-foreground/10 px-1 font-mono text-[9px]"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </div>
  );
}
