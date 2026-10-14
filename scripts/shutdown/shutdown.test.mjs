/**
 * shutdown.test.mjs
 *
 * Closing Waypoint must not leave a core dump behind, from the app or from any
 * WebKit helper it spawned.
 *
 * On Linux + NVIDIA, WebKitGTK's web process paints on "SkiaGPUWorker" threads.
 * When the window closes, the web process returns from main() and NVIDIA's EGL
 * atexit teardown runs on the main thread while those workers are still running
 * their own thread-exit cleanup through the driver; one of them can segfault in
 * libnvidia-eglcore. The crash is a race, so this test opens and closes the real
 * app several times and asks systemd-coredump whether any of our processes died.
 *
 * Linux/Wayland only, and skipped when WebKit never starts a SkiaGPUWorker (CPU
 * painting can't hit this race). It opens real windows on your desktop.
 *
 * Usage:
 *   pnpm test:shutdown
 *   SHUTDOWN_CYCLES=30 pnpm test:shutdown
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIfStale, e2eBinaryPath } from '../e2e/build.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CYCLES = Number(process.env.SHUTDOWN_CYCLES ?? 10);
const STARTUP_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 20_000;

const readProc = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** Parent pid and state from /proc/<pid>/stat; comm may contain spaces/parens. */
function stat(pid) {
  const s = readProc(`/proc/${pid}/stat`);
  if (!s) return null;
  const [state, ppid] = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return { state, ppid: Number(ppid) };
}

const comm = (pid) => readProc(`/proc/${pid}/comm`)?.trim() ?? null;
const alive = (pid) => ![undefined, 'Z', 'X'].includes(stat(pid)?.state);
const allPids = () => readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);

function descendants(root) {
  const byParent = new Map();
  for (const pid of allPids()) {
    const ppid = stat(pid)?.ppid;
    if (ppid !== undefined) byParent.set(ppid, [...(byParent.get(ppid) ?? []), pid]);
  }
  const out = [];
  const queue = [root];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

const threadNames = (pid) => {
  try {
    return readdirSync(`/proc/${pid}/task`).map((tid) => readProc(`/proc/${pid}/task/${tid}/comm`)?.trim());
  } catch {
    return [];
  }
};

async function waitFor(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Core dumps recorded since `sinceSec` for any of `pids`. The kernel starts the
 * systemd-coredump helper before the crashed process is gone, so once our
 * processes have exited we only need to wait for the helpers to finish; the
 * pipe helper hands off to a socket-activated service, so require a quiet
 * second rather than a single empty poll.
 */
async function coreDumpsFor(pids, sinceSec) {
  let quietSince = Date.now();
  await waitFor(() => {
    if (allPids().some((pid) => comm(pid)?.startsWith('systemd-coredum'))) quietSince = Date.now();
    return Date.now() - quietSince >= 1000;
  }, 60_000, 'systemd-coredump to finish');

  let json;
  try {
    json = execFileSync('coredumpctl', ['list', '--json=short', '--no-pager', `--since=@${sinceSec}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (err.status === 1) return []; // "No coredumps found."
    throw err;
  }
  const wanted = new Set(pids);
  return JSON.parse(json).filter((core) => wanted.has(core.pid));
}

const onHyprland = () => Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);

const hyprlandWindow = (pid) =>
  JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' })).find((c) => c.pid === pid)?.address;

/** Closes the window the way a user would; without Hyprland, SIGTERM drops the WebKit IPC the same way. */
function closeApp(pid) {
  if (!onHyprland()) return process.kill(pid, 'SIGTERM');
  const address = hyprlandWindow(pid);
  try {
    // Hyprland 0.56+ takes Lua dispatchers.
    execFileSync('hyprctl', ['dispatch', `hl.dsp.window.close({ window = "address:${address}" })`], { stdio: 'ignore' });
  } catch {
    execFileSync('hyprctl', ['dispatch', 'closewindow', `address:${address}`], { stdio: 'ignore' });
  }
}

/** Launches the app on this repo, waits for GPU painting, closes it. Returns every pid involved. */
async function openAndClose(binary) {
  const app = spawn(binary, [REPO_ROOT], { stdio: 'ignore' });
  const exited = new Promise((r) => app.once('exit', (code, signal) => r({ code, signal })));
  const seen = new Set([app.pid]);
  try {
    const webProcess = await waitFor(
      () => descendants(app.pid).find((pid) => comm(pid) === 'WebKitWebProces'),
      STARTUP_TIMEOUT_MS,
      'WebKitWebProcess to start',
    );
    const gpuPainting = await waitFor(
      () => threadNames(webProcess).includes('SkiaGPUWorker'),
      STARTUP_TIMEOUT_MS,
      'a SkiaGPUWorker thread in the web process',
    ).catch(() => false);
    if (onHyprland()) await waitFor(() => hyprlandWindow(app.pid), STARTUP_TIMEOUT_MS, 'the window to map');
    for (const pid of descendants(app.pid)) seen.add(pid);

    closeApp(app.pid);
    const exit = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('app did not exit after close')), EXIT_TIMEOUT_MS)),
    ]);
    await waitFor(() => [...seen].every((pid) => !alive(pid)), EXIT_TIMEOUT_MS, 'WebKit helpers to exit');
    return { pids: [...seen], gpuPainting, exit };
  } finally {
    if (alive(app.pid)) app.kill('SIGKILL');
  }
}

test(`closing the app ${CYCLES}x leaves no core dumps`, {
  skip: process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY ? 'needs a Linux Wayland session' : false,
  timeout: CYCLES * 90_000 + 300_000,
}, async (t) => {
  buildIfStale();
  const binary = e2eBinaryPath();
  const sinceSec = Math.floor(Date.now() / 1000) - 1;

  const runs = [];
  for (let i = 0; i < CYCLES; i++) {
    const run = await openAndClose(binary);
    runs.push(run);
    t.diagnostic(`cycle ${i + 1}: pids ${run.pids.join(',')} gpuPainting=${run.gpuPainting} exit=${JSON.stringify(run.exit)}`);
    if (i === 0 && !run.gpuPainting) {
      t.skip('WebKit never started a SkiaGPUWorker thread; CPU painting cannot hit this race');
      return;
    }
  }

  const cores = await coreDumpsFor(runs.flatMap((r) => r.pids), sinceSec);
  const describe = (c) => `pid ${c.pid} ${c.exe} signal ${c.sig} (coredumpctl info ${c.pid})`;
  assert.deepEqual(cores.map(describe), [], `${cores.length} of ${CYCLES} shutdowns dumped core`);
  for (const [i, { exit }] of runs.entries()) {
    assert.equal(exit.signal, null, `cycle ${i + 1}: app killed by ${exit.signal}`);
  }
});
