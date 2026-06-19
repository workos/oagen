/**
 * Add-only aggregator/barrel merging.
 *
 * In scoped (`--services`) generation the root client aggregator (`_client.py`,
 * `workos.ts`) and barrel exports (`index.ts`) are never rewritten from the
 * filtered IR — doing so would drop every unselected service. The common case
 * (an existing service merely gains operations) needs no aggregator change at
 * all: the orchestrator simply skips client emission, leaving the file
 * byte-identical.
 *
 * The remaining case — a scoped run that introduces a brand-new service — needs
 * its entry ADDED to the aggregator without removing or reordering existing
 * entries. The aggregator grammar differs per language (and the emitters live in
 * a separate project), so this module deliberately stays format-agnostic: it
 * operates on caller-supplied insertion instructions (the exact line to add and a
 * substring anchor describing where), never on baked-in language knowledge. The
 * transform is pure, idempotent, and strictly additive.
 *
 * NOTE (Phase 1): these helpers are NOT yet invoked by `orchestrator.generate()`.
 * Wiring blind on-disk aggregator edits requires a per-emitter insertion contract
 * (anchors + import/accessor strings) that the out-of-repo emitters don't expose
 * yet, and a grammar-blind edit would risk the phase's non-destructiveness
 * guarantee. Scoped mode currently relies solely on the engine-level
 * `generateClient` skip (leaving an existing aggregator byte-identical); this
 * module is the ready-made primitive for the deferred new-service add-only path.
 */

export interface AggregatorInsertion {
  /**
   * The exact line to insert (without a trailing newline), including any leading
   * indentation the caller wants. The insertion is a no-op when an equivalent
   * line (compared after trimming surrounding whitespace) is already present.
   */
  line: string;
  /**
   * Insert immediately after the LAST existing line that contains this substring
   * (e.g. the last `import` line, or the last accessor in a client body). When
   * omitted, or when no line contains it, the `position` fallback applies.
   */
  afterLineContaining?: string;
  /**
   * Where to place the line when `afterLineContaining` is absent or unmatched.
   * Defaults to `'append'` (end of file).
   */
  position?: 'append' | 'prepend';
}

/** True when the aggregator content already contains `marker` (e.g. a service accessor name). */
export function aggregatorHasEntry(content: string, marker: string): boolean {
  return content.includes(marker);
}

/**
 * Apply add-only insertions to aggregator/barrel content.
 *
 * Insertions are applied in order; each sees the result of the previous one, so
 * grouped lines (e.g. an import plus an accessor) land deterministically. Lines
 * already present (trim-insensitive) are skipped, making repeat runs idempotent.
 * Existing lines are never removed or reordered.
 *
 * @returns The updated content. The original trailing-newline state is preserved.
 */
export function addAggregatorEntries(content: string, insertions: AggregatorInsertion[]): string {
  if (insertions.length === 0) return content;

  const hadTrailingNewline = content.endsWith('\n');
  // Drop a single trailing newline so it doesn't become an empty final element.
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = body.length === 0 ? [] : body.split('\n');

  for (const insertion of insertions) {
    const target = insertion.line.trim();
    if (lines.some((l) => l.trim() === target)) {
      continue; // already present — idempotent
    }

    let index: number | null = null;
    if (insertion.afterLineContaining !== undefined) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes(insertion.afterLineContaining)) {
          index = i + 1;
          break;
        }
      }
    }

    if (index === null) {
      if (insertion.position === 'prepend') {
        lines.unshift(insertion.line);
      } else {
        lines.push(insertion.line);
      }
    } else {
      lines.splice(index, 0, insertion.line);
    }
  }

  const result = lines.join('\n');
  return hadTrailingNewline ? result + '\n' : result;
}
