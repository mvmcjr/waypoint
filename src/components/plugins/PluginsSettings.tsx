import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Trash2, RefreshCw, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePluginRegistry } from "@/lib/plugins/registry";
import { installPlugin } from "@/lib/plugins/install";

export function PluginsSettings() {
  const plugins = usePluginRegistry((s) => s.plugins);
  const upsert = usePluginRegistry((s) => s.upsert);
  const remove = usePluginRegistry((s) => s.remove);
  const setEnabled = usePluginRegistry((s) => s.setEnabled);

  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doInstall(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const plugin = await installPlugin(trimmed);
      await upsert(plugin);
      setSource("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function browseFolder() {
    const picked = await openDialog({ directory: true, multiple: false, title: "Select Plugin Folder" });
    if (picked) await doInstall(picked as string);
  }

  async function reinstall(sourceStr: string) {
    setBusy(true);
    setError(null);
    try {
      const plugin = await installPlugin(sourceStr);
      await upsert(plugin);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 animate-in fade-in-50 duration-150">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Plugins</h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Extend Waypoint with custom actions. Install from a GitHub repo (<code className="font-mono">owner/repo</code>)
          or a local folder. Plugins run with full access — only install ones you trust.
        </p>
      </div>

      {/* Install row */}
      <div className="flex items-center gap-2">
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doInstall(source)}
          placeholder="owner/repo  or  owner/repo@ref"
          className="h-8 text-xs"
          disabled={busy}
        />
        <Button size="sm" className="h-8 text-xs shrink-0" disabled={busy || !source.trim()} onClick={() => doInstall(source)}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Install"}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs shrink-0 gap-1" disabled={busy} onClick={browseFolder}>
          <FolderOpen className="size-3.5" />
          Folder…
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-destructive/30 bg-destructive/5">
          <AlertCircle className="size-3.5 text-destructive shrink-0 mt-0.5" />
          <p className="text-[11px] text-destructive/90 leading-normal break-words">{error}</p>
        </div>
      )}

      {/* Installed list */}
      <div className="space-y-2">
        {plugins.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60 text-center py-6">No plugins installed.</p>
        ) : (
          plugins.map((p) => (
            <div key={p.id} className="rounded-lg border border-border/40 bg-muted/10 p-3 flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground truncate">{p.manifest.name}</span>
                  {p.manifest.version && (
                    <span className="text-[10px] font-mono text-muted-foreground/60">v{p.manifest.version}</span>
                  )}
                </div>
                {p.manifest.description && (
                  <p className="text-[10px] text-muted-foreground leading-normal">{p.manifest.description}</p>
                )}
                <p className="text-[10px] font-mono text-muted-foreground/50 truncate" title={p.source}>
                  {p.source} · {p.manifest.contributes.commands.length} command
                  {p.manifest.contributes.commands.length === 1 ? "" : "s"}
                </p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  title="Reinstall / update"
                  disabled={busy}
                  onClick={() => reinstall(p.source)}
                  className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                >
                  <RefreshCw className="size-3.5" />
                </button>
                <button
                  title="Remove"
                  onClick={() => remove(p.id)}
                  className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="size-3.5" />
                </button>
                <label className="relative inline-flex items-center cursor-pointer select-none ml-1">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => setEnabled(p.id, e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-8 h-4.5 bg-muted rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-foreground/70 peer-checked:after:bg-background after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-primary border border-border/30" />
                </label>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
