import { load } from "@tauri-apps/plugin-store";

const STORE_KEY = "recent_repos";
const MAX_RECENT = 1000;

async function getStore() {
  return load("waypoint.json", { defaults: {} });
}

async function updateRecentRepos(merge: (current: string[]) => string[]): Promise<string[]> {
  const store = await getStore();
  const current = (await store.get<string[]>(STORE_KEY)) ?? [];
  const updated = merge(current).slice(0, MAX_RECENT);
  await store.set(STORE_KEY, updated);
  return updated;
}

export async function getRecentRepos(): Promise<string[]> {
  const store = await getStore();
  return (await store.get<string[]>(STORE_KEY)) ?? [];
}

export async function addToRecentRepos(path: string): Promise<string[]> {
  return updateRecentRepos((current) => [path, ...current.filter((p) => p !== path)]);
}

export async function addManyToRecentRepos(paths: string[]): Promise<string[]> {
  return updateRecentRepos((current) => {
    const currentSet = new Set(current);
    // Preserve existing order (most-recently-opened first), append truly new repos at the end
    return [...current, ...paths.filter((p) => !currentSet.has(p))];
  });
}
