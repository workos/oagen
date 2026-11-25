/**
 * What a compat snapshot records about its declared types, and the questions
 * the differ asks of it.
 *
 * A snapshot is a flat list of symbols. A type is a symbol others name as
 * their owner (an interface, a model class, a type alias, a service class, an
 * enum), its members are the `field` and `property` symbols it owns, its
 * supertypes are the entries of its `extends`, and a type alias also carries
 * the text it stands for (`aliasOf`). This module indexes that once per
 * snapshot (`declaredTypes`) and answers from the index:
 *
 *  - `declaresSupertype`: does a type declare, directly or through a chain,
 *    that it extends another?
 *  - `inputTypes`: which types do callers build, because a callable or a
 *    constructor takes them?
 *  - `isObjectAlias`, `isRecordedByNameOnly`: does the snapshot record a type
 *    alias's members, or its name alone?
 *
 * Every key read here is one an older snapshot lacks (`extends`, `aliasOf`,
 * the members of an alias), so each answer is "no" or "not reachable" where
 * the snapshot does not say, never a guess.
 */

import type { CompatSnapshot, CompatSymbol } from './ir.js';
import { supertypeName, typeNamesIn } from './type-names.js';

/** One declared type of a snapshot. */
export interface DeclaredType {
  /** The type's own symbol. Undefined when the snapshot holds members that
   *  name an owner it has no symbol for. */
  symbol?: CompatSymbol;
  /** The `field` and `property` symbols the type owns. */
  members: CompatSymbol[];
  /** Whether any symbol at all names the type as its owner: a member, a
   *  constructor, a method. */
  ownsSymbols: boolean;
}

/** A snapshot's declared types, by name (`CompatSymbol.fqName`). */
export type DeclaredTypes = ReadonlyMap<string, DeclaredType>;

const TYPE_KINDS: ReadonlySet<string> = new Set(['alias', 'service_accessor', 'enum']);

/** Index a snapshot's declared types. */
export function declaredTypes(snapshot: CompatSnapshot): DeclaredTypes {
  const types = new Map<string, DeclaredType>();
  const typeNamed = (name: string): DeclaredType => {
    let type = types.get(name);
    if (!type) {
      type = { members: [], ownsSymbols: false };
      types.set(name, type);
    }
    return type;
  };
  for (const sym of snapshot.symbols) {
    if (typeof sym.ownerFqName === 'string') {
      const owner = typeNamed(sym.ownerFqName);
      owner.ownsSymbols = true;
      if (sym.kind === 'field' || sym.kind === 'property') owner.members.push(sym);
    } else if (typeof sym.fqName === 'string' && TYPE_KINDS.has(sym.kind)) {
      // The first symbol of a name is the type; a second one (a snapshot
      // put together by hand) adds nothing.
      typeNamed(sym.fqName).symbol ??= sym;
    }
  }
  return types;
}

/** The supertype entries a type's symbol carries; none when it has no
 *  `extends`, as every symbol of an older snapshot. */
function supertypeEntries(type: DeclaredType | undefined): string[] {
  const entries = type?.symbol?.extends;
  return Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Does `typeName` declare that it extends `supertype`, directly or through
 * the types it extends?
 *
 * `DetailedErrorBody extends ErrorBody` does, and so does a type that extends
 * `DetailedErrorBody`. The relation is the declared one, read from each
 * type's `extends` by name (`supertypeName`): two types with the same members
 * are unrelated here, an instantiation (`extends Partial<ErrorBody>`) declares
 * nothing, and a type is not its own supertype. A chain is followed only
 * through types the snapshot declares, each once, so a cycle ends.
 */
export function declaresSupertype(types: DeclaredTypes, typeName: string, supertype: string): boolean {
  if (typeName === supertype) return false;
  const seen = new Set<string>([typeName]);
  const pending = [typeName];
  while (pending.length > 0) {
    for (const entry of supertypeEntries(types.get(pending.pop()!))) {
      const name = supertypeName(entry);
      if (name === undefined || seen.has(name)) continue;
      if (name === supertype) return true;
      seen.add(name);
      pending.push(name);
    }
  }
  return false;
}

/**
 * The types callers build: every declared type reachable from the type of a
 * parameter of a callable or a constructor. The value is the callable (its
 * `fqName`) whose parameters lead to the type, the first one in snapshot
 * order, for the report to name.
 *
 * A snapshot records no direction, so this is how one is told: a type a
 * callable takes is one a caller has to produce, and so is every type that
 * one is built from. From a type the walk goes on through
 *
 *  - the types of its members (`field` and `property` symbols),
 *  - its supertypes (`extends`), whose members a caller supplies as well,
 *  - the text a type alias stands for (`aliasOf`),
 *
 * and each text is read for every name it mentions (`typeNamesIn`): a union's
 * members, an array's element, a generic's arguments. A type is visited once,
 * so a type that refers to itself ends the walk. A type that is both taken
 * and returned counts as taken.
 *
 * Every constructor is a root, a service class's included, though the differ
 * does not compare those: `new Client(options)` is how `options` is built.
 */
export function inputTypes(
  snapshot: CompatSnapshot,
  types: DeclaredTypes = declaredTypes(snapshot),
): Map<string, string> {
  const takenBy = new Map<string, string>();
  const pending: string[] = [];
  const reach = (typeText: unknown, callable: string): void => {
    if (typeof typeText !== 'string') return;
    for (const name of typeNamesIn(typeText)) {
      if (takenBy.has(name) || !types.has(name)) continue;
      takenBy.set(name, callable);
      pending.push(name);
    }
  };

  for (const sym of snapshot.symbols) {
    if (sym.kind !== 'callable' && sym.kind !== 'constructor') continue;
    if (!Array.isArray(sym.parameters)) continue;
    for (const param of sym.parameters) reach(param?.type?.name, sym.fqName);
    // Follow what this callable reaches before the next one starts, so each
    // type is credited to the first callable that leads to it.
    while (pending.length > 0) {
      const name = pending.shift()!;
      const type = types.get(name)!;
      const callable = takenBy.get(name)!;
      for (const member of type.members) reach(member.typeRef?.name, callable);
      for (const entry of supertypeEntries(type)) reach(entry, callable);
      reach(type.symbol?.aliasOf, callable);
    }
  }
  return takenBy;
}

/** A type alias whose members the snapshot records: it carries the text it
 *  stands for and, as every type with recorded members, an `extends`. */
export function isObjectAlias(type: DeclaredType | undefined): boolean {
  return typeof type?.symbol?.aliasOf === 'string' && type.symbol.extends !== undefined;
}

/**
 * A type the snapshot records by name alone: an `alias` symbol with no
 * `extends` and nothing that names it as an owner. That is every type alias
 * of a snapshot written before aliases carried members, and an alias that is
 * not an object type in one written since (a union, a mapped type, a
 * reference to another type). Such a symbol says nothing about the type's
 * members, not that it has none.
 */
export function isRecordedByNameOnly(type: DeclaredType | undefined): boolean {
  return type?.symbol?.kind === 'alias' && type.symbol.extends === undefined && !type.ownsSymbols;
}
