/**
 * Minimal localStorage for the node test environment.
 *
 * The offline layer already degrades gracefully when storage throws, so without
 * this the persistence tests would pass vacuously by exercising only the
 * fallback path. A real (in-memory) implementation makes them mean something.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

globalThis.localStorage = new MemoryStorage()
