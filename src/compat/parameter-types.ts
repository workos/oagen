/**
 * Whether a parameter's new type accepts every value of its old one.
 *
 * A callable whose parameter was retyped still takes every argument callers
 * pass today when the new type accepts each value of the old one, and then
 * no call site stops compiling. `acceptsEveryValue` is the one place that
 * answers, from the two type texts and what each snapshot records about the
 * types they name. Two rules find it, and the policy says which is asked
 * (`CompatPolicyHints.parameterTypesAreStructural`):
 *
 *  - **Declared.** The old type declares, directly or through a chain, that
 *    it extends the new one: the parameter was widened to a supertype. Asked
 *    where a value is accepted by the type it was declared as (a class).
 *  - **By shape.** The new type keeps every member of the old one. For a
 *    union those are the types it joins; for an object type, its fields,
 *    none of which the new type may newly require. Asked where a value is
 *    accepted by its shape and may be written in place as an object literal
 *    (TypeScript).
 *
 * This is the reverse of the question a field or a return is asked. A value
 * callers read may be retyped to a subtype (`declaresSupertype(new, old)`):
 * what they get is still what they expected. A value callers pass may be
 * retyped to a supertype, or to a shape that takes more: what they give is
 * still taken.
 *
 * Where a snapshot does not say, the answer is no. A policy that does not
 * state the hint, a type the snapshot does not declare, a type whose members
 * it does not record whole, a field of unknown optionality and a type text
 * the extractor cut short all leave the retype as it was reported.
 */

import type { DeclaredTypes, RecordedMember, TypeLookup } from './type-graph.js';
import { declaresSupertype, recordedMembers } from './type-graph.js';
import {
  handsBackItsArgument,
  objectTypeMembers,
  singleArgumentGeneric,
  soleTypeName,
  typeNamesIn,
  unionMembers,
} from './type-names.js';

/** What `acceptsEveryValue` reads beside the two type texts. */
export interface ParameterTypeContext {
  /** `CompatPolicyHints.parameterTypesAreStructural` of the policy the diff
   *  runs under, as it stands: anything but `true` or `false` asks neither
   *  rule. */
  structural: unknown;
  /** The baseline's declared types: what the values callers pass today are
   *  values of. The whole baseline's, where the compared one is a part. */
  baselineTypes: DeclaredTypes;
  /** The candidate's declared types: what the parameter takes now, and what
   *  the code callers have written will be compiled against. */
  candidateTypes: DeclaredTypes;
}

/** Two types, the first of which a parameter took and the second of which
 *  it takes now. */
export interface RetypedPair {
  oldType: string;
  newType: string;
}

/**
 * How a new parameter type was found to accept the old one, for the report
 * to say: by the supertype the old type declares, or by shape. `fields` are
 * the object types that were set against each other field by field on the
 * way, none when the unions' members said it all.
 */
export type ParameterTypeAcceptance =
  | ({ rule: 'declared-supertype' } & RetypedPair)
  | { rule: 'shape'; fields: RetypedPair[] };

/**
 * Does `newText` accept every value of `oldText`? Returns the rule that says
 * so, or undefined when neither does or the snapshots cannot tell.
 */
export function acceptsEveryValue(
  oldText: unknown,
  newText: unknown,
  context: ParameterTypeContext,
): ParameterTypeAcceptance | undefined {
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
  if (context.structural === false) return widensToDeclaredSupertype(oldText, newText, context.candidateTypes);
  if (context.structural !== true) return undefined;
  // The old type is read twice. A value callers pass today is a value of the
  // type as the baseline declares it; the code that names the type will be
  // compiled against the candidate's declaration of it. An argument keeps
  // being taken only when the new type accepts both.
  const fields = new Map<string, RetypedPair>();
  const accepts = (oldTypes: TypeLookup): boolean =>
    acceptsByShape(oldText, newText, {
      oldTypes,
      newTypes: context.candidateTypes,
      verdicts: new Map(),
      open: new Set(),
      assumed: new Set(),
      settledYes: [],
      fields,
    });
  return accepts(context.baselineTypes) && accepts(oldTypesOfCandidate(context))
    ? { rule: 'shape', fields: [...fields.values()] }
    : undefined;
}

