import type { SecurityRequirementSet } from '../ir/types.js';

/**
 * The two documents' `security`, so a node that declares none of its own can
 * be compared on what it actually inherits (`node.security ?? document
 * security`). `diffSpecs` supplies it; a direct caller may leave it out, in
 * which case a node that inherits is compared as requiring no authentication.
 */
export interface DocumentSecurity {
  old: SecurityRequirementSet[] | undefined;
  new: SecurityRequirementSet[] | undefined;
}

/**
 * Which side of the wire reads a security change. A `caller` (an operation's
 * client) built for the old requirements presents one of the old alternatives
 * and must still satisfy the new; a `receiver` (a webhook handler) built for
 * the old requirements checks for one of the old alternatives, and whatever
 * the sender now presents — one of the new alternatives — must still carry it.
 */
export type SecuritySide = 'caller' | 'receiver';

/** The two sides of a security change, carried on the change that reports it. */
export interface SecurityShift {
  /** What a request had to satisfy before: the node's own list, else the document's, `[]` when neither declares any. */
  oldSecurity: SecurityRequirementSet[];
  /** What a request has to satisfy now, resolved the same way. */
  newSecurity: SecurityRequirementSet[];
}

/** One alternative, folded so it compares as a set: scheme name → the scopes it needs. */
type Alternative = Map<string, Set<string>>;

/**
 * The alternatives a requirement list offers, each folded for set comparison.
 * `[]` (`security: []`) and a list left `undefined` everywhere both mean no
 * authentication, which is one alternative that needs nothing — the same
 * thing a document spells as `[{}]` — so the three compare equal.
 */
function alternativesOf(sets: SecurityRequirementSet[]): Alternative[] {
  const alternatives = sets.length === 0 ? [[]] : sets;
  return alternatives.map((set) => {
    const folded: Alternative = new Map();
    for (const requirement of set) {
      const scopes = folded.get(requirement.schemeName) ?? new Set<string>();
      for (const scope of requirement.scopes) scopes.add(scope);
      folded.set(requirement.schemeName, scopes);
    }
    return folded;
  });
}

/** Whether `presented` carries everything `required` asks for: every scheme, with every scope. */
function covers(presented: Alternative, required: Alternative): boolean {
  for (const [schemeName, scopes] of required) {
    const carried = presented.get(schemeName);
    if (!carried) return false;
    for (const scope of scopes) if (!carried.has(scope)) return false;
  }
  return true;
}

/**
 * Whether two requirement lists demand the same thing: the same alternatives
 * as a set, each the same schemes with the same scopes as sets. Order,
 * repeated alternatives and repeated scopes do not count.
 */
export function securityEqual(a: SecurityRequirementSet[], b: SecurityRequirementSet[]): boolean {
  const left = alternativesOf(a);
  const right = alternativesOf(b);
  const same = (x: Alternative, y: Alternative): boolean => covers(x, y) && covers(y, x);
  return left.every((x) => right.some((y) => same(x, y))) && right.every((y) => left.some((x) => same(x, y)));
}

/**
 * Whether a request built for `presented` still satisfies `required`: every
 * alternative of `presented` carries everything some alternative of
 * `required` asks for. A requirement that offers an anonymous alternative
 * (`[{}]`, or no authentication at all) is satisfied by anything.
 */
export function securitySatisfied(required: SecurityRequirementSet[], presented: SecurityRequirementSet[]): boolean {
  const alternatives = alternativesOf(required);
  return alternativesOf(presented).every((carried) => alternatives.some((asked) => covers(carried, asked)));
}

/**
 * How a change from `oldSecurity` to `newSecurity` lands on `side`. Breaking
 * when a request built for the old list no longer passes: for a caller, some
 * old alternative satisfies no new one (a scheme or scope a request now has
 * to carry, an alternative it could use that is gone, an anonymous
 * alternative withdrawn); for a receiver, some new alternative carries no old
 * one (a scheme the sender stops presenting, an alternative it may now use
 * that the handler never checked for). Additive otherwise: a new alternative
 * a caller may use, a scope or scheme it no longer needs, a credential the
 * sender starts carrying beside what the handler already checks.
 */
export function classifySecurityChange(
  oldSecurity: SecurityRequirementSet[],
  newSecurity: SecurityRequirementSet[],
  side: SecuritySide,
): 'additive' | 'breaking' {
  const stillPasses =
    side === 'caller' ? securitySatisfied(newSecurity, oldSecurity) : securitySatisfied(oldSecurity, newSecurity);
  return stillPasses ? 'additive' : 'breaking';
}

/**
 * `{ oldSecurity, newSecurity }` when what a node's requests must carry
 * differs between the two documents, `undefined` when it does not. Each side
 * is the node's own `security`, else that document's (`document`), else none.
 * Absent on both sides is "inherits" twice: a moved document default is the
 * document-level `security-changed` entry's to report, so it is not a change
 * to the node. Otherwise the two effective lists are compared, so a document
 * that moves to what the node already declared (and the node's override
 * vanishing with it) is no change to the node.
 */
export function securityShift(
  oldNode: { security?: SecurityRequirementSet[] },
  newNode: { security?: SecurityRequirementSet[] },
  document?: DocumentSecurity,
): SecurityShift | undefined {
  if (oldNode.security === undefined && newNode.security === undefined) return undefined;
  const oldSecurity = oldNode.security ?? document?.old ?? [];
  const newSecurity = newNode.security ?? document?.new ?? [];
  return securityEqual(oldSecurity, newSecurity) ? undefined : { oldSecurity, newSecurity };
}
