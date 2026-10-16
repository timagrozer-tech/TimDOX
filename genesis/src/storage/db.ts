import type { WorldState } from "../simulation/types";

/**
 * Сохранения в IndexedDB. Каждый мир — две записи: «мета» (для списка) и само состояние.
 * Запись идёт в одной транзакции, а предыдущее автосохранение сохраняется до успешной записи нового —
 * поэтому сбой во время сохранения не теряет мир.
 */
export interface SaveMeta { id: string; name: string; year: number; era: string; savedAt: number; seed: string; size: string; states: number; auto: boolean }

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open("genesis", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("meta", { keyPath: "id" });
      d.createObjectStore("worlds");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error ?? new Error("Сохранение прервано")); });
}

export async function saveWorld(meta: SaveMeta, st: WorldState): Promise<void> {
  const d = await db();
  // сначала прошлую версию — в резерв (в той же транзакции: либо всё, либо ничего)
  const t = d.transaction(["meta", "worlds"], "readwrite");
  const worlds = t.objectStore("worlds");
  const g = worlds.get(meta.id);
  g.onsuccess = () => {
    if (g.result) worlds.put(g.result, meta.id + ":backup");
    worlds.put(st, meta.id);
    t.objectStore("meta").put(meta);
  };
  await done(t);
}

export async function listWorlds(): Promise<SaveMeta[]> {
  const d = await db();
  const t = d.transaction("meta", "readonly");
  const r = t.objectStore("meta").getAll();
  return new Promise((res, rej) => { r.onsuccess = () => res((r.result as SaveMeta[]).sort((a, b) => b.savedAt - a.savedAt)); r.onerror = () => rej(r.error); });
}

export async function loadWorld(id: string): Promise<WorldState | null> {
  const d = await db();
  const t = d.transaction("worlds", "readonly");
  const store = t.objectStore("worlds");
  const get = (k: string) => new Promise<WorldState | null>((res) => { const r = store.get(k); r.onsuccess = () => res((r.result as WorldState) ?? null); r.onerror = () => res(null); });
  // если основная запись повреждена — берём резервную
  const main = await get(id);
  if (main && main.map && main.settlements) return main;
  return get(id + ":backup");
}

export async function deleteWorld(id: string): Promise<void> {
  const d = await db();
  const t = d.transaction(["meta", "worlds"], "readwrite");
  t.objectStore("meta").delete(id);
  t.objectStore("worlds").delete(id);
  t.objectStore("worlds").delete(id + ":backup");
  await done(t);
}

export async function lastWorld(): Promise<SaveMeta | null> { return (await listWorlds())[0] ?? null; }
