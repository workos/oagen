/** Sort an object's keys alphabetically. Shared across all extractors for deterministic output. */
export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

/** Collects per-file export names, deduplicating and sorting on finalization. */
export class ExportCollector {
  private map = new Map<string, Set<string>>();

  add(sourceFile: string, name: string): void {
    if (!this.map.has(sourceFile)) this.map.set(sourceFile, new Set());
    this.map.get(sourceFile)!.add(name);
  }

  toRecord(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [file, names] of this.map) {
      result[file] = [...names].sort();
    }
    return result;
  }
}