// ---------------------------------------------------------------------------
// Declared: the parameter was widened to a supertype
// ---------------------------------------------------------------------------

/**
 * The old type declares that it extends the new one, and the retype does
 * nothing else: both texts are one declared type's name under an optional
 * spelling or one array suffix (`soleTypeName`), and they are one text with
 * the name swapped. `?RetryOptions` → `?BaseOptions` is; `RetryOptions` →
 * `BaseOptions[]` asks callers for a list, and `?RetryOptions` →
 * `BaseOptions` no longer takes the `null` they may pass.
 *
 * The declaration is the candidate's: the value a caller passes is built
 * from the old type as the SDK declares it now.
 */
function widensToDeclaredSupertype(
  oldText: string,
  newText: string,
  candidateTypes: DeclaredTypes,
): ParameterTypeAcceptance | undefined {
  const oldType = soleTypeName(oldText);
  const newType = soleTypeName(newText);
  if (oldType === undefined || newType === undefined) return undefined;
  if (!sameTextAround(oldText, oldType, newText, newType)) return undefined;
  return declaresSupertype(candidateTypes, oldType, newType)
    ? { rule: 'declared-supertype', oldType, newType }
    : undefined;
}

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

/** Whether two texts are one text with a type's name swapped: what stands
 *  around `oldName` in the one is what stands around `newName` in the other. */
function sameTextAround(oldText: string, oldName: string, newText: string, newName: string): boolean {
  const oldPieces = piecesAround(oldText, oldName);
  const newPieces = piecesAround(newText, newName);
  return oldPieces.length === newPieces.length && oldPieces.every((piece, index) => piece === newPieces[index]);
}

/** `text` cut at each whole-word occurrence of `name`: the pieces that stand
 *  before, between and after them. */
function piecesAround(text: string, name: string): string[] {
  const pieces: string[] = [];
  let piece = '';
  let from = 0;
  // An empty name occurs everywhere and names nothing: the text is one piece.
  for (let at = name === '' ? -1 : text.indexOf(name); at !== -1; at = text.indexOf(name, from)) {
    const end = at + name.length;
    const wholeWord =
      !(at > 0 && IDENTIFIER_CHARACTER.test(text[at - 1])) &&
      !(end < text.length && IDENTIFIER_CHARACTER.test(text[end]));
    piece += text.slice(from, at);
    if (wholeWord) {
      pieces.push(piece);
      piece = '';
    } else {
      piece += name;
    }
    from = end;
  }
  pieces.push(piece + text.slice(from));
  pieces[0] = pieces[0].trimStart();
  pieces[pieces.length - 1] = pieces[pieces.length - 1].trimEnd();
  return pieces;
}

// ---------------------------------------------------------------------------
// By shape: the new type keeps every member of the old one
// ---------------------------------------------------------------------------

/** What TypeScript prints in place of the members it leaves out of a long
 *  type: `"a" | "b" | ... 12 more ... | "z"`, `{ id: string; ... 4 more ...; }`. */
const ELIDED = /\.\.\. \d+ more \.\.\./;

interface ShapeContext {
  /** Where an old type's name is looked up: the baseline's declared types,
   *  or `oldTypesOfCandidate`. */
  oldTypes: TypeLookup;
  /** The candidate's declared types, where a new type's name is looked up. */
  newTypes: DeclaredTypes;
  /** The verdict of each pair of union members settled so far: a pair is
   *  weighed once, however many unions and fields lead to it. */
  verdicts: Map<string, boolean>;
  /** The pairs being weighed. Two types that refer to themselves
   *  (`Tree.children: Tree[]`) come back to their own pair through a field
   *  while it is open; there it is taken to hold, since it does unless one
   *  of its fields says otherwise. */
  open: Set<string>;
  /** The open pairs something was settled on the strength of. */
  assumed: Set<string>;
  /** The pairs settled as accepted, in the order they were: when a pair
   *  that was taken to hold turns out not to, what was settled since it
   *  opened is forgotten and weighed again. */
  settledYes: string[];
  /** The pairs of different object types found to accept each other by
   *  their fields, for the report to name. */
  fields: Map<string, RetypedPair>;
}

