import type {
  ApiSpec,
  ErrorResponse,
  Operation,
  PaginationEndOfIteration,
  ResponseContent,
  ServerEntry,
  StatusRange,
  TypeRef,
} from '../ir/types.js';
import { resolveServerUrl } from '../ir/server-url.js';
import { diffServers } from './servers.js';
import {
  diffRequestBodyContentTypes,
  ownRepresentationKept,
  mediaTypeBodies,
  pairMediaTypeBodies,
  reparameterizedBodies,
  respelling,
  retypedBodies,
  type MediaTypeBody,
} from './media-types.js';
import type { DocumentShapes } from './shapes.js';
import type { Change, ParamChange, ResponseContentTypesChange } from './types.js';
import {
  classifyParamChange,
  deprecationDetails,
  deprecationFlip,
  requestBodyEncodingShift,
  tagsShift,
} from './classify.js';
import { formatChangeDetails, primitivesDifferOnlyByFormat, typeRefsEqual } from './models.js';
import { classifySecurityChange, securityShift, type DocumentSecurity } from './security.js';

/**
 * The two documents' `servers`, so `diffOperations` can resolve what an
 * operation is actually served from (`op.servers ?? document servers`).
 * `diffSpecs` supplies it; a direct caller may leave it out, in which case an
 * operation that inherits is compared as having no servers at all.
 */
export interface DocumentServers {
  old: ServerEntry[] | undefined;
  new: ServerEntry[] | undefined;
}

/**
 * `documentSecurity` — the two documents' `security` — lets an operation that
 * declares none of its own be compared on what it inherits, exactly as
 * `documentServers` does for `servers`; `diffSpecs` passes both, a direct
 * caller may leave either out.
 */
