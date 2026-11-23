/** Sort an object's keys alphabetically. Shared across all extractors for deterministic output. */
export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    setOwn(sorted, key, record[key]);
  }
  return sorted;
}

/**
 * Stores `value` under `key` as one of the record's own keys.
 *
 * `record[key] = value` does that for every key but `__proto__`. There it goes to the setter
 * every object inherits, which replaces the record's prototype when the value is an object
 * and does nothing otherwise. Either way no key is added, so the entry is missing from
 * `Object.keys` and from the JSON written for the surface.
 */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The overloads collected so far for the method called `name`, starting the list on first use.
 *
 * `methods[name]` cannot answer "has this name been seen": it also finds what every object
 * inherits, so a method called `toString`, `valueOf` or `constructor` would read as a list
 * that is already there. Only the record's own keys count.
 */
export function overloadsOf<T>(methods: Record<string, T[]>, name: string): T[] {
  if (!Object.hasOwn(methods, name)) setOwn(methods, name, []);
  return methods[name];
}

/** Collects per-file export names, deduplicating and sorting on finalization. */
export class ExportCollector {
  private map = new Map<string, Set<string>>();

  add(sourceFile: string, name: string): void {
    let set = this.map.get(sourceFile);
    if (!set) {
      set = new Set();
      this.map.set(sourceFile, set);
    }
    set.add(name);
  }

  toRecord(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [file, names] of this.map) {
      result[file] = [...names].sort();
    }
    return result;
  }
}
