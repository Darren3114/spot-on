// Storage adapter that replaces the artifact-only `window.storage` API.
//
// Personal data (shared=false)  -> always localStorage (per-device).
// Shared data   (shared=true)   -> a backend if VITE_API_BASE is set,
//                                  otherwise falls back to localStorage.
//
// This means the app deploys as pure static hosting today (local-only),
// and the global leaderboard turns on later just by setting VITE_API_BASE
// to your serverless KV endpoint — no code changes to the game.

const API_BASE = import.meta.env.VITE_API_BASE || "";
const PREFIX = "spoton:";

function localGet(key) {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? null : { key, value: raw, shared: false };
}
function localSet(key, value) {
  localStorage.setItem(PREFIX + key, value);
  return { key, value, shared: false };
}

async function remoteGet(key) {
  const r = await fetch(`${API_BASE}/api/kv?key=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error("kv get failed");
  const data = await r.json();
  return data && data.value != null ? { key, value: data.value, shared: true } : null;
}
async function remoteSet(key, value) {
  const r = await fetch(`${API_BASE}/api/kv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error("kv set failed");
  return { key, value, shared: true };
}

export const storage = {
  async get(key, shared = false) {
    try {
      if (shared && API_BASE) return await remoteGet(key);
      return localGet(key);
    } catch {
      // network hiccup on a shared read -> degrade to local so the UI still works
      return localGet(key);
    }
  },
  async set(key, value, shared = false) {
    if (shared && API_BASE) {
      try { return await remoteSet(key, value); }
      catch { return localSet(key, value); }
    }
    return localSet(key, value);
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: true };
  },
  async list(prefix = "") {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
    }
    return { keys, prefix };
  },
};