export function diffOperations(
  serviceName: string,
  oldOps: Operation[],
  newOps: Operation[],
  documentServers?: DocumentServers,
  documentSecurity?: DocumentSecurity,
  shapes?: DocumentShapes,
): Change[] {
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
    // The required flag and the encoding are compared only while both sides
    // carry a body: a body appearing or disappearing is already
    // `requestBodyChanged`, and the parser sets both beside the body, so
    // they go with it.
    const bothCarryBody = !!oldOp.requestBody && !!newOp.requestBody;
    // An absent flag reads as optional, as it does in OpenAPI.
    const requestBodyRequiredChanged =
      bothCarryBody && (oldOp.requestBodyRequired ?? false) !== (newOp.requestBodyRequired ?? false);
    // The wire format the SDK serializes the body as, read through the
    // function `diffWebhooks` reads a payload's encoding with, which
    // compares only while both sides carry a body, likewise.
    const encoding = requestBodyEncodingShift(oldOp, newOp);
    const requestBodyEncodingChanged = encoding !== undefined;
    // The media types callers may send the body as, only while both sides
    // declare a body, likewise; judged from the caller's side, which sends
    // it. A body moving from JSON to a form media type sets this beside the
    // encoding flag: the JSON media type is removed and the form one added.
    const requestBodyContentTypeChange = diffRequestBodyContentTypes(oldOp, newOp, 'caller', shapes);
    const requestBodyContentTypesChanged = requestBodyContentTypeChange !== undefined;
    const httpMethodChanged = oldOp.httpMethod !== newOp.httpMethod;
    const pathChanged = oldOp.path !== newOp.path;
    const paginatedChanged = !!oldOp.pagination !== !!newOp.pagination;
    // Only comparable when both versions paginate; presence is paginatedChanged's job.
    const oldPagination = oldOp.pagination;
    const newPagination = newOp.pagination;
    const bothPaginated = !!oldPagination && !!newPagination;
    const paginationFieldChanged = (field: 'strategy' | 'param' | 'limitParam' | 'dataPath' | 'pageStart'): boolean =>
      bothPaginated && oldPagination?.[field] !== newPagination?.[field];
    const paginationStrategyChanged = paginationFieldChanged('strategy');
    const paginationParamChanged = paginationFieldChanged('param');
    const paginationLimitParamChanged = paginationFieldChanged('limitParam');
    const paginationDataPathChanged = paginationFieldChanged('dataPath');
    const paginationPageStartChanged = paginationFieldChanged('pageStart');
    const paginationEndOfIterationChanged =
      bothPaginated && !endOfIterationEqual(oldPagination?.endOfIteration, newPagination?.endOfIteration);
    const injectIdempotencyKeyChanged = oldOp.injectIdempotencyKey !== newOp.injectIdempotencyKey;
    const errorsDiff = classifyErrorsChange(oldOp.errors, newOp.errors);
    const errorsChanged = errorsDiff !== 'none';
    const responseContentTypeChanges = diffResponseContentTypes(oldOp, newOp, shapes);
    const responseContentTypesChanged = responseContentTypeChanges.length > 0;
    const fallbackDiff = classifyFallbackResponsesChange(oldOp, newOp);
    const fallbackResponsesChanged = fallbackDiff !== 'none';
    // Additive either way: the operation's signature is unchanged, but a
    // changelog has to say it, so a flipped flag alone is a change.
    const deprecation = deprecationFlip(oldOp, newOp);
    const deprecatedChanged = deprecation !== undefined;
    // `servers` is set only when the operation's effective servers differ from
    // the document's. Absent on both sides is "inherits" twice — a moved
    // document is the document-level diff's to report. Otherwise the lists the
    // operation is actually served from are compared, so a document that moves
    // to where the operation already pointed (its override vanishes) is no
    // change to the operation.
    const serversChanged =
      (!!oldOp.servers || !!newOp.servers) &&
      effectiveServersChanged(oldOp.servers ?? documentServers?.old ?? [], newOp.servers ?? documentServers?.new ?? []);
    // What the operation's requests must carry, `op.security ?? document
    // security` on each side, by the same rule as `servers`: absent on both
    // sides inherits twice and is the document-level diff's to report.
    const security = securityShift(oldOp, newOp, documentSecurity);
    const securityChanged = security !== undefined;
    // Additive always: tags group and document the method and change nothing
    // a caller compiles against, but a changelog has to say it.
    const tags = tagsShift(oldOp, newOp);
    const tagsChanged = tags !== undefined;

    const hasChanges =
      paramChanges.length > 0 ||
      responseChanged ||
      requestBodyChanged ||
      requestBodyRequiredChanged ||
      requestBodyEncodingChanged ||
      requestBodyContentTypesChanged ||
      httpMethodChanged ||
      pathChanged ||
      paginatedChanged ||
      paginationStrategyChanged ||
      paginationParamChanged ||
      paginationLimitParamChanged ||
      paginationDataPathChanged ||
      paginationPageStartChanged ||
      paginationEndOfIterationChanged ||
      injectIdempotencyKeyChanged ||
      errorsChanged ||
      responseContentTypesChanged ||
      fallbackResponsesChanged ||
      deprecatedChanged ||
      serversChanged ||
      securityChanged ||
      tagsChanged;

    if (hasChanges) {
      // paginated: false→true is additive (SDK gains pagination helper)
      // paginated: true→false is breaking (SDK loses pagination helper)
      const paginatedBreaking = paginatedChanged && !newOp.pagination;
      // endOfIteration: unset→set is additive (the iterator stops one request
      // sooner); set→changed or set→unset is breaking (it stops at a different
      // point than callers observed before)
      const paginationEndOfIterationBreaking = paginationEndOfIterationChanged && !!oldPagination?.endOfIteration;
      // injectIdempotencyKey: false→true is additive (SDK gains idempotency key)
      // injectIdempotencyKey: true→false is breaking (SDK loses idempotency key)
      const injectIdempotencyKeyBreaking = injectIdempotencyKeyChanged && !newOp.injectIdempotencyKey;
      // requestBodyRequired: false→true is breaking (callers must now send the body)
      // requestBodyRequired: true→false is additive (callers may now omit it)
      const requestBodyRequiredBreaking = requestBodyRequiredChanged && !!newOp.requestBodyRequired;
      // requestBody: a body appearing as optional is additive — callers gain an
      // argument they may leave out, like an optional `param-added`. A body
      // appearing as required, a body disappearing, and a body changing type
      // are breaking. An absent flag reads as optional, as it does in OpenAPI.
      const optionalRequestBodyAdded = !oldOp.requestBody && !!newOp.requestBody && !newOp.requestBodyRequired;
      const requestBodyBreaking = requestBodyChanged && !optionalRequestBodyAdded;
      // requestBodyEncoding: an SDK built for the old spec keeps sending the
      // representation that spec's body was read from. Breaking when the new
      // spec no longer accepts it — that media type gone, or its shape
      // changed; additive when it still does, as when a media type the
      // parser prefers is added beside it (`application/json` beside a kept
      // `application/x-www-form-urlencoded`). A body without media-type
      // lists reads as breaking.
      const requestBodyEncodingBreaking =
        requestBodyEncodingChanged && !ownRepresentationKept(oldOp, newOp, 'caller', shapes);
      const errorsBreaking = errorsDiff === 'breaking';
      // A media type callers could ask for that is gone, or a secondary body
      // that changed shape, breaks them; one they can newly ask for, or one
      // that only changed a parameter, does not.
      const responseContentTypesBreaking = responseContentTypeChanges.some((c) => c.classification === 'breaking');
      // A media type callers could send that is gone, or a secondary body
      // that changed shape, breaks them; one they can newly send does not.
      const requestBodyContentTypesBreaking = requestBodyContentTypeChange?.classification === 'breaking';
      const fallbackBreaking = fallbackDiff === 'breaking';
      // security: breaking when a request built for the old requirements no
      // longer satisfies the new ones, read from the caller's side.
      const securityBreaking =
        security !== undefined &&
        classifySecurityChange(security.oldSecurity, security.newSecurity, 'caller') === 'breaking';

      // servers: any change is breaking (the operation's requests go elsewhere)
      const hasBreaking =
        responseChanged ||
        requestBodyBreaking ||
        requestBodyRequiredBreaking ||
        requestBodyEncodingBreaking ||
        httpMethodChanged ||
        pathChanged ||
        paginatedBreaking ||
        // The iterator sends a different parameter, page size or first page,
        // or reads a different array: a behavior change for every caller.
        paginationStrategyChanged ||
        paginationParamChanged ||
        paginationLimitParamChanged ||
        paginationDataPathChanged ||
        paginationPageStartChanged ||
        paginationEndOfIterationBreaking ||
        injectIdempotencyKeyBreaking ||
        errorsBreaking ||
        responseContentTypesBreaking ||
        requestBodyContentTypesBreaking ||
        fallbackBreaking ||
        serversChanged ||
        securityBreaking ||
        paramChanges.some((pc) => pc.classification === 'breaking');
      changes.push({
        kind: 'operation-modified',
        serviceName,
        operationName: name,
        paramChanges,
        responseChanged,
        requestBodyChanged,
        requestBodyRequiredChanged,
        requestBodyEncodingChanged,
        ...encoding,
        requestBodyContentTypesChanged,
        ...(requestBodyContentTypeChange ? { requestBodyContentTypeChange } : {}),
        httpMethodChanged,
        pathChanged,
        paginatedChanged,
        paginationStrategyChanged,
        paginationParamChanged,
        paginationLimitParamChanged,
        paginationDataPathChanged,
        paginationPageStartChanged,
        paginationEndOfIterationChanged,
        injectIdempotencyKeyChanged,
        errorsChanged,
        responseContentTypesChanged,
        responseContentTypeChanges,
        fallbackResponsesChanged,
        deprecatedChanged,
        ...deprecation,
        serversChanged,
        securityChanged,
        ...security,
        tagsChanged,
        ...tags,
        classification: hasBreaking ? 'breaking' : 'additive',
      });
    }
  }

  return changes;
}

