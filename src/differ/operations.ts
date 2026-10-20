import type { ErrorResponse, Operation, ResponseContent, TypeRef } from '../ir/types.js';
import type { Change, ParamChange, ResponseContentTypesChange } from './types.js';
import { classifyParamChange } from './classify.js';
import { formatChangeDetails, primitivesDifferOnlyByFormat, typeRefsEqual } from './models.js';

export function diffOperations(serviceName: string, oldOps: Operation[], newOps: Operation[]): Change[] {
  const changes: Change[] = [];
  const oldByName = new Map(oldOps.map((o) => [o.name, o]));
  const newByName = new Map(newOps.map((o) => [o.name, o]));

  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      changes.push({
        kind: 'operation-added',
        serviceName,
        operationName: name,
        classification: 'additive',
      });
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push({
        kind: 'operation-removed',
        serviceName,
        operationName: name,
        classification: 'breaking',
      });
    }
  }

  for (const [name, newOp] of newByName) {
    const oldOp = oldByName.get(name);
    if (!oldOp) continue;

    const paramChanges = diffParams(oldOp, newOp);
    const responseChanged = !typeRefsEqual(oldOp.response, newOp.response);
    const requestBodyChanged = !requestBodiesEqual(oldOp.requestBody, newOp.requestBody);
    // Only while both sides carry a body: a body appearing or disappearing is
    // already `requestBodyChanged`. An absent flag reads as optional, as it
    // does in OpenAPI.
    const requestBodyRequiredChanged =
      !!oldOp.requestBody &&
      !!newOp.requestBody &&
      (oldOp.requestBodyRequired ?? false) !== (newOp.requestBodyRequired ?? false);
    const httpMethodChanged = oldOp.httpMethod !== newOp.httpMethod;
    const pathChanged = oldOp.path !== newOp.path;
    const paginatedChanged = !!oldOp.pagination !== !!newOp.pagination;
    const injectIdempotencyKeyChanged = oldOp.injectIdempotencyKey !== newOp.injectIdempotencyKey;
    const errorsDiff = classifyErrorsChange(oldOp.errors, newOp.errors);
    const errorsChanged = errorsDiff !== 'none';
    const responseContentTypeChanges = diffResponseContentTypes(oldOp, newOp);
    const responseContentTypesChanged = responseContentTypeChanges.length > 0;
    const fallbackDiff = classifyFallbackResponsesChange(oldOp, newOp);
    const fallbackResponsesChanged = fallbackDiff !== 'none';

    const hasChanges =
      paramChanges.length > 0 ||
      responseChanged ||
      requestBodyChanged ||
      requestBodyRequiredChanged ||
      httpMethodChanged ||
      pathChanged ||
      paginatedChanged ||
      injectIdempotencyKeyChanged ||
      errorsChanged ||
      responseContentTypesChanged ||
      fallbackResponsesChanged;

    if (hasChanges) {
      // paginated: false→true is additive (SDK gains pagination helper)
      // paginated: true→false is breaking (SDK loses pagination helper)
      const paginatedBreaking = paginatedChanged && !newOp.pagination;
      // injectIdempotencyKey: false→true is additive (SDK gains idempotency key)
      // injectIdempotencyKey: true→false is breaking (SDK loses idempotency key)
      const injectIdempotencyKeyBreaking = injectIdempotencyKeyChanged && !newOp.injectIdempotencyKey;
      // requestBodyRequired: false→true is breaking (callers must now send the body)
      // requestBodyRequired: true→false is additive (callers may now omit it)
      const requestBodyRequiredBreaking = requestBodyRequiredChanged && !!newOp.requestBodyRequired;
      const errorsBreaking = errorsDiff === 'breaking';
      // A media type callers could ask for that is gone, or a secondary body
      // that changed shape, breaks them; one they can newly ask for does not.
      const responseContentTypesBreaking = responseContentTypeChanges.some((c) => c.classification === 'breaking');
      const fallbackBreaking = fallbackDiff === 'breaking';

      const hasBreaking =
        responseChanged ||
        requestBodyChanged ||
        requestBodyRequiredBreaking ||
        httpMethodChanged ||
        pathChanged ||
        paginatedBreaking ||
        injectIdempotencyKeyBreaking ||
        errorsBreaking ||
        responseContentTypesBreaking ||
        fallbackBreaking ||
        paramChanges.some((pc) => pc.classification === 'breaking');
      changes.push({
        kind: 'operation-modified',
        serviceName,
        operationName: name,
        paramChanges,
        responseChanged,
        requestBodyChanged,
        requestBodyRequiredChanged,
        httpMethodChanged,
        pathChanged,
        paginatedChanged,
        injectIdempotencyKeyChanged,
        errorsChanged,
        responseContentTypesChanged,
        responseContentTypeChanges,
        fallbackResponsesChanged,
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

/**
 * One response entry's media types, normalized so the two specs' entries
 * compare as sets whatever the parser left off: an error that declares only
 * `application/json` with a schema carries no lists in the IR, so its
 * implicit JSON entry is restored from `type`; a response without content
 * has the empty set.
 */
interface ContentEntry {
  key: string;
  statusCode?: number;
  /** The primary success response: the one `response` is the body of. */
  isPrimary: boolean;
  contentTypes: string[];
  contents: ResponseContent[];
  /**
   * The media type the entry's own `type` was read from: the content entry
   * that shares `type`'s very object (how the parser builds it), or, for an
   * error, `application/json` — the only media type an error's `type` is ever
   * read from. Never decided by structural equality, which a secondary body
   * can coincidentally satisfy. Unset when no entry is the own one (a 3xx, or
   * a hand-built IR without that identity).
   */
  ownMediaType?: string;
  /**
   * Whether another comparison reports a change to the own body when this
   * entry is paired with one of its own kind: `responseChanged` for the
   * primary, `errorsChanged` for an error. An alternate 2xx has none, so
   * even its own body is compared here — and so is a primary's when it is
   * paired with an alternate 2xx (the primary moved, or a lone 2xx paired
   * with the entry that offers its media types), since `responseChanged`
   * compares the two primaries, not that pair.
   */
  ownCoveredElsewhere: boolean;
}

const JSON_MEDIA_TYPE = 'application/json';

function ownMediaTypeOf(
  contents: ResponseContent[],
  ownType: TypeRef | undefined,
  fallback?: string,
): string | undefined {
  if (!ownType) return undefined;
  return contents.find((c) => c.type === ownType)?.contentType ?? fallback;
}

/**
 * Every response entry of an operation, keyed so the two specs' entries pair
 * up by status code: every 2xx/3xx entry as `success:<code>` and every error
 * as `error:<code>`. The primary success response (the one `response` is the
 * body of, read from the operation's own lists) is `success:<code>` too when
 * `successResponses` lists it — with several 2xx it is the lowest-coded entry
 * whose type is the operation's `response`, the parser's own pick — so a
 * primary that changes status still pairs with the entry of its code; a lone
 * 2xx carries no code in the IR and is keyed `primary`, pairing with the
 * other spec's primary whatever its code.
 */
function contentEntries(op: Operation): ContentEntry[] {
  const entries: ContentEntry[] = [];
  const successes = [...(op.successResponses ?? [])].sort((a, b) => a.statusCode - b.statusCode);
  const primaryEntry = successes.find(
    (entry) =>
      (op.responseContents !== undefined && entry.contents === op.responseContents) ||
      typeRefsEqual(entry.type, op.response),
  );
  const primaryContents = op.responseContents ?? [];
  entries.push({
    key: primaryEntry ? `success:${primaryEntry.statusCode}` : 'primary',
    ...(primaryEntry ? { statusCode: primaryEntry.statusCode } : {}),
    isPrimary: true,
    contentTypes: op.responseContentTypes ?? [],
    contents: primaryContents,
    ownMediaType: ownMediaTypeOf(primaryContents, op.response),
    ownCoveredElsewhere: true,
  });
  for (const entry of successes) {
    if (entry === primaryEntry) continue;
    const contents = entry.contents ?? [];
    entries.push({
      key: `success:${entry.statusCode}`,
      statusCode: entry.statusCode,
      isPrimary: false,
      contentTypes: entry.contentTypes ?? [],
      contents,
      ownMediaType: ownMediaTypeOf(contents, entry.type),
      ownCoveredElsewhere: false,
    });
  }
  for (const error of op.errors) {
    const implicitJson: ResponseContent[] = error.type ? [{ contentType: JSON_MEDIA_TYPE, type: error.type }] : [];
    const contents = error.contents ?? implicitJson;
    entries.push({
      key: `error:${error.statusCode}`,
      statusCode: error.statusCode,
      isPrimary: false,
      contentTypes: error.contentTypes ?? implicitJson.map((c) => c.contentType),
      contents,
      ownMediaType: ownMediaTypeOf(contents, error.type, error.type ? JSON_MEDIA_TYPE : undefined),
      ownCoveredElsewhere: true,
    });
  }
  return entries;
}

function contentTypeOf(entry: ContentEntry, mediaType: string): TypeRef | undefined {
  return entry.contents.find((c) => c.contentType === mediaType)?.type;
}

/**
 * Per response entry both specs have, the media types the new spec added,
 * removed, or retyped. A retype is left out only when another comparison
 * reports that very body: the entry's own media type on both sides, for two
 * primaries (`responseChanged`) or two errors of one code (`errorsChanged`)
 * — never for a primary paired with an alternate 2xx. Entries pair by
 * status code (`pairContentEntries`); a primary whose code the IR does not
 * carry (a lone 2xx) pairs with the entry of the other spec that offers its
 * media types, else with that spec's primary. An error only one spec has is
 * not a media-type change — a code that came or went is the errors diff's
 * business — and neither is a 2xx the new spec adds, but a 2xx the old spec
 * declared and the new does not has no other diff to report it, so its
 * media types are reported as removed: the formats callers could ask for
 * under that code are gone.
 */
function diffResponseContentTypes(oldOp: Operation, newOp: Operation): ResponseContentTypesChange[] {
  const oldEntries = contentEntries(oldOp);
  const newEntries = contentEntries(newOp);
  const pairs = pairContentEntries(oldEntries, newEntries);
  const paired = new Set<ContentEntry>();
  const changes: ResponseContentTypesChange[] = [];
  for (const entry of newEntries) {
    const old = pairs.get(entry);
    if (!old) continue;
    paired.add(old);
    const oldTypes = new Set(old.contentTypes);
    const newTypes = new Set(entry.contentTypes);
    const added = entry.contentTypes.filter((mediaType) => !oldTypes.has(mediaType));
    const removed = old.contentTypes.filter((mediaType) => !newTypes.has(mediaType));
    const retyped = entry.contentTypes.filter((mediaType) => {
      if (!oldTypes.has(mediaType)) return false;
      const oldType = contentTypeOf(old, mediaType);
      const newType = contentTypeOf(entry, mediaType);
      if (!oldType || !newType || typeRefsEqual(oldType, newType)) return false;
      const ownOnBothSides = old.ownMediaType === mediaType && entry.ownMediaType === mediaType;
      return !(ownOnBothSides && old.ownCoveredElsewhere && entry.ownCoveredElsewhere);
    });
    if (added.length === 0 && removed.length === 0 && retyped.length === 0) continue;
    changes.push({
      ...(entry.statusCode !== undefined ? { statusCode: entry.statusCode } : {}),
      added,
      removed,
      retyped,
      classification: removed.length > 0 || retyped.length > 0 ? 'breaking' : 'additive',
    });
  }
  for (const old of oldEntries) {
    if (paired.has(old) || !old.key.startsWith('success:') || old.contentTypes.length === 0) continue;
    changes.push({
      statusCode: old.statusCode,
      added: [],
      removed: old.contentTypes,
      retyped: [],
      classification: 'breaking',
    });
  }
  return changes;
}

/**
 * Which old entry each new entry is compared with. Entries pair by key: a
 * status code, or `primary` for a lone 2xx, which carries no code in the IR.
 * A lone 2xx on one side only has no counterpart by key, so it pairs with
 * the 2xx entry of the other side that offers the very same media types,
 * whatever that entry's code — the response it most plausibly still is, as
 * when a spec adds a `200` beside an unchanged lone `201` — and, when none
 * does, with the other side's primary. Pairing the two primaries blindly
 * would compare that unchanged `201` with the new `200` and report every
 * format the `200` does not offer as removed. A new entry nothing pairs with
 * is left out of the map.
 */
function pairContentEntries(oldEntries: ContentEntry[], newEntries: ContentEntry[]): Map<ContentEntry, ContentEntry> {
  const before = new Map(oldEntries.map((entry) => [entry.key, entry]));
  const pairs = new Map<ContentEntry, ContentEntry>();
  for (const entry of newEntries) {
    const old = before.get(entry.key);
    if (old) pairs.set(entry, old);
  }
  const oldPrimary = oldEntries.find((entry) => entry.isPrimary);
  const newPrimary = newEntries.find((entry) => entry.isPrimary);
  if (!oldPrimary || !newPrimary || pairs.has(newPrimary)) return pairs;
  if (newPrimary.key === 'primary') {
    pairs.set(newPrimary, survivingEntry(newPrimary, oldEntries) ?? oldPrimary);
  } else if (oldPrimary.key === 'primary') {
    pairs.set(survivingEntry(oldPrimary, newEntries) ?? newPrimary, oldPrimary);
  }
  return pairs;
}

/** The 2xx entry among `others` that offers exactly `lone`'s media types — the primary when it does — if any. */
function survivingEntry(lone: ContentEntry, others: ContentEntry[]): ContentEntry | undefined {
  const mediaTypes = new Set(lone.contentTypes);
  const sameMediaTypes = others.filter(
    (entry) =>
      (entry.isPrimary || entry.key.startsWith('success:')) &&
      entry.contentTypes.length === mediaTypes.size &&
      entry.contentTypes.every((mediaType) => mediaTypes.has(mediaType)),
  );
  return sameMediaTypes.find((entry) => entry.isPrimary) ?? sameMediaTypes[0];
}

function requestBodiesEqual(a: Operation['requestBody'], b: Operation['requestBody']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return typeRefsEqual(a, b);
}

function classifyErrorsChange(
  oldErrors: ErrorResponse[],
  newErrors: ErrorResponse[],
): 'none' | 'additive' | 'breaking' {
  return classifyKeyedResponsesChange(
    new Map(oldErrors.map((e) => [e.statusCode, e])),
    new Map(newErrors.map((e) => [e.statusCode, e])),
  );
}

/**
 * The fallback responses, keyed the way the spec keys them (`default`,
 * `4XX`), classified like `errors`: one added is additive (the SDK gains a
 * typed fallback), one removed or retyped is breaking.
 */
function classifyFallbackResponsesChange(oldOp: Operation, newOp: Operation): 'none' | 'additive' | 'breaking' {
  const byKey = (op: Operation): Map<string, { type?: TypeRef }> => {
    const entries = new Map<string, { type?: TypeRef }>();
    if (op.defaultResponse) entries.set('default', op.defaultResponse);
    for (const range of op.rangeResponses ?? []) entries.set(range.range, range);
    return entries;
  };
  return classifyKeyedResponsesChange(byKey(oldOp), byKey(newOp));
}

/**
 * Responses matched by key (a status code, `default`, a range): a new key is
 * additive (the SDK gains an error class or typed fallback), a removed key is
 * breaking (it loses one), and a shared key whose body type changed is
 * breaking. A key with no body on either side is unchanged.
 */
function classifyKeyedResponsesChange<K>(
  oldByKey: Map<K, { type?: TypeRef }>,
  newByKey: Map<K, { type?: TypeRef }>,
): 'none' | 'additive' | 'breaking' {
  let hasAdditive = false;
  let hasBreaking = false;

  for (const key of newByKey.keys()) {
    if (!oldByKey.has(key)) hasAdditive = true;
  }

  for (const key of oldByKey.keys()) {
    if (!newByKey.has(key)) hasBreaking = true;
  }

  for (const [key, newEntry] of newByKey) {
    const oldEntry = oldByKey.get(key);
    if (!oldEntry) continue;
    if (!oldEntry.type && !newEntry.type) continue;
    if (!oldEntry.type || !newEntry.type || !typeRefsEqual(oldEntry.type, newEntry.type)) {
      hasBreaking = true;
    }
  }

  if (hasBreaking) return 'breaking';
  if (hasAdditive) return 'additive';
  return 'none';
}

function diffParams(oldOp: Operation, newOp: Operation): ParamChange[] {
  const changes: ParamChange[] = [];
  const tagged = (loc: 'path' | 'query' | 'header', params: typeof oldOp.queryParams) =>
    params.map((p) => ({ p, loc }));
  const allOldParams = [
    ...tagged('path', oldOp.pathParams),
    ...tagged('query', oldOp.queryParams),
    ...tagged('header', oldOp.headerParams),
  ];
  const allNewParams = [
    ...tagged('path', newOp.pathParams),
    ...tagged('query', newOp.queryParams),
    ...tagged('header', newOp.headerParams),
  ];
  const oldByName = new Map(allOldParams.map((e) => [e.p.name, e]));
  const newByName = new Map(allNewParams.map((e) => [e.p.name, e]));

  for (const [name, entry] of newByName) {
    if (!oldByName.has(name)) {
      changes.push(classifyParamChange('param-added', name, entry.p.required));
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      changes.push(classifyParamChange('param-removed', name));
    }
  }

  for (const [name, newEntry] of newByName) {
    const oldEntry = oldByName.get(name);
    if (!oldEntry) continue;

    if (!typeRefsEqual(oldEntry.p.type, newEntry.p.type)) {
      if (primitivesDifferOnlyByFormat(oldEntry.p.type, newEntry.p.type)) {
        const change = classifyParamChange('param-format-changed', name);
        change.details = formatChangeDetails(oldEntry.p.type, newEntry.p.type);
        changes.push(change);
      } else {
        changes.push(classifyParamChange('param-type-changed', name));
      }
    }

    if (oldEntry.p.required !== newEntry.p.required) {
      changes.push(classifyParamChange('param-required-changed', name, newEntry.p.required));
    }

    const oldDefault = serializeDefault(oldEntry.p.default);
    const newDefault = serializeDefault(newEntry.p.default);
    if (oldDefault !== newDefault) {
      const change = classifyParamChange('param-default-changed', name);
      change.oldDefault = oldDefault;
      change.newDefault = newDefault;
      change.paramLocation = newEntry.loc;
      change.details = `default ${oldDefault ?? '<unset>'} → ${newDefault ?? '<unset>'}`;
      changes.push(change);
    }
  }

  return changes;
}

function serializeDefault(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects/arrays: stable JSON. Stringification of equal-valued objects is
  // deterministic enough for this comparison since callers typically pass
  // primitives; complex defaults are rare.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
