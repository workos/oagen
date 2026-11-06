import { isDeepStrictEqual } from 'node:util';
import { foldParameterName } from '../ir/parameter-key.js';
import type { ApiSpec, AuthScheme } from '../ir/types.js';
import type { SecuritySchemeChange } from './types.js';

/**
 * Compare the two documents' security scheme definitions — `ApiSpec.auth`,
 * the parsed `components.securitySchemes` — by `schemeName` (#384).
 *
 * A requirement under `security` names a scheme; the definition says what a
 * request carrying it puts on the wire. `security-changed` and
 * `securityChanged` compare the requirements, so this is where a scheme that
 * changes its header, its location or its kind under the same name is
 * reported.
 *
 * A scheme the new document declares and the old did not is
 * `security-scheme-added`: breaking when the old document already had the
 * scheme in use — its old definition was one the parser omits from `auth`
 * (`openIdConnect`, an `http` scheme such as `digest`, `mutualTLS`), so
 * every old request carried something other than what the new definition
 * reads — and additive otherwise. One the old declared and the new does not
 * is `security-scheme-removed`: breaking when some request read it — the
 * scheme is in use in the old document, or in the new one, which then
 * requires what it does not define — and additive when nothing did, as a
 * server variable no template references is (#342). One both declare whose
 * definitions differ in anything but `description` and `x-*` keys
 * (documentation and extensions are never a change, as everywhere in the
 * differ) is `security-scheme-modified`: breaking when its wire form
 * regressed and the scheme is in use in the new document, since an SDK
 * built for the old definition sends what the server no longer reads;
 * additive when nothing in the new document uses it, or when the
 * definition only grew.
 *
 * The wire form is the scheme's `kind`; for an `apiKey` also `in` and
 * `name`, a header's name compared folded (`foldHeaderName`, through
 * `foldParameterName`: HTTP header names are case-insensitive, RFC 9110
 * §5.1, so a header respelled `X-Key` → `x-key` is still reported — the
 * spelling is visible in `details` — but additive, as a case-only header
 * parameter rename is, while a query or cookie name is case-sensitive and
 * compared as written); for `oauth2` the `flows` object, its `x-*` keys and
 * each flow's dropped and each flow's `scopes` map set aside, read the way
 * `security-changed` reads a requirement's alternatives: a flow added
 * beside unchanged ones, or a `refreshUrl` added to a flow that had none,
 * is an alternative a caller may use and is additive; a flow removed, or a
 * URL a flow already declared changed or removed, is breaking in use
 * (`flowsShift`). A flow's `scopes` are the requirement's to need —
 * `security-changed` compares those — so a scope added, re-described, or
 * removed while no requirement names it is reported but additive; a scope
 * the old definition offered in some flow, the new offers in none, and a
 * requirement in the new document still names on the scheme is breaking,
 * with the scope named in `details`: the document now asks for what its
 * definition no longer offers, as it does for a removed scheme a
 * requirement still names.
 *
 * A scheme is in use in a document when the effective requirement list of
 * at least one of its operations or webhooks — `node.security ??
 * spec.security ?? []`, the resolution `securityShift` uses — names it, so
 * the document default counts only through a node that inherits it
 * (`schemesInUse`); the scopes those requirements name beside it are
 * `scopesInUse`. Both sides of the wire are treated alike: a scheme a
 * webhook's requirement names is read by the handler, and a changed header
 * name breaks the handler as it breaks a caller.
 *
 * The changes are listed added (new document order), removed (old document
 * order), modified (new document order), as `diffEnums` lists an enum's.
 * A scheme the parser omits from `auth` (see `extractAuthSchemes`) is
 * invisible here except as the old side of an added scheme or the new side
 * of a removed one; one declared as a `$ref` to another entry is read by
 * the parser under the referencing key, so it is compared under that key.
 * `auth` absent and `[]` both read as no schemes.
 */
