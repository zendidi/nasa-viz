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

export function saveCached(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, fetchedAt: Date.now() }))
  } catch {
    // storage unavailable (private mode, quota) — cache is best-effort
  }
}