/**
 * The old types as the code callers have written will meet them: each name by
 * the candidate's declaration where it has one, by the baseline's where the
 * candidate dropped the type (its removal is reported on its own line, and a
 * value written without the name is still one of the baseline's type).
 */
function oldTypesOfCandidate(context: ParameterTypeContext): TypeLookup {
  return { get: (name) => context.candidateTypes.get(name) ?? context.baselineTypes.get(name) };
}

/**
 * Every member of the old union is accepted by a member of the new one. A
 * text that is no union is a union of one (`unionMembers`), so this is also
 * the question for two plain types. `string` → `string | number` and
 * `Options` → `Options | undefined` keep every member; `string | number` →
 * `string` and `string | null` → `string | undefined` lose one.
 *
 * A type alias the snapshot records by its text stands for that text on
 * either side (`type PetId = string | number` is `string` and `number`), so
 * a union reads the same written in place or under a name.
 */
function acceptsByShape(oldText: string, newText: string, context: ShapeContext): boolean {
  return membersAccept(
    membersBehindAliases(unionMembers(oldText), context.oldTypes),
    membersBehindAliases(unionMembers(newText), context.newTypes),
    context,
  );
}

function membersAccept(
  oldMembers: readonly string[] | undefined,
  newMembers: readonly string[] | undefined,
  context: ShapeContext,
): boolean {
  if (oldMembers === undefined || newMembers === undefined) return false;
  return oldMembers.every((oldMember) => newMembers.some((newMember) => memberAccepts(oldMember, newMember, context)));
}

/**
 * `members` with each type alias recorded by its text replaced by the
 * members of that text, through as many aliases as it takes. Each alias is
 * read once, so one that stands for itself (`type A = A | string`) adds what
 * else it stands for and ends. Undefined when `members` is, or an alias's
 * text does not read as a union.
 */
function membersBehindAliases(members: readonly string[] | undefined, types: TypeLookup): string[] | undefined {
  if (members === undefined) return undefined;
  const behind = new Set<string>();
  const read = new Set<string>();
  const pending = [...members];
  for (let next = 0; next < pending.length; next++) {
    const member = pending[next];
    if (read.has(member)) continue;
    const text = aliasText(types, member);
    if (text === undefined) {
      behind.add(member);
      continue;
    }
    read.add(member);
    const held = unionMembers(text);
    if (held === undefined) return undefined;
    pending.push(...held);
  }
  // An alias that stands for nothing but itself leaves no member to ask
  // about, which is no answer.
  return behind.size > 0 ? [...behind] : undefined;
}

/**
 * One member of the new union accepts one member of the old. Each is read for
 * what it is, the old one in the old snapshot and the new one in the new:
 *
 *  - an array, or a generic that hands its argument back, of a type that
 *    accepts the old one's (`holderAccepts`);
 *  - an object type that keeps the old one's fields (`fieldsAccept`), each
 *    of the two a declared type or written in place.
 *
 * That holds for two members of one text as well: the same name may stand
 * for two declarations (`Options` that lost a field, `Id[]` over an alias
 * that lost a member), and nothing else may report it, since a type alias's
 * text is compared nowhere and `oagen verify` leaves a type the spec does
 * not derive out of its comparison.
 *
 * Anything else is accepted as the same text only, and only when that text
 * stands for one type on both sides (`readsAlike`): a primitive, a literal, a
 * class, any other generic (`Record<string, Old>`), a tuple, a function type.
 * So a literal is not accepted by the primitive that would take it (`'asc'` →
 * `string`).
 *
 * A text the extractor cut short (`ELIDED`) is not the type: two of them
 * that read alike may differ in what was left out, so neither is accepted,
 * the same text included.
 */