export function diffAuthSchemes(oldSpec: ApiSpec, newSpec: ApiSpec): SecuritySchemeChange[] {
  const oldByName = new Map((oldSpec.auth ?? []).map((scheme) => [scheme.schemeName, scheme]));
  const newByName = new Map((newSpec.auth ?? []).map((scheme) => [scheme.schemeName, scheme]));
  // Resolved once per document: every added, removed or modified scheme
  // asks the same question of it.
  const oldInUse = schemesInUse(oldSpec);
  const newInUse = scopesInUse(newSpec);
  const changes: SecuritySchemeChange[] = [];

  for (const [schemeName, scheme] of newByName) {
    if (oldByName.has(schemeName)) continue;
    // Every old request carried the scheme under a definition the parser
    // omitted, so what they carry is not what the new definition reads.
    changes.push({
      kind: 'security-scheme-added',
      schemeName,
      scheme,
      classification: oldInUse.has(schemeName) ? 'breaking' : 'additive',
    });
  }

  for (const [schemeName, scheme] of oldByName) {
    if (newByName.has(schemeName)) continue;
    // Read by some request on either side: the old document's carried it,
    // or the new document's still names what it no longer defines.
    const read = oldInUse.has(schemeName) || newInUse.has(schemeName);
    changes.push({
      kind: 'security-scheme-removed',
      schemeName,
      scheme,
      classification: read ? 'breaking' : 'additive',
    });
  }

  for (const [schemeName, newScheme] of newByName) {
    const oldScheme = oldByName.get(schemeName);
    if (!oldScheme) continue;
    const shift = definitionShift(oldScheme, newScheme, newInUse.get(schemeName) ?? new Set());
    if (!shift) continue;
    changes.push({
      kind: 'security-scheme-modified',
      schemeName,
      oldScheme,
      newScheme,
      details: shift.details,
      // Only a request the new document sends under the old form breaks;
      // a scheme nothing there uses puts nothing different on the wire.
      classification: shift.breaks && newInUse.has(schemeName) ? 'breaking' : 'additive',
    });
  }

  return changes;
}

/**
 * Every scheme some request in `spec` carries, with the scopes those
 * requests ask of it: the schemes named by the effective requirement list —
 * `node.security ?? spec.security ?? []` — of at least one operation or
 * webhook, each with the union of the scopes named beside it. The document
 * default counts only through a node that inherits it, so a default every
 * operation overrides puts nothing in use, and a scheme no requirement
 * names is read by no request. Exported for tests.
 */
export function scopesInUse(spec: ApiSpec): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  const nodes = [...spec.services.flatMap((service) => service.operations), ...(spec.webhooks ?? [])];
  for (const node of nodes) {
    for (const alternative of node.security ?? spec.security ?? []) {
      for (const requirement of alternative) {
        const scopes = used.get(requirement.schemeName) ?? new Set<string>();
        for (const scope of requirement.scopes) scopes.add(scope);
        used.set(requirement.schemeName, scopes);
      }
    }
  }
  return used;
}

/** The names in `scopesInUse`: every scheme some request in `spec` carries. Exported for tests. */
export function schemesInUse(spec: ApiSpec): Set<string> {
  return new Set(scopesInUse(spec).keys());
}

/** How a definition moved: what to say, and whether a request built for the old one no longer passes. */
interface DefinitionShift {
  details: string;
  /** Read before asking whether any request in the new document carries the scheme, which decides the classification. */
  breaks: boolean;
}

/**
 * How `newScheme` differs from `oldScheme` — `description` and `x-*` keys
 * aside — or `undefined` when the two say the same thing. A changed kind
 * breaks: a request carries another credential entirely (`apiKey → http
 * basic`). An `apiKey` breaks when its location or folded name moved
 * (`apiKeyShift`); an `oauth2` scheme when its flows regressed or a scope
 * `requiredScopes` names is no longer offered (`flowsShift`). Two `basic`
 * or two `bearer` schemes carry nothing but their kind, so they never
 * differ.
 */
function definitionShift(
  oldScheme: AuthScheme,
  newScheme: AuthScheme,
  requiredScopes: Set<string>,
): DefinitionShift | undefined {
  if (oldScheme.kind !== newScheme.kind) {
    return { details: `${kindLabel(oldScheme)} → ${kindLabel(newScheme)}`, breaks: true };
  }
  if (oldScheme.kind === 'apiKey' && newScheme.kind === 'apiKey') return apiKeyShift(oldScheme, newScheme);
  if (oldScheme.kind === 'oauth2' && newScheme.kind === 'oauth2') {
    return flowsShift(oldScheme.flows, newScheme.flows, requiredScopes);
  }
  return undefined;
}

type ApiKeyScheme = Extract<AuthScheme, { kind: 'apiKey' }>;

/**
 * An `apiKey` whose `in` or `name` moved: `apiKey in header "X-Key" → in
 * header "X-Api-Key"`. Breaks unless only a header name's case changed:
 * HTTP header names are case-insensitive (RFC 9110 §5.1), so the name is
 * compared folded (`foldParameterName`, which keeps a query or cookie name
 * as written), and `X-Key` → `x-key` is reported, the spelling visible,
 * but additive, as a case-only header parameter rename is.
 */
function apiKeyShift(oldScheme: ApiKeyScheme, newScheme: ApiKeyScheme): DefinitionShift | undefined {
  if (oldScheme.in === newScheme.in && oldScheme.name === newScheme.name) return undefined;
  const sameWire =
    oldScheme.in === newScheme.in &&
    foldParameterName(oldScheme.in, oldScheme.name) === foldParameterName(newScheme.in, newScheme.name);
  return {
    details: `apiKey in ${oldScheme.in} "${oldScheme.name}" → in ${newScheme.in} "${newScheme.name}"`,
    breaks: !sameWire,
  };
}

