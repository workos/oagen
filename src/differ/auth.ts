import { isDeepStrictEqual } from 'node:util';
import { foldParameterName } from '../ir/parameter-key.js';
import type { ApiSpec, AuthScheme, Callback, SecurityRequirementSet } from '../ir/types.js';
import type { SecuritySchemeChange } from './types.js';

/**
 * Compare the two documents' security scheme definitions — `ApiSpec.auth`,
 * the parsed `components.securitySchemes` — by `schemeName` (#384).
 *
 * A requirement under `security` names a scheme; the definition says what a
 * request carrying it puts on the wire. `security-changed` and
 * `securityChanged` compare the requirements, so this is where a scheme that
 * changes its header, its location or its kind under the same name is
 * reported. A scheme the new document declares and the old did not is
 * `security-scheme-added`, additive. One the old declared and the new does
 * not is `security-scheme-removed`: breaking when some request read it —
 * the scheme is in use in the old document, or in the new one, which then
 * requires what it does not define — and additive when nothing did, as a
 * server variable no template references is (#342). One both declare whose
 * definitions differ in anything but `description` (documentation is never
 * a change, as everywhere in the differ) is `security-scheme-modified`:
 * breaking when its wire form changed and the scheme is in use in the new
 * document, since an SDK built for the old definition sends what the
 * server no longer reads; additive when nothing in the new document uses
 * it, or when only an `oauth2` flow's `scopes` map changed — the scopes a
 * request needs are the requirement's, which `security-changed` already
 * compares.
 *
 * The wire form is the scheme's `kind`; for an `apiKey` also `in` and
 * `name`; for `oauth2` the `flows` object compared deeply, key order aside,
 * with each flow's `scopes` map taken out — so a changed `authorizationUrl`,
 * `tokenUrl` or `refreshUrl`, a flow added or removed, or a flow's other
 * keys changing are wire-form changes, and a difference confined to
 * `scopes` (a scope added, removed or re-described) is reported but
 * additive. An `apiKey` header's `name` is compared folded
 * (`foldHeaderName`, through `foldParameterName`): HTTP header names are
 * case-insensitive (RFC 9110 §5.1), so a header respelled `X-Key` → `x-key`
 * is still reported — the spelling is visible in `details` — but additive,
 * as a case-only header parameter rename is (`param-name-changed`); a
 * query or cookie name is case-sensitive and compared as written.
 *
 * A scheme is in use in a document when the effective requirement list of
 * at least one of its operations, webhooks or callbacks — `node.security ??
 * spec.security ?? []`, the resolution `securityShift` uses — names it, so
 * the document default counts only through a node that inherits it
 * (`schemesInUse`). Both sides of the wire are treated alike: a scheme a
 * webhook's or a callback's requirement names is read by the handler, and a
 * changed header name breaks the handler as it breaks a caller.
 *
 * The changes are listed added (new document order), removed (old document
 * order), modified (new document order), as `diffEnums` lists an enum's.
 * A scheme the parser omits from `auth` (an unsupported `http` scheme,
 * `openIdConnect`, `mutualTLS`; see `extractAuthSchemes`) is invisible
 * here. `auth` absent and `[]` both read as no schemes.
 */
export function diffAuthSchemes(oldSpec: ApiSpec, newSpec: ApiSpec): SecuritySchemeChange[] {
  const oldByName = new Map((oldSpec.auth ?? []).map((scheme) => [scheme.schemeName, scheme]));
  const newByName = new Map((newSpec.auth ?? []).map((scheme) => [scheme.schemeName, scheme]));
  // Resolved once per document: every removed or modified scheme asks the
  // same question of it.
  const oldInUse = schemesInUse(oldSpec);
  const newInUse = schemesInUse(newSpec);
  const changes: SecuritySchemeChange[] = [];

  for (const [schemeName, scheme] of newByName) {
    if (!oldByName.has(schemeName)) {
      changes.push({ kind: 'security-scheme-added', schemeName, scheme, classification: 'additive' });
    }
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
    if (!oldScheme || isDeepStrictEqual(definition(oldScheme), definition(newScheme))) continue;
    const wireFormChanged = !isDeepStrictEqual(wireForm(oldScheme), wireForm(newScheme));
    changes.push({
      kind: 'security-scheme-modified',
      schemeName,
      oldScheme,
      newScheme,
      details: schemeDetails(oldScheme, newScheme, wireFormChanged),
      // Only a request the new document sends under the old form breaks;
      // a scheme nothing there uses, or one whose scopes alone moved, puts
      // nothing different on the wire.
      classification: wireFormChanged && newInUse.has(schemeName) ? 'breaking' : 'additive',
    });
  }

  return changes;
}