function memberAccepts(oldMember: string, newMember: string, context: ShapeContext): boolean {
  if (ELIDED.test(oldMember) || ELIDED.test(newMember)) return false;
  const pair = JSON.stringify([oldMember, newMember]);
  const settled = context.verdicts.get(pair);
  if (settled !== undefined) return settled;
  if (context.open.has(pair)) {
    context.assumed.add(pair);
    return true;
  }

  context.open.add(pair);
  const settledBefore = context.settledYes.length;
  const verdict =
    holderAccepts(oldMember, newMember, context) ??
    fieldsAccept(oldMember, newMember, context) ??
    (oldMember === newMember && readsAlike(oldMember, context, new Set()));
  context.open.delete(pair);
  // What was settled on the strength of this pair holding does not stand
  // when it does not. A "no" needs no such care: taking a pair to hold can
  // only turn a "no" into a "yes".
  if (!verdict && context.assumed.has(pair)) {
    for (const forgotten of context.settledYes.splice(settledBefore)) {
      context.verdicts.delete(forgotten);
      context.fields.delete(forgotten);
    }
  }
  context.assumed.delete(pair);
  context.verdicts.set(pair, verdict);
  if (verdict) context.settledYes.push(pair);
  return verdict;
}

/**
 * Whether a text that is the same on both sides stands for one type on both:
 * every type it mentions (`typeNamesIn`) that a snapshot declares is declared
 * alike in the two.
 *
 *  - A type alias recorded by its text stands for the same text, and that
 *    text reads alike in turn.
 *  - A type whose fields are recorded whole has the same fields, each with
 *    the same optionality and the same type text, which reads alike in turn.
 *  - A type one side declares and the other does not is not one type.
 *
 * Anything else a snapshot declares (a class, an enum, a type recorded by
 * name only) is taken for one type: nothing more is recorded of it here, and
 * what changes of it is reported on its own lines. Each name is read once, so
 * a type that mentions itself ends.
 */
function readsAlike(text: string, context: ShapeContext, read: Set<string>): boolean {
  for (const name of typeNamesIn(text)) {
    if (read.has(name)) continue;
    read.add(name);
    const oldType = context.oldTypes.get(name);
    const newType = context.newTypes.get(name);
    if (oldType === undefined && newType === undefined) continue;
    if (oldType === undefined || newType === undefined) return false;

    const oldAlias = aliasText(context.oldTypes, name);
    const newAlias = aliasText(context.newTypes, name);
    if (oldAlias !== undefined || newAlias !== undefined) {
      if (oldAlias === undefined || newAlias === undefined || oldAlias.trim() !== newAlias.trim()) return false;
      if (!readsAlike(oldAlias, context, read)) return false;
      continue;
    }

    const oldFields = recordedMembers(context.oldTypes, name);
    const newFields = recordedMembers(context.newTypes, name);
    if (oldFields === undefined && newFields === undefined) continue;
    if (oldFields === undefined || newFields === undefined || oldFields.size !== newFields.size) return false;
    for (const [fieldName, oldField] of oldFields) {
      const newField = newFields.get(fieldName);
      if (newField === undefined || newField.optional !== oldField.optional) return false;
      if (newField.type.trim() !== oldField.type.trim() || !readsAlike(oldField.type, context, read)) return false;
    }
  }
  return true;
}

/**
 * Two types that hold values of another, weighed by what they hold; undefined
 * when the two are not such a pair.
 *
 *  - Two arrays: `Old[]` → `New[]`. A `readonly` array takes a writable one
 *    (`Old[]` → `readonly New[]`), and a writable array does not take a
 *    `readonly` one.
 *  - Two generics of one name around one argument, when the generic is known
 *    to hand its argument back and never take it (`handsBackItsArgument`: a
 *    promise, a collection) and neither snapshot declares a type of that
 *    name: `Promise<Old>` → `Promise<New>`. This is the list a field or a
 *    return narrowed to a declared subtype is read through, and it serves
 *    the other way around for the same reason: a `Promise<Old>` is a
 *    `Promise<New>` exactly when an `Old` is a `New`. Whether a `Sink<Old>`
 *    is a `Sink<New>` depends on how `Sink` uses its argument, which neither
 *    a type text nor the snapshot says.
 */
function holderAccepts(oldMember: string, newMember: string, context: ShapeContext): boolean | undefined {
  const oldArray = arrayOf(oldMember);
  const newArray = arrayOf(newMember);
  if (oldArray !== undefined && newArray !== undefined) {
    if (oldArray.readonly && !newArray.readonly) return false;
    return acceptsByShape(oldArray.element, newArray.element, context);
  }
  const oldGeneric = singleArgumentGeneric(oldMember);
  const newGeneric = singleArgumentGeneric(newMember);
  if (oldGeneric === undefined || newGeneric === undefined || oldGeneric.generic !== newGeneric.generic) {
    return undefined;
  }
  const declared = typeNamesIn(oldGeneric.generic).some(
    (name) => context.oldTypes.get(name) !== undefined || context.newTypes.get(name) !== undefined,
  );
  if (declared || !handsBackItsArgument(oldGeneric.generic)) return undefined;
  return acceptsByShape(oldGeneric.argument, newGeneric.argument, context);
}

