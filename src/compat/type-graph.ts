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
 *    constructor takes them, and which of a type's members do they supply?
 *  - `isObjectAlias`, `isRecordedByNameOnly`: does the snapshot record a type
 *    alias's members, or its name alone?
 *  - `recordedMembers`: which members does a value of a type have, each
 *    required or not, when the snapshot records them all?
 *
 * Every key read here is one an older snapshot lacks (`extends`, `aliasOf`,
 * `optional`, the members of an alias), so each answer is "no", "not
 * reachable" or "not recorded" where the snapshot does not say, never a
 * guess.
 */

import type { CompatSnapshot, CompatSymbol } from './ir.js';
import { keepsMember, supertypeName, typesTakenIn, WHOLE_TYPE, type TypePart } from './type-names.js';

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

/** Looking a declared type up by its name: a snapshot's `DeclaredTypes`, or
 *  two of them read one behind the other. */
export type TypeLookup = Pick<DeclaredTypes, 'get'>;

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
 * The types callers build, as `inputTypes` finds them: each by its name, with
 * the first callable (its `fqName`) that leads to it, in snapshot order, for
 * the report to name. A type is here when a callable takes any part of it;
 * the two methods say which of its members that is.
 */
export interface InputTypes extends ReadonlyMap<string, string> {
  /**
   * The callable whose callers supply this member (a `field` or `property`
   * symbol, of this snapshot or of another one of the SDK) when they build
   * the type that owns it, or undefined when none does: no callable takes
   * the type, or each one that does takes a part the member is left out of
   * (`Omit<Owner, 'ownerId'>`, `Pick<Owner, 'name'>`).
   */
  member(member: CompatSymbol): string | undefined;
  /**
   * The callable whose callers have to supply this member once its type
   * declares it required: as `member`, less the callables that take the
   * type with no member required (`Partial<Owner>`).
   */
  requiredMember(member: CompatSymbol): string | undefined;
}

/**
 * The types callers build: every declared type reachable from the type of a
 * parameter of a callable or a constructor, with the members of it they
 * supply.
 *
 * A snapshot records no direction, so this is how one is told: a type a
 * callable takes is one a caller has to produce, and so is every type that
 * one is built from. From a type the walk goes on through
 *
 *  - the types of its members (`field` and `property` symbols),
 *  - its supertypes (`extends`), whose members a caller supplies as well,
 *  - the text a type alias stands for (`aliasOf`),
 *
 * and each text is read for every name it mentions and the part of that type
 * it takes (`typesTakenIn`): a union's members, an array's element, a
 * generic's arguments, each whole, and the argument of an `Omit`, a `Pick`
 * or a `Partial` less the members those leave out or no longer require. A
 * member a part leaves out is not one callers supply, so the walk does not
 * go on through its type; a supertype and what an alias stands for are taken
 * in the part their type is, since `Omit<Child, 'id'>` leaves out the `id`
 * `Child` inherits as well.
 *
 * A type may be reached more than once, in parts that differ, and a member
 * counts as supplied when one of them keeps it: `create(options:
 * Omit<Owner, 'ownerId'>, owner: Owner)` takes `Owner` whole. A type is
 * walked once for each part no earlier one covers, and there are only so
 * many parts as the texts spell keys, so a type that refers to itself ends
 * the walk. A type that is both taken and returned counts as taken.
 *
 * Every constructor is a root, a service class's included, though the differ
 * does not compare those: `new Client(options)` is how `options` is built.
 */
export function inputTypes(snapshot: CompatSnapshot, types: DeclaredTypes = declaredTypes(snapshot)): InputTypes {
  const takenBy = new Map<string, string>();
  const reached = new Map<string, Reached[]>();
  const pending: Reached[] = [];
  const reach = (typeText: unknown, callable: string, part: TypePart = WHOLE_TYPE): void => {
    if (typeof typeText !== 'string') return;
    for (const taken of typesTakenIn(typeText, part)) {
      if (!types.has(taken.name)) continue;
      let parts = reached.get(taken.name);
      if (parts === undefined) {
        parts = [];
        reached.set(taken.name, parts);
        takenBy.set(taken.name, callable);
      }
      if (parts.some((earlier) => covers(earlier.part, taken.part))) continue;
      const next = { name: taken.name, part: taken.part, callable };
      parts.push(next);
      pending.push(next);
    }
  };

  for (const sym of snapshot.symbols) {
    if (sym.kind !== 'callable' && sym.kind !== 'constructor') continue;
    if (!Array.isArray(sym.parameters)) continue;
    for (const param of sym.parameters) reach(param?.type?.name, sym.fqName);
    // Follow what this callable reaches before the next one starts, so each
    // type is credited to the first callable that leads to it.
    while (pending.length > 0) {
      const { name, part, callable } = pending.shift()!;
      const type = types.get(name)!;
      for (const member of type.members) {
        if (keepsMember(part, memberName(member))) reach(member.typeRef?.name, callable);
      }
      for (const entry of supertypeEntries(type)) reach(entry, callable, part);
      reach(type.symbol?.aliasOf, callable, part);
    }
  }

  const supplier = (member: CompatSymbol, required: boolean): string | undefined => {
    const parts = typeof member.ownerFqName === 'string' ? reached.get(member.ownerFqName) : undefined;
    const name = memberName(member);
    return parts?.find(({ part }) => keepsMember(part, name) && !(required && part.optional))?.callable;
  };
  return Object.assign(takenBy, {
    member: (member: CompatSymbol) => supplier(member, false),
    requiredMember: (member: CompatSymbol) => supplier(member, true),
  });
}