/**
 * An `oauth2` scheme whose `flows` differ, `x-*` keys dropped from the
 * flows object and from each flow (both may be extended, and an extension
 * is not a flow): `oauth2 flows changed` when anything but a `scopes` map
 * moved, `oauth2 scopes changed` when only scopes did. Breaks when the
 * flows regressed — a flow the old definition declared is gone, or a key
 * it declared (`scopes` aside) changed or is gone, so a caller who got its
 * token that way no longer can — or when a scope the old definition
 * offered in some flow is offered in none and `requiredScopes` (what the
 * new document's requirements name on the scheme) still has it, which
 * `details` says (`; required scope "write:pets" removed`, the scopes
 * sorted). A flow added beside unchanged ones, a `refreshUrl` added to a
 * flow that had none, and a scope added, re-described or dropped while no
 * requirement names it do not break: they are alternatives added, or
 * scopes nothing asks for, as `security-changed` reads an alternative
 * added to a requirement.
 */
function flowsShift(
  oldRaw: Record<string, unknown>,
  newRaw: Record<string, unknown>,
  requiredScopes: Set<string>,
): DefinitionShift | undefined {
  const oldFlows = withoutExtensions(oldRaw);
  const newFlows = withoutExtensions(newRaw);
  if (isDeepStrictEqual(oldFlows, newFlows)) return undefined;
  const flowsMoved = !isDeepStrictEqual(mapFlows(oldFlows, withoutScopes), mapFlows(newFlows, withoutScopes));
  const offeredNow = offeredScopes(newFlows);
  const lost = [...offeredScopes(oldFlows)]
    .filter((scope) => !offeredNow.has(scope) && requiredScopes.has(scope))
    .sort();
  const details = [flowsMoved ? 'oauth2 flows changed' : 'oauth2 scopes changed'];
  if (lost.length > 0) {
    const quoted = lost.map((scope) => `"${scope}"`).join(', ');
    details.push(`required scope${lost.length > 1 ? 's' : ''} ${quoted} removed`);
  }
  return { details: details.join('; '), breaks: flowsRegressed(oldFlows, newFlows) || lost.length > 0 };
}

/** A plain object: a flow or a scopes map, as a well-formed document writes them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `object` without its `x-*` keys. */
function withoutExtensionKeys(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !key.startsWith('x-')));
}

/** The `flows` object with its `x-*` keys, and each flow's, dropped. A flow that is not an object (a malformed document) is kept as it is. */
function withoutExtensions(flows: Record<string, unknown>): Record<string, unknown> {
  return mapFlows(withoutExtensionKeys(flows), (flow) => (isRecord(flow) ? withoutExtensionKeys(flow) : flow));
}

/** A flow without its `scopes` map: what it says about getting a token. A flow that is not an object is kept as it is. */
function withoutScopes(flow: unknown): unknown {
  if (!isRecord(flow)) return flow;
  return Object.fromEntries(Object.entries(flow).filter(([key]) => key !== 'scopes'));
}

function mapFlows(flows: Record<string, unknown>, read: (flow: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(flows).map(([name, flow]) => [name, read(flow)]));
}

/** Every scope some flow offers, as one set: a requirement names a scope on the scheme, not on a flow. */
function offeredScopes(flows: Record<string, unknown>): Set<string> {
  const offered = new Set<string>();
  for (const flow of Object.values(flows)) {
    if (!isRecord(flow) || !isRecord(flow.scopes)) continue;
    for (const scope of Object.keys(flow.scopes)) offered.add(scope);
  }
  return offered;
}

/**
 * Whether `newFlows` no longer offer something `oldFlows` did, as they
 * offered it: a flow gone, or a key a flow declared (`scopes` aside) gone
 * or changed. A flow or key added is no regression.
 */
function flowsRegressed(oldFlows: Record<string, unknown>, newFlows: Record<string, unknown>): boolean {
  for (const [name, oldFlow] of Object.entries(oldFlows)) {
    if (!(name in newFlows)) return true;
    const before = withoutScopes(oldFlow);
    const now = withoutScopes(newFlows[name]);
    if (!isRecord(before) || !isRecord(now)) {
      if (!isDeepStrictEqual(before, now)) return true;
      continue;
    }
    for (const [key, value] of Object.entries(before)) {
      if (!(key in now) || !isDeepStrictEqual(value, now[key])) return true;
    }
  }
  return false;
}

/** A scheme's kind in words: `http basic`, `http bearer`, `apiKey`, `oauth2`. */
function kindLabel(scheme: AuthScheme): string {
  return scheme.kind === 'basic' || scheme.kind === 'bearer' ? `http ${scheme.kind}` : scheme.kind;
}
