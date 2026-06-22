/// <reference lib="webworker" />
// Generic plugin sandbox runtime. Kept for crash/hang isolation (not security):
// the host kills it on timeout so a runaway plugin can't freeze the UI.
//
// Protocol:
//   host → worker:  { type: "run", code, commandId, ctx, inputs }
//   worker → host:  { type: "api", callId, method, args }
//   host → worker:  { type: "api-result", callId, ok, value?, error? }
//   worker → host:  { type: "done", ok, result?, error? }

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const pending = new Map<number, PendingCall>();
let nextCallId = 1;

/** Build the `api` object handed to plugins: any method call is forwarded to the host. */
function makeApi(): unknown {
  return new Proxy(
    {},
    {
      get(_target, method: string) {
        return (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            const callId = nextCallId++;
            pending.set(callId, { resolve, reject });
            self.postMessage({ type: "api", callId, method, args });
          });
      },
    },
  );
}

async function loadModule(code: string): Promise<Record<string, unknown>> {
  // Import the plugin source as an ES module via a blob URL. Plugins must be
  // self-contained (no bare imports — there is no module resolver here).
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(url);
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "api-result") {
    const p = pending.get(msg.callId);
    if (!p) return;
    pending.delete(msg.callId);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(String(msg.error)));
    return;
  }

  if (msg.type === "run") {
    try {
      const mod = await loadModule(msg.code);
      const commands = mod.commands as Record<string, Function> | undefined;
      const handler = commands?.[msg.commandId];
      if (typeof handler !== "function") {
        throw new Error(`Plugin does not export a command "${msg.commandId}".`);
      }
      const api = makeApi();
      const result = await handler(msg.ctx, api, msg.inputs ?? {});
      self.postMessage({ type: "done", ok: true, result });
    } catch (err) {
      self.postMessage({ type: "done", ok: false, error: String(err instanceof Error ? err.message : err) });
    }
  }
};