function endOfIterationEqual(
  a: PaginationEndOfIteration | undefined,
  b: PaginationEndOfIteration | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.path === b.path;
}

/**
 * Whether an operation's effective server list changed in a way a caller
 * notices: the document-level diff's own answer (`diffServers`, #255), read
 * off the two lists as if each were a document — `baseUrl` is the first
 * entry resolved, as the parser sets it. Anything it reports flips the flag:
 * a moved default host (`base-url-changed`, so a reorder counts exactly when
 * it moves the first entry's resolved URL), a server added or removed by
 * `url` template, and any variable change — the additive ones included (a
 * new enum value, a new variable, a lifted enum), since one boolean cannot
 * carry that distinction. Descriptions on a server or a variable, enum order,
 * a repeated enum value and position do not count there, so they do not here.
 */
function effectiveServersChanged(oldServers: ServerEntry[], newServers: ServerEntry[]): boolean {
  return diffServers(asDocument(oldServers), asDocument(newServers)).length > 0;
}

/** A server list as the document-level diff reads a document: `baseUrl` is its first entry resolved, `''` without one. */
function asDocument(servers: ServerEntry[]): Pick<ApiSpec, 'baseUrl' | 'servers'> {
  return { baseUrl: servers.length > 0 ? resolveServerUrl(servers[0]).url : '', servers };
}

