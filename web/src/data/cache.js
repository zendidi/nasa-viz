const PREFIX = 'nasa-viz:'

/** @returns {{data: any, fetchedAt: number} | null} */
export function loadCached(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Forgets one entry (2026-11-05: the solar-system slices are purged when they leave the range). Best-effort like the rest. */
export function removeCached(key) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // storage unavailable — nothing to forget
  }
}

/** The keys this app stored, without the prefix — [] when storage is unavailable. */
export function cachedKeys() {
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null && key.startsWith(PREFIX)) keys.push(key.slice(PREFIX.length))
    }
    return keys
  } catch {
    return []
  }
}

export function saveCached(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, fetchedAt: Date.now() }))
  } catch {
    // storage unavailable (private mode, quota) — cache is best-effort
  }
}
