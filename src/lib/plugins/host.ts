import SandboxWorker from "./sandbox.worker?worker";
import type { PluginContext } from "./types";
import type { ApiHandlers } from "./api";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run one plugin command inside a fresh worker, mediating its `api` calls
 * through `handlers`. The worker is terminated when the command finishes or the
 * timeout elapses (so a hung plugin can't leak or block).
 */
export function runInWorker(opts: {
  code: string;
  commandId: string;
  ctx: PluginContext;
  inputs: Record<string, unknown>;
  handlers: ApiHandlers;
  timeoutMs?: number;
}): Promise<unknown> {
  const { code, commandId, ctx, inputs, handlers, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  return new Promise((resolve, reject) => {
    const worker = new SandboxWorker();
    let settled = false;

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Plugin timed out after ${Math.round(timeoutMs / 1000)}s.`)));
    }, timeoutMs);

    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      action();
    }

    worker.onmessage = async (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === "api") {
        const handler = handlers[msg.method];
        if (!handler) {
          worker.postMessage({
            type: "api-result",
            callId: msg.callId,
            ok: false,
            error: `Unknown api method "${msg.method}".`,
          });
          return;
        }
        try {
          const value = await handler(...(msg.args ?? []));
          worker.postMessage({ type: "api-result", callId: msg.callId, ok: true, value });
        } catch (err) {
          worker.postMessage({
            type: "api-result",
            callId: msg.callId,
            ok: false,
            error: String(err instanceof Error ? err.message : err),
          });
        }
        return;
      }

      if (msg.type === "done") {
        if (msg.ok) finish(() => resolve(msg.result));
        else finish(() => reject(new Error(String(msg.error))));
      }
    };

    worker.onerror = (e) => finish(() => reject(new Error(e.message || "Plugin worker error.")));

    worker.postMessage({ type: "run", code, commandId, ctx, inputs });
  });
}