/**
 * One response entry's media types, with what the parser left off restored
 * so the two specs' entries compare alike: an error that declares only
 * `application/json` with a schema carries no lists in the IR, so its
 * implicit JSON entry is restored from `type`; a response without content
 * has no bodies.
 */
interface ContentEntry {
  key: string;
  statusCode?: number;
  /** The fallback response this is, when it is one: `default` or a range. */
  fallback?: 'default' | StatusRange;
  /** The primary success response: the one `response` is the body of. */
  isPrimary: boolean;
  /** The entry's media types, one per `contentTypes` entry, in document order. */
  bodies: MediaTypeBody[];
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

/**
 * Every response entry of an operation, keyed so the two specs' entries pair
 * up by status code: every 2xx/3xx entry as `success:<code>`, every error as
 * `error:<code>`, the `default` and each range response as
 * `fallback:<key>`. The primary success response (the one `response` is the
 * body of, read from the operation's own lists) is `success:<code>` too when
 * `successResponses` lists it — with several 2xx it is the lowest-coded entry
 * whose type is the operation's `response`, the parser's own pick — so a
 * primary that changes status still pairs with the entry of its code; a lone
 * 2xx is not listed in `successResponses` and is keyed `primary` — its
 * `responseStatusCode` is not used as a key, so the two specs' lone primaries
 * pair with each other whatever their codes (see `pairContentEntries` for
 * what it pairs with).
 */
function contentEntries(op: Operation): ContentEntry[] {
  const entries: ContentEntry[] = [];
  const successes = [...(op.successResponses ?? [])].sort((a, b) => a.statusCode - b.statusCode);
  const primaryEntry = successes.find(
    (entry) =>
      (op.responseContents !== undefined && entry.contents === op.responseContents) ||
      typeRefsEqual(entry.type, op.response),
  );
  entries.push({
    key: primaryEntry ? `success:${primaryEntry.statusCode}` : 'primary',
    ...(primaryEntry ? { statusCode: primaryEntry.statusCode } : {}),
    isPrimary: true,
    bodies: mediaTypeBodies(op.responseContentTypes ?? [], op.responseContents ?? [], op.response),
    ownCoveredElsewhere: true,
  });
  for (const entry of successes) {
    if (entry === primaryEntry) continue;
    entries.push({
      key: `success:${entry.statusCode}`,
      statusCode: entry.statusCode,
      isPrimary: false,
      bodies: mediaTypeBodies(entry.contentTypes ?? [], entry.contents ?? [], entry.type),
      ownCoveredElsewhere: false,
    });
  }
  for (const error of op.errors) {
    const implicitJson: ResponseContent[] = error.type ? [{ contentType: JSON_MEDIA_TYPE, type: error.type }] : [];
    entries.push({
      key: `error:${error.statusCode}`,
      statusCode: error.statusCode,
      isPrimary: false,
      bodies: mediaTypeBodies(
        error.contentTypes ?? implicitJson.map((c) => c.contentType),
        error.contents ?? implicitJson,
        error.type,
        JSON_MEDIA_TYPE,
      ),
      ownCoveredElsewhere: true,
    });
  }
  // A fallback's own body is its JSON entry, whose retype `fallbackResponsesChanged` reports.
  const fallbacks: Array<
    ['default' | StatusRange, { type?: TypeRef; contentTypes?: string[]; contents?: ResponseContent[] }]
  > = [];
  if (op.defaultResponse) fallbacks.push(['default', op.defaultResponse]);
  for (const range of op.rangeResponses ?? []) fallbacks.push([range.range, range]);
  for (const [fallback, entry] of fallbacks) {
    entries.push({
      key: `fallback:${fallback}`,
      fallback,
      isPrimary: false,
      bodies: mediaTypeBodies(entry.contentTypes ?? [], entry.contents ?? [], entry.type),
      ownCoveredElsewhere: true,
    });
  }
  return entries;
}

/**
 * Per response entry both specs have, the media types the new spec added,
 * removed, retyped or reparameterized. Media types are compared by essence
 * (`pairMediaTypeBodies`), as the parser types them, so a key that only
 * changed case, whitespace or `charset` is the same media type, and each is
 * reported as written in the spec that declares it; a pair whose other
 * parameters differ is reparameterized, which is additive. A retype is a
 * body whose shape changed (`retypedBodies`), left out only when another
 * comparison reports that very body: the entry's own body on both sides,
 * for two primaries (`responseChanged`) or two errors of one code
 * (`errorsChanged`) — never for a primary paired with an alternate 2xx.
 * Entries pair by status code (`pairContentEntries`); a primary that
 * `successResponses` does not list (a lone 2xx — its `responseStatusCode`
 * is not a key) pairs with the entry of the other spec that offers its
 * media types, else with that spec's primary. An error only one spec has is
 * not a media-type change — a code that came or went is the
 * errors diff's business — and neither is a 2xx the new spec adds, but a
 * 2xx the old spec declared and the new does not has no other diff to
 * report it, so its media types are reported as removed: the formats
 * callers could ask for under that code are gone.
 */
function diffResponseContentTypes(
  oldOp: Operation,
  newOp: Operation,
  shapes?: DocumentShapes,
): ResponseContentTypesChange[] {
  const oldEntries = contentEntries(oldOp);
  const newEntries = contentEntries(newOp);
  const pairs = pairContentEntries(oldEntries, newEntries);
  const paired = new Set<ContentEntry>();
  const changes: ResponseContentTypesChange[] = [];
  for (const entry of newEntries) {
    const old = pairs.get(entry);
    if (!old) continue;
    paired.add(old);
    const { pairs: bodies, added, removed } = pairMediaTypeBodies(old.bodies, entry.bodies, shapes);
    const retyped = retypedBodies(bodies, old.ownCoveredElsewhere && entry.ownCoveredElsewhere, shapes);
    const reparameterized = reparameterizedBodies(bodies);
    if (added.length === 0 && removed.length === 0 && retyped.length === 0 && reparameterized.length === 0) continue;
    changes.push({
      ...(entry.statusCode !== undefined ? { statusCode: entry.statusCode } : {}),
      ...(entry.fallback !== undefined ? { fallback: entry.fallback } : {}),
      added: added.map((body) => body.mediaType),
      removed: removed.map((body) => body.mediaType),
      retyped: retyped.map(([, after]) => after.mediaType),
      reparameterized: reparameterized.map(respelling),
      classification: removed.length > 0 || retyped.length > 0 ? 'breaking' : 'additive',
    });
  }
  // An error or fallback the old spec alone declares is the errors or
  // fallback diff's business; a 2xx is nobody else's.
  for (const old of oldEntries) {
    if (paired.has(old) || !old.key.startsWith('success:') || old.bodies.length === 0) continue;
    changes.push({
      statusCode: old.statusCode,
      added: [],
      removed: old.bodies.map((body) => body.mediaType),
      retyped: [],
      reparameterized: [],
      classification: 'breaking',
    });
  }
  return changes;
}

/**
 * Which old entry each new entry is compared with. Entries pair by key: a
 * status code, or `primary` for a lone 2xx, which `successResponses` does
 * not list (its `responseStatusCode` is not used as a key, so two lone
 * primaries pair whatever their codes).
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

/**
 * The 2xx entry among `others` that offers exactly `lone`'s media types,
 * order aside: one spelled the same way first, else one that offers them by
 * essence (`Text/HTML` + `application/pdf` still offers `application/pdf` +
 * `text/html`) — the primary among those, if any.
 */
function survivingEntry(lone: ContentEntry, others: ContentEntry[]): ContentEntry | undefined {
  const candidates = others.filter((entry) => entry.isPrimary || entry.key.startsWith('success:'));
  // The entry spelled exactly as the lone one is the response it still is,
  // before any that only matches by essence: a `200` added beside an
  // unchanged `201` with `application/yaml; version=2` where the `201` has
  // `application/yaml` must not take the `201`'s place.
  const exact = candidates.filter((entry) => signature(entry, 'mediaType') === signature(lone, 'mediaType'));
  const byEssence = candidates.filter((entry) => signature(entry, 'essence') === signature(lone, 'essence'));
  const sameMediaTypes = exact.length > 0 ? exact : byEssence;
  return sameMediaTypes.find((entry) => entry.isPrimary) ?? sameMediaTypes[0];
}

/** An entry's media types as a multiset of their spellings or of their essences, order aside. */
function signature(entry: ContentEntry, by: 'mediaType' | 'essence'): string {
  return JSON.stringify(entry.bodies.map((body) => body[by]).sort());
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

type ParamLocation = 'path' | 'query' | 'header';

/**
 * The key `diffParams` matches parameters on. OpenAPI allows a path `id`
 * beside a query `id` on one operation, and keying by name alone paired
 * whichever came last on each side with the other's, so a change to one of
 * them was reported against the wrong parameter or not at all.
 */
function paramKey(loc: ParamLocation, name: string): string {
  return `${loc}:${name}`;
}

function diffParams(oldOp: Operation, newOp: Operation): ParamChange[] {
  const changes: ParamChange[] = [];
  const tagged = (loc: ParamLocation, params: typeof oldOp.queryParams) => params.map((p) => ({ p, loc }));
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
  const oldByKey = new Map(allOldParams.map((e) => [paramKey(e.loc, e.p.name), e]));
  const newByKey = new Map(allNewParams.map((e) => [paramKey(e.loc, e.p.name), e]));
  // Every entry says where its parameter lives, since the name alone no
  // longer identifies it.
  const at = (change: ParamChange, loc: ParamLocation): ParamChange => {
    change.paramLocation = loc;
    return change;
  };

  for (const [key, entry] of newByKey) {
    if (!oldByKey.has(key)) {
      changes.push(at(classifyParamChange('param-added', entry.p.name, entry.p.required), entry.loc));
    }
  }

  for (const [key, entry] of oldByKey) {
    if (!newByKey.has(key)) {
      changes.push(at(classifyParamChange('param-removed', entry.p.name), entry.loc));
    }
  }

  for (const [key, newEntry] of newByKey) {
    const oldEntry = oldByKey.get(key);
    if (!oldEntry) continue;
    const name = newEntry.p.name;
    const loc = newEntry.loc;

    if (!typeRefsEqual(oldEntry.p.type, newEntry.p.type)) {
      if (primitivesDifferOnlyByFormat(oldEntry.p.type, newEntry.p.type)) {
        const change = at(classifyParamChange('param-format-changed', name), loc);
        change.details = formatChangeDetails(oldEntry.p.type, newEntry.p.type);
        changes.push(change);
      } else {
        changes.push(at(classifyParamChange('param-type-changed', name), loc));
      }
    }

    if (oldEntry.p.required !== newEntry.p.required) {
      changes.push(at(classifyParamChange('param-required-changed', name, newEntry.p.required), loc));
    }

    const oldDefault = serializeDefault(oldEntry.p.default);
    const newDefault = serializeDefault(newEntry.p.default);
    if (oldDefault !== newDefault) {
      const change = at(classifyParamChange('param-default-changed', name), loc);
      change.oldDefault = oldDefault;
      change.newDefault = newDefault;
      change.details = `default ${oldDefault ?? '<unset>'} → ${newDefault ?? '<unset>'}`;
      changes.push(change);
    }

    const deprecation = deprecationFlip(oldEntry.p, newEntry.p);
    if (deprecation) {
      changes.push({
        ...at(classifyParamChange('param-deprecated-changed', name), loc),
        ...deprecation,
        details: deprecationDetails(deprecation.newDeprecated),
      });
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
