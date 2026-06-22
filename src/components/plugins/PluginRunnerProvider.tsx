import { createContext, useCallback, useContext, useRef, useState } from "react";
import { toast } from "sonner";
import { useStore } from "@/lib/store";
import { useHeadInfo, useRefreshRepo } from "@/lib/queries";
import { usePluginRegistry } from "@/lib/plugins/registry";
import { runInWorker } from "@/lib/plugins/host";
import { buildApiHandlers } from "@/lib/plugins/api";
import type { CommandContribution, InputField, PluginContext, Surface } from "@/lib/plugins/types";
import { PluginInputDialog } from "./PluginInputDialog";

interface RunnerContextValue {
  /** Run a plugin command. `extra` supplies surface-specific context (commitOid, branchName). */
  run: (
    pluginId: string,
    command: CommandContribution,
    surface: Surface,
    extra?: Partial<PluginContext>,
  ) => Promise<void>;
}

const RunnerContext = createContext<RunnerContextValue | null>(null);

export function usePluginRunner(): RunnerContextValue {
  const ctx = useContext(RunnerContext);
  if (!ctx) throw new Error("usePluginRunner must be used within PluginRunnerProvider");
  return ctx;
}

interface DialogState {
  title: string;
  fields: InputField[];
  resolve: (values: Record<string, unknown> | null) => void;
}

export function PluginRunnerProvider({ children }: { children: React.ReactNode }) {
  const activeTabId = useStore((s) => s.activeTabId);
  const { data: head } = useHeadInfo(activeTabId);
  const refresh = useRefreshRepo(activeTabId);
  const plugins = usePluginRegistry((s) => s.plugins);

  const [dialog, setDialog] = useState<DialogState | null>(null);

  // Keep the latest values in refs so `run` stays stable across renders.
  const headRef = useRef(head);
  headRef.current = head;
  const repoIdRef = useRef(activeTabId);
  repoIdRef.current = activeTabId;
  const pluginsRef = useRef(plugins);
  pluginsRef.current = plugins;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const openDialog = useCallback(
    (title: string, fields: InputField[]) =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        setDialog({ title, fields, resolve });
      }),
    [],
  );

  const run = useCallback<RunnerContextValue["run"]>(
    async (pluginId, command, surface, extra) => {
      const repoId = repoIdRef.current;
      if (!repoId) {
        toast.error("Open a repository first.");
        return;
      }
      const plugin = pluginsRef.current.find((p) => p.id === pluginId);
      if (!plugin) {
        toast.error("Plugin not found.");
        return;
      }

      const ctx: PluginContext = {
        repoId,
        headOid: headRef.current?.oid ?? null,
        headBranch: headRef.current?.branch ?? null,
        surface,
        ...extra,
      };

      let inputs: Record<string, unknown> = {};
      if (command.inputs && command.inputs.length > 0) {
        const values = await openDialog(command.title, command.inputs);
        if (values === null) return; // cancelled
        inputs = values;
      }

      const handlers = buildApiHandlers(ctx, {
        prompt: (fields) => openDialog(command.title, fields),
        notify: (msg) => toast(msg),
      });

      try {
        const result = await runInWorker({ code: plugin.code, commandId: command.id, ctx, inputs, handlers });
        toast.success(typeof result === "string" && result ? result : `${command.title} ✓`);
        refreshRef.current();
      } catch (e) {
        toast.error(`${command.title}: ${String(e instanceof Error ? e.message : e)}`);
      }
    },
    [openDialog],
  );

  return (
    <RunnerContext.Provider value={{ run }}>
      {children}
      {dialog && (
        <PluginInputDialog
          title={dialog.title}
          fields={dialog.fields}
          onSubmit={(values) => {
            dialog.resolve(values);
            setDialog(null);
          }}
          onCancel={() => {
            dialog.resolve(null);
            setDialog(null);
          }}
        />
      )}
    </RunnerContext.Provider>
  );
}