/** An array type's element, and whether the array is `readonly`:
 *  `Foo[]`, `(Foo | null)[]`, `readonly Foo[]`. */
function arrayOf(member: string): { element: string; readonly: boolean } | undefined {
  if (!member.endsWith('[]')) return undefined;
  const element = member.slice(0, -2);
  return element.startsWith('readonly ')
    ? { element: element.slice('readonly '.length), readonly: true }
    : { element, readonly: false };
}

/** The text a type alias stands for, when the snapshot records the alias by
 *  that text and not by its members (`type PetId = string | number`,
 *  `type Old = New`). An alias of an object shape is read by its fields. */
function aliasText(types: TypeLookup, name: string): string | undefined {
  const symbol = types.get(name)?.symbol;
  return symbol?.kind === 'alias' && symbol.extends === undefined && typeof symbol.aliasOf === 'string'
    ? symbol.aliasOf
    : undefined;
}

/**
 * The object type `newType` takes every value of `oldType`, held in a
 * variable of the old type or written as an object literal at the call site:
 *
 *  - it has every field of the old type, so no literal names a field it does
 *    not know;
 *  - each with a type that accepts the old field's (the same question, asked
 *    of the two field types);
 *  - it requires no field the old type did not require, so no value comes
 *    up short.
 *
 * So the new type may add optional fields, make required ones optional and
 * widen a field's type. Undefined when neither is an object type whose
 * fields are known whole (see `fieldsOf`), which leaves the two to be read
 * as texts; "no" when only one is. A type without fields takes any object,
 * so it is accepted by another without fields and by nothing else: it does
 * not say what callers pass.
 *
 * A declaration between the two is not read. `interface Old extends New`
 * says every `Old` is a `New`, and still a literal that names a field of
 * `Old` alone is refused where a `New` is expected, so the fields decide
 * with or without it.
 */
function fieldsAccept(oldType: string, newType: string, context: ShapeContext): boolean | undefined {
  const oldFields = fieldsOf(oldType, context.oldTypes);
  const newFields = fieldsOf(newType, context.newTypes);
  if (oldFields === undefined && newFields === undefined) return undefined;
  if (oldFields === undefined || newFields === undefined) return false;
  if (oldFields.size === 0) return newFields.size === 0;
  for (const [name, newField] of newFields) {
    if (!newField.optional && oldFields.get(name)?.optional !== false) return false;
  }
  for (const [name, oldField] of oldFields) {
    const newField = newFields.get(name);
    if (newField === undefined || !acceptsByShape(oldField.type, newField.type, context)) return false;
  }
  if (oldType !== newType) context.fields.set(JSON.stringify([oldType, newType]), { oldType, newType });
  return true;
}

/**
 * The fields of an object type, each required or not: an object type written
 * in place, read from its text (`objectTypeMembers`), or a declared type
 * whose fields the snapshot records whole (`recordedMembers`). Undefined for
 * anything else, and for either kind when the fields are not all a value may
 * carry.
 *
 * A field's type is weighed as it stands, an `undefined` included. A
 * declared type's field is read as the checker resolves it
 * (`RecordedMember.type`): without the `undefined` optionality adds, and with
 * one the SDK wrote under `exactOptionalPropertyTypes`, where an optional
 * `name?: string | undefined` takes a value an optional `name?: string` does
 * not. An object type written in place is printed with `| undefined` on each
 * optional member where the SDK is not compiled with that option, and
 * nothing in its text says which of the two it is. So an optional member
 * written in place with one is not accepted by a declared field without one,
 * though the reverse is.
 */
function fieldsOf(member: string, types: TypeLookup): ReadonlyMap<string, RecordedMember> | undefined {
  return objectTypeMembers(member) ?? recordedMembers(types, member);
}
