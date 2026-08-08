// Node >= 26 predefines experimental `localStorage`/`sessionStorage` getters on
// globalThis that evaluate to undefined unless the process launches with
// --localstorage-file. Under vitest's jsdom environment (where globalThis is the
// window object) that stale getter occupies the property, jsdom's own Storage is
// never installed, and bare `localStorage` access crashes test setup. Install a
// spec-shaped in-memory Storage whenever the environment exposes a window but no
// usable storage. Node-environment test files are untouched.

class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value))
  }
}

if (typeof window === 'object' && window !== null) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    let usable = false
    try {
      usable = typeof globalThis[key] !== 'undefined' && globalThis[key] !== null
    } catch {
      usable = false
    }
    if (usable) continue
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      get: () => storage
    })
  }
}

export {}