/** One way a type is reached: the part of it taken, and the callable whose
 *  parameters lead there. */
interface Reached {
  name: string;
  part: TypePart;
  callable: string;
}

/** Whether a part takes every member another does, and requires every member
 *  the other requires: reaching a type in `part` then adds nothing to having
 *  reached it in `earlier`. */
function covers(earlier: TypePart, part: TypePart): boolean {
  if (earlier.optional && !part.optional) return false;
  if (earlier.only) return part.only && [...part.keys].every((key) => earlier.keys.has(key));
  return [...earlier.keys].every((key) => !keepsMember(part, key));
}

/** A member's own name, as an `Omit` or a `Pick` lists it: its `fqName`
 *  without its owner's in front, and without the quotes a member the source
 *  writes in quotes may be recorded with (`Owner."owner-id"`). */
function memberName(member: CompatSymbol): string {
  const { fqName, ownerFqName } = member;
  if (typeof fqName !== 'string') return '';
  const name =
    typeof ownerFqName === 'string' && fqName.startsWith(`${ownerFqName}.`)
      ? fqName.slice(ownerFqName.length + 1)
      : fqName;
  const quote = name[0];
  return name.length > 1 && (quote === '"' || quote === "'") && name.endsWith(quote) ? name.slice(1, -1) : name;
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

/** A member of a type, as `recordedMembers` reads it. */
export interface RecordedMember {
  /** The member's type text: as the extractor's checker resolves it where
   *  the snapshot records that beside the text baselines hold
   *  (`CompatSymbol.resolvedType`), `typeRef.name` otherwise. */
  type: string;
  /** Whether a caller that builds the type may leave the member out. */
  optional: boolean;
}

/**
 * Every member a value of `typeName` has, by the member's own name, or
 * undefined when the snapshot does not record them all.
 *
 * It records them all for a type whose symbol carries `extends` (an
 * interface, a model class, a type alias of an object shape) when
 *
 *  - the extractor says the fields are all a value may carry
 *    (`hasUnlistedMembers: false`): no index signature takes other keys, no
 *    call signature makes the value a function,
 *  - each symbol the type owns as a member is a `field` with a type text and
 *    an `optional` that is `true` or `false`, and
 *  - each supertype its `extends` names, directly or through a chain, is a
 *    name alone (`supertypeName`) of a type the snapshot records the same
 *    way.
 *
 * The members are the type's own and, beside them, the ones of the types it
 * extends: an extractor may list an inherited member under the subtype
 * (TypeScript's does, with the type the subtype gives it) or under the
 * supertype only. The type's own record of a member is the one read; a
 * member it does not list, and two of the types it extends declare
 * differently, is not one this can settle.
 *
 * Undefined, then, for a type alias recorded by name only, a class
 * (`service_accessor`, whose properties carry no `optional`), an enum, a type
 * with a field whose optionality the extractor could not tell, a type with
 * an index signature or from an extractor that does not say, a type that
 * extends an instantiation (`extends Partial<Base>`) or a type the snapshot
 * does not declare, and every type of a snapshot written before the keys
 * existed. Each type of a chain is read once, so a cycle ends.
 */
export function recordedMembers(types: TypeLookup, typeName: string): ReadonlyMap<string, RecordedMember> | undefined {
  const members = ownMembers(types.get(typeName), typeName);
  if (members === undefined) return undefined;
  const inherited = new Map<string, RecordedMember>();
  const seen = new Set<string>([typeName]);
  const pending = [typeName];
  while (pending.length > 0) {
    // `ownMembers` answered for every type that gets here, so each has an
    // `extends` list.
    for (const entry of types.get(pending.pop()!)?.symbol?.extends ?? []) {
      const supertype = typeof entry === 'string' ? supertypeName(entry) : undefined;
      if (supertype === undefined) return undefined;
      if (seen.has(supertype)) continue;
      seen.add(supertype);
      const supertypeMembers = ownMembers(types.get(supertype), supertype);
      if (supertypeMembers === undefined) return undefined;
      for (const [name, member] of supertypeMembers) {
        if (members.has(name)) continue;
        const other = inherited.get(name);
        if (other !== undefined && (other.type !== member.type || other.optional !== member.optional)) return undefined;
        inherited.set(name, member);
      }
      pending.push(supertype);
    }
  }
  for (const [name, member] of inherited) members.set(name, member);
  return members;
}

/** The members a type's own symbols record, or undefined when the type is
 *  not one whose members are recorded or one of them is not a whole record. */
function ownMembers(type: DeclaredType | undefined, typeName: string): Map<string, RecordedMember> | undefined {
  if (type?.symbol?.kind !== 'alias' || !Array.isArray(type.symbol.extends)) return undefined;
  if (type.symbol.hasUnlistedMembers !== false) return undefined;
  const members = new Map<string, RecordedMember>();
  for (const member of type.members) {
    const name =
      typeof member.fqName === 'string' && member.fqName.startsWith(`${typeName}.`)
        ? member.fqName.slice(typeName.length + 1)
        : '';
    // A field with a recorded optionality is compared by its resolved type
    // where it carries one, as the classifier compares it.
    const text = typeof member.resolvedType === 'string' ? member.resolvedType : member.typeRef?.name;
    if (member.kind !== 'field' || name === '' || typeof text !== 'string' || typeof member.optional !== 'boolean') {
      return undefined;
    }
    // A second symbol of a name (a snapshot put together by hand) adds
    // nothing, as a second type symbol does not.
    if (!members.has(name)) members.set(name, { type: text, optional: member.optional });
  }
  return members;
}