/**
 * The names of every scheme some request in `spec` carries: those named by
 * the effective requirement list — `node.security ?? spec.security ?? []`
 * — of at least one operation, webhook or callback, the callbacks of each
 * operation and webhook visited recursively (a callback is a request the
 * handler reads, as a webhook is; #382). The document default counts only
 * through a node that inherits it, so a default every operation overrides
 * puts nothing in use, and a scheme no requirement names is read by no
 * request. Exported for tests.
 */
export function schemesInUse(spec: ApiSpec): Set<string> {
  const used = new Set<string>();
  const visit = (node: { security?: SecurityRequirementSet[]; callbacks?: Callback[] }): void => {
    for (const alternative of node.security ?? spec.security ?? []) {
      for (const requirement of alternative) used.add(requirement.schemeName);
    }
    for (const callback of node.callbacks ?? []) visit(callback);
  };
  for (const service of spec.services) for (const op of service.operations) visit(op);
  for (const webhook of spec.webhooks ?? []) visit(webhook);
  return used;
}

/** What a definition says beyond its name and `description`: the fields `AuthScheme` types for its kind. */
function definition(scheme: AuthScheme): unknown {
  switch (scheme.kind) {
    case 'apiKey':
      return { kind: scheme.kind, in: scheme.in, name: scheme.name };
    case 'oauth2':
      return { kind: scheme.kind, flows: scheme.flows };
    default:
      return { kind: scheme.kind };
  }
}

/**
 * The definition's wire form: `definition` with an `apiKey` header's `name`
 * folded (`foldParameterName`: HTTP header names are case-insensitive, RFC
 * 9110 §5.1, so `X-Key` and `x-key` are one header, as they are one header
 * parameter; a query or cookie name is case-sensitive and kept as written)
 * and with each `oauth2` flow's `scopes` map taken out.
 */
function wireForm(scheme: AuthScheme): unknown {
  switch (scheme.kind) {
    case 'apiKey':
      return { kind: scheme.kind, in: scheme.in, name: foldParameterName(scheme.in, scheme.name) };
    case 'oauth2': {
      const flows = Object.fromEntries(
        Object.entries(scheme.flows).map(([flowName, flow]) => [flowName, withoutScopes(flow)]),
      );
      return { kind: scheme.kind, flows };
    }
    default:
      return definition(scheme);
  }
}

/** A flow object without its `scopes` key; a flow that is not an object (a malformed document) is kept as it is. */
function withoutScopes(flow: unknown): unknown {
  if (typeof flow !== 'object' || flow === null || Array.isArray(flow)) return flow;
  return Object.fromEntries(Object.entries(flow).filter(([key]) => key !== 'scopes'));
}

/** A scheme's kind in words: `http basic`, `http bearer`, `apiKey`, `oauth2`. */
function kindLabel(scheme: AuthScheme): string {
  return scheme.kind === 'basic' || scheme.kind === 'bearer' ? `http ${scheme.kind}` : scheme.kind;
}

/**
 * What changed, in words, for a `security-scheme-modified` change: `apiKey
 * → http basic` for a changed kind; `apiKey in header "X-Key" → in header
 * "X-Api-Key"` for an `apiKey` whose location or name moved; `oauth2 flows
 * changed` when an `oauth2` scheme's wire form moved, `oauth2 scopes
 * changed` when only a flow's `scopes` did.
 */
function schemeDetails(oldScheme: AuthScheme, newScheme: AuthScheme, wireFormChanged: boolean): string {
  if (oldScheme.kind !== newScheme.kind) return `${kindLabel(oldScheme)} → ${kindLabel(newScheme)}`;
  if (oldScheme.kind === 'apiKey' && newScheme.kind === 'apiKey') {
    return `apiKey in ${oldScheme.in} "${oldScheme.name}" → in ${newScheme.in} "${newScheme.name}"`;
  }
  // Two `basic` or two `bearer` schemes carry nothing but their kind, so
  // only two `oauth2` schemes of one kind reach here.
  return wireFormChanged ? 'oauth2 flows changed' : 'oauth2 scopes changed';
}
