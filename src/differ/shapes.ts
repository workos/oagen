import type { ApiSpec, Enum, Model, TypeRef } from '../ir/types.js';
import { typeRefConstraints } from '../ir/types.js';
import { constraintsShift, type ConstrainedSite } from './constraints.js';
import { sameCompositionKinds, typeRefsEqual } from './models.js';

/** The named types of one document, so a body's model or enum ref can be read through to its shape. */
export interface DocumentTypes {
  models: ReadonlyMap<string, Model>;
  enums: ReadonlyMap<string, Enum>;
}

/**
 * The two documents' named types. `diffSpecs` supplies them so paired bodies
 * compare by shape (`sameShape`); a direct caller may leave them out, in
 * which case bodies compare by name alone, as `typeRefsEqual` does.
 */
export interface DocumentShapes {
  old: DocumentTypes;
  new: DocumentTypes;
}

export function documentTypes(spec: Pick<ApiSpec, 'models' | 'enums'>): DocumentTypes {
  return {
    models: new Map(spec.models.map((model) => [model.name, model])),
    enums: new Map(spec.enums.map((entry) => [entry.name, entry])),
  };
}

/** Field properties that only document a field — its extensions included — or say where it comes from (`inheritedFrom`, the base it is taken from; #591); two shapes that differ in these alone are one shape. */
const FIELD_DOC_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'description',
  'externalDocs',
  'example',
  'examples',
  'extensions',
  'inheritedFrom',
]);
/** Model properties outside its shape: the name, its documentation (extensions included), its provenance (`bases`, the components it is composed from; #591), and what is compared on its own (fields, variants, discriminator). */
const MODEL_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'externalDocs',
  'extensions',
  'bases',
  'fields',
  'variants',
  'discriminator',
]);
/** Enum value properties that only document the value. */
const ENUM_VALUE_DOC_KEYS: ReadonlySet<string> = new Set(['description']);
/**
 * Field properties two compatible models may differ in (`compatibleShape`):
 * what is no shape at all, `deprecated` — the field is still there with the
 * same type and requiredness, as `field-deprecated-changed` is additive
 * either way — and the two that are judged by side instead of compared,
 * `required` and `constraints`. Any other property is compared as-is.
 */
const FIELD_LENIENT_KEYS: ReadonlySet<string> = new Set([...FIELD_DOC_KEYS, 'required', 'deprecated', 'constraints']);
/** Model properties two compatible models may differ in: what is no shape of its own, `deprecated`, and `constraints`, judged by side. */
const MODEL_LENIENT_KEYS: ReadonlySet<string> = new Set([...MODEL_IDENTITY_KEYS, 'deprecated', 'constraints']);

/**
 * Whether two body types are one shape, whatever names they carry. A type
 * equal by name (`typeRefsEqual`) is one shape; otherwise a model ref is read
 * through to its model in its own document and compared field by field —
 * the same field names, each with the same requiredness, access flags,
 * deprecation, default and limits, and a type that is itself one shape, so
 * nested models and enums are read through too — plus the model's own
 * limits, type parameters, deprecation, variants (pairwise, in order) and
 * discriminator (property and mapped shapes); an enum ref is read through to
 * its values (name, value, deprecation). The limits a field's type carries
 * (`constraints` on a primitive, literal, array, map or union; #545) are
 * shape as the field's own are, at every level under the field
 * (`sameLimits`): a renamed model whose `tags` items differ in `pattern`
 * alone is not one shape with the old, as one whose `tags` field's
 * `minItems` differs is not. At the top, two types `typeRefsEqual` reads as
 * one are one shape whatever limits they carry, as `diffFields` passes over
 * a field's: a `maxLength` edited on a body — the one `requestBody` is read
 * from or a secondary representation, a model's field or an inline string
 * — is no retype (#545 review). Documentation (descriptions, links,
 * examples) does not count. Without `shapes`, or for a name either document
 * lacks, the two refs are different shapes. So are two names both documents
 * declare, however alike: neither was renamed, so a body moved from `Note` to
 * an identical `NoteCopy` is typed by another model, and no `model-removed`
 * or `model-added` reports it. A pair of models met again while comparing
 * their own fields (a self-referential shape) is taken as equal, so the
 * comparison terminates.
 *
 * This is what lets a body the parser names after its media type keep
 * comparing equal across a rename: a parameter edit on a key declared beside
 * another spelling of its essence (`application/yaml; version=1` →
 * `; version=3`) renames the model minted for it, and that rename is the
 * models diff's to report (`model-removed` + `model-added`), not a retype. A
 * rename may also hand the old name to another body: a form body that is
 * `CreatePetRequest` alone is `CreatePetApplicationXWwwFormUrlencodedRequest`
 * once a JSON body takes `CreatePetRequest`, which is still a rename, since
 * the new name is one the old document lacks.
 */
export function sameShape(a: TypeRef, b: TypeRef, shapes?: DocumentShapes): boolean {
  return sameShapeWithin(a, b, shapes, new Set(), 'renamed');
}

/**
 * How a pair of types is read as one shape. `renamed` is `sameShape`: two
 * names both documents declare are different shapes, and a union's
 * composition keyword is passed over, as `typeRefsEqual` passes over it.
 * `alike` is `oneShape`: whatever the names, and the same keyword on every
 * union. `across` is `alike` with nothing taken on its name: a model or an
 * enum both types name is read out of the old document on one side and the
 * new document on the other like any other pair, so two that changed
 * hands under their names are told apart (`inStep`).
 */
type Reading = 'renamed' | 'alike' | 'across';

/**
 * Whether two types are one shape whatever names they carry: `sameShape`
 * without its rule for two names both documents declare, and with every
 * inline union's composition keyword compared. That rule tells a rename
 * from a move, so that a body moved between two declared models stays
 * reported; what a reader finds in a field typed `Owner` and in one typed
 * by an identical `OwnerCopy` is the same either way, which is all
 * `compatibleShape` asks of a field's type. The keyword is read because
 * `compatibleShape` vouches for the pair: `anyOf` become `oneOf` rejects a
 * value that matches two variants, and the reverse lets a reader receive
 * one, as `composition-changed` is breaking on a named union (Greptile,
 * #758 review round 1). A model both types name is the same type, as it is
 * everywhere in the differ: what changed about it is its own
 * `model-modified`.
 */
function oneShape(a: TypeRef, b: TypeRef, shapes?: DocumentShapes): boolean {
  return sameShapeWithin(a, b, shapes, new Set(), 'alike');
}

/** `sameShape` or `oneShape` by `reading`, with the model pairs already being compared (`seen`). */
function sameShapeWithin(
  a: TypeRef,
  b: TypeRef,
  shapes: DocumentShapes | undefined,
  seen: Set<string>,
  reading: Reading,
): boolean {
  const sameByName = typeRefsEqual(a, b);
  if (sameByName && reading === 'renamed') return true;
  if (sameByName && reading === 'alike' && sameCompositionKinds(a, b)) return true;
  if (!shapes || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'model': {
      if (b.kind !== 'model') return false;
      const oldModel = shapes.old.models.get(a.name);
      const newModel = shapes.new.models.get(b.name);
      if (!oldModel || !newModel) return false;
      if (reading === 'renamed' && shapes.new.models.has(a.name) && shapes.old.models.has(b.name)) return false;
      const pair = `model:${a.name}\u0000${b.name}`;
      if (seen.has(pair)) return true;
      seen.add(pair);
      return sameModelShape(oldModel, newModel, shapes, seen, reading);
    }
    case 'enum': {
      if (b.kind !== 'enum') return false;
      const oldEnum = shapes.old.enums.get(a.name);
      const newEnum = shapes.new.enums.get(b.name);
      if (!oldEnum || !newEnum) return false;
      if (reading === 'renamed' && shapes.new.enums.has(a.name) && shapes.old.enums.has(b.name)) return false;
      return sameEnumShape(oldEnum, newEnum);
    }
    case 'array':
      return b.kind === 'array' && sameShapeWithin(a.items, b.items, shapes, seen, reading);
    case 'map':
      return b.kind === 'map' && sameShapeWithin(a.valueType, b.valueType, shapes, seen, reading);
    case 'nullable':
      return b.kind === 'nullable' && sameShapeWithin(a.inner, b.inner, shapes, seen, reading);
    case 'union':
      return (
        b.kind === 'union' &&
        (reading === 'renamed' || a.compositionKind === b.compositionKind) &&
        sameVariants(a.variants, b.variants, shapes, seen, reading) &&
        sameDiscriminator(a.discriminator, b.discriminator, shapes, seen, reading)
      );
    default:
      // Primitives and literals are equal exactly when `typeRefsEqual` says so,
      // which the readings that take a pair on its name have already answered.
      return sameByName;
  }
}

/**
 * Which side of the wire a body is on for the SDK's user: a `reader` is
 * handed it — a success, error, `default` or range response, a webhook's or
 * a callback's payload — and a `writer` builds it — an operation's request
 * body.
 */
export type BodySide = 'reader' | 'writer';

/**
 * Whether a body whose type moved from `oldType` to `newType` still serves
 * the code written against the old one, on `side` (#753): a reader finds
 * everything it read, and every body a writer built is still accepted. One
 * shape is compatible on both sides — `sameShape`'s comparison, whatever
 * the names (`oneShape`); beyond that, two model refs are read through to
 * their models, each in its own document, and compared field by field:
 *
 * - every field of the old model is in the new one, with the same type —
 *   one shape again, so a field typed by another model is the same type
 *   when that model has the same fields under whatever name, and a retyped
 *   field when it is only compatible itself (`Pet.owner: Owner` beside
 *   `PetWithTag.owner: OwnerWithTag`): compatibility is asked of the body's
 *   own model, not of the models under it — and with the same access
 *   flags, default and anything else `sameShape` reads as a field's shape,
 *   its deprecation aside. A field dropped or retyped is compatible on
 *   neither side, as `field-removed` and `field-type-changed` are breaking
 *   whatever the model's direction;
 * - requiredness may move the way the side allows. For a reader a field is
 *   required wherever it was: one that became optional may now be missing,
 *   while one newly required, or a required one added, is simply always
 *   there. For a writer no field is required that was not: one that became
 *   required, or a required one added, rejects the bodies built without
 *   it, while one that became optional is still accepted when sent. An
 *   optional field added is compatible on both sides;
 * - limits — a field's and those its type carries at every level
 *   (`constraintsShift`), and the model's own — are judged as the differ
 *   judges the same edit to a model of that direction
 *   (`classifyConstraintsChange`): tightened is incompatible for a writer,
 *   since a value it sends can be rejected, and any change is compatible
 *   for a reader. The levels are compared in the pairs the shape
 *   comparison made (`limitsFit`), a named union's variants' included;
 * - the model's type parameters are the same, and so are a named union's
 *   composition keyword, variants and discriminator, each variant and
 *   mapped model one shape; its deprecation does not count, so a body can
 *   move off a deprecated model.
 *
 * The same wrapper on both sides is looked through to what it wraps: an
 * array's items, a map's values, a `nullable`'s inner type, and an inline
 * union's variants pairwise in order, with the same composition keyword,
 * its discriminator's property and keys the same and each key's two
 * targets compatible. A writer's union that is not an `anyOf` asks more
 * of its variants, since a branch that admits more can make a value match
 * two: neither stricter nor looser, in requiredness or in limits (`Fit`).
 * A wrapper added, removed or exchanged is not looked through, and neither
 * is a union that gained or lost a variant (`addedUnionVariants` is asked
 * beside this where a widening counts). The limits those wrappers
 * carry are judged by side too: `Pet[]` with `maxItems: 10` become
 * `PetWithTag[]` with `maxItems: 5` rejects a request the old body
 * accepted. Anything else — a primitive, a literal, an enum — is
 * compatible only as one shape: an enum with the same values, under
 * whatever name.
 *
 * Unlike `sameShape` this is no identity: it does not ask whether either
 * name is new to its document, at the body or under it, so a body moved to
 * a model both documents declare is compatible when that model's fields
 * are, which is all the reader or the writer depends on (the move is still
 * reported: this only says what it is called). Nor does it hold wherever
 * `sameShape` does: a model that was only renamed is one shape there
 * whatever its union keywords and the limits around it, and compatible
 * here only when those allow it. Two types `typeRefsEqual` reads as one
 * are compatible, since the differ reports no type change for them
 * anywhere. Without `shapes`, or for a name its document lacks, two refs
 * are compatible only when `typeRefsEqual`.
 */
export function compatibleShape(oldType: TypeRef, newType: TypeRef, side: BodySide, shapes?: DocumentShapes): boolean {
  if (typeRefsEqual(oldType, newType)) return true;
  if (!shapes) return false;
  return (
    compatibleWithin(oldType, newType, side, shapes) &&
    // The limits the body's own type carries around its models.
    limitsFit({ type: oldType }, { type: newType }, side, shapes)
  );
}

/**
 * What a pair has to be for `compatibleShape`: compatible for the `reader`
 * or for the `writer`, or `exact` — neither stricter nor looser. A writer's
 * union that is not an `anyOf` asks `exact` of its variants: a branch of a
 * `oneOf` that admits more can match a value only another branch matched,
 * and a value that matches two is rejected (`oneOf: [{ maxLength: 5 }, {
 * minLength: 6 }]` with the first loosened to `maxLength: 10` rejects the
 * `'abcdef'` it admitted; Greptile, #758 review round 3). A union written
 * without a keyword is read as exclusive too: the request-body parser
 * writes none on a `oneOf`. An exact pair of models may still differ in
 * the optional fields the new one adds, which change nothing a body built
 * for the old one matches.
 */
type Fit = BodySide | 'exact';

/** The fit a writer's union asks of its variants: `exact` unless it is an `anyOf` (`Fit`); a reader's, or an exact one's, is its own. */
function fitWithin(fit: Fit, compositionKind: 'allOf' | 'oneOf' | 'anyOf' | undefined): Fit {
  return fit === 'writer' && compositionKind !== 'anyOf' ? 'exact' : fit;
}

/** `compatibleShape`'s walk: one shape, two models that fit, or the same wrapper around a pair that is either. */
function compatibleWithin(oldType: TypeRef, newType: TypeRef, fit: Fit, shapes: DocumentShapes): boolean {
  if (oneShape(oldType, newType, shapes)) return true;
  if (oldType.kind === 'model' && newType.kind === 'model') {
    const oldModel = shapes.old.models.get(oldType.name);
    const newModel = shapes.new.models.get(newType.name);
    return !!oldModel && !!newModel && compatibleModel(oldModel, newModel, fit, shapes);
  }
  if (oldType.kind === 'array' && newType.kind === 'array') {
    return compatibleWithin(oldType.items, newType.items, fit, shapes);
  }
  if (oldType.kind === 'map' && newType.kind === 'map') {
    return compatibleWithin(oldType.valueType, newType.valueType, fit, shapes);
  }
  if (oldType.kind === 'nullable' && newType.kind === 'nullable') {
    return compatibleWithin(oldType.inner, newType.inner, fit, shapes);
  }
  if (oldType.kind === 'union' && newType.kind === 'union') {
    const within = fitWithin(fit, oldType.compositionKind);
    return (
      oldType.compositionKind === newType.compositionKind &&
      oldType.variants.length === newType.variants.length &&
      oldType.variants.every((variant, i) => compatibleWithin(variant, newType.variants[i], within, shapes)) &&
      compatibleDiscriminator(oldType.discriminator, newType.discriminator, within, shapes)
    );
  }
  return false;
}

/** `compatibleShape` for two models read out of their documents; a field's type, the variants and the mapped models compare as one shape (`oneShape`). */
function compatibleModel(oldModel: Model, newModel: Model, fit: Fit, shapes: DocumentShapes): boolean {
  const newFields = new Map(newModel.fields.map((field) => [field.name, field]));
  const oldNames = new Set(oldModel.fields.map((field) => field.name));
  for (const oldField of oldModel.fields) {
    const newField = newFields.get(oldField.name);
    if (!newField || !oneShape(oldField.type, newField.type, shapes)) return false;
    const becameOptional = oldField.required && !newField.required;
    const becameRequired = !oldField.required && newField.required;
    if (fit !== 'writer' && becameOptional) return false;
    if (fit !== 'reader' && becameRequired) return false;
    if (
      stableStringify(omitKeys(oldField, FIELD_LENIENT_KEYS)) !==
      stableStringify(omitKeys(newField, FIELD_LENIENT_KEYS))
    ) {
      return false;
    }
    if (!limitsFit(oldField, newField, fit, shapes)) return false;
  }
  // A required field the old model lacks is one more thing a writer must send.
  if (fit !== 'reader' && newModel.fields.some((field) => field.required && !oldNames.has(field.name))) return false;
  if (!limitsFit(oldModel, newModel, fit, shapes)) return false;
  if (
    stableStringify(omitKeys(oldModel, MODEL_LENIENT_KEYS)) !== stableStringify(omitKeys(newModel, MODEL_LENIENT_KEYS))
  ) {
    return false;
  }
  if (!!oldModel.variants !== !!newModel.variants) return false;
  if (oldModel.variants && newModel.variants) {
    if (!sameVariants(oldModel.variants, newModel.variants, shapes, new Set(), 'alike')) return false;
    // A named union's variants carry limits as a field's union does, and are
    // judged the same way: as the union they are, under the model's keyword.
    const [before, after] = [oldModel, newModel].map(({ variants = [], compositionKind }): TypeRef => ({
      kind: 'union',
      variants,
      ...(compositionKind ? { compositionKind } : {}),
    }));
    if (!limitsFit({ type: before }, { type: after }, fit, shapes)) return false;
  }
  return sameDiscriminator(oldModel.discriminator, newModel.discriminator, shapes, new Set(), 'alike');
}

/**
 * Whether the limits two sites carry leave `fit` standing, the two types
 * having been read as one shape. A reader's always do: it is handed the
 * value, as a limit moved on a response-only model is additive either way.
 * A writer's do while nothing tightened — a value it sends can be rejected
 * (`classifyConstraintsChange` on a request-facing model) — and no limit
 * moved at all on a variant of a union that is not an `anyOf`
 * (`exclusiveLimitsMoved`). An exact fit takes no limit moved anywhere.
 *
 * The levels are compared in order, once with the two types as they are
 * and once with the old one's unions put in step with the new one's
 * (`inStep`), and the limits fit when they do in either: each pairs every
 * old variant with one new variant of its shape, so either one shows the
 * new type admits what the old one did. In order alone reads two variants
 * of one type that changed places with their limits as a limit added
 * (Greptile, #758 review round 2).
 */
function limitsFit(oldSite: ConstrainedSite, newSite: ConstrainedSite, fit: Fit, shapes: DocumentShapes): boolean {
  if (fit === 'reader') return true;
  const [oldType, newType] = [oldSite.type, newSite.type];
  const readings: ConstrainedSite[] =
    oldType && newType ? [oldSite, { ...oldSite, type: inStep(oldType, newType, shapes, new WeakMap()) }] : [oldSite];
  return readings.some((reading) => {
    const shift = constraintsShift(reading, newSite, 'inOrder');
    if (fit === 'exact') return shift === undefined;
    return !shift?.tightened && !(reading.type && newType && exclusiveLimitsMoved(reading.type, newType));
  });
}

/** `inStep`'s answers for one comparison, by the two types' identity: a pair several outer pairings try is put in step once. */
type StepMemo = WeakMap<TypeRef, WeakMap<TypeRef, TypeRef>>;

/**
 * `oldType` with every union's variants in the order that puts each one
 * beside the new variant it is, through each `nullable`, array or map
 * wrapper and each nested union, for two types read as one shape in order.
 * A new variant takes the first old variant not yet taken that is its
 * shape across the two documents (`across`: a model or an enum of one name
 * on both sides is read through both too, so two models that changed
 * hands under their names are no pair; Greptile, #758 review round 3) and
 * carries the same limits at every level once the two are themselves put
 * in step — so two unions that changed places are each other's whichever
 * way their own branches are written (round 4); one left over takes the
 * old variant in its place, which the caller matched it with. The union
 * stays as written when that place is already taken. `memo` keeps each
 * pair's answer, so the pairs tried at one level are not walked again at
 * the next.
 */
function inStep(oldType: TypeRef, newType: TypeRef, shapes: DocumentShapes, memo: StepMemo): TypeRef {
  let byNew = memo.get(oldType);
  if (!byNew) {
    byNew = new WeakMap();
    memo.set(oldType, byNew);
  }
  let stepped = byNew.get(newType);
  if (!stepped) {
    stepped = putInStep(oldType, newType, shapes, memo);
    byNew.set(newType, stepped);
  }
  return stepped;
}

/** `inStep`, unmemoized. */
function putInStep(oldType: TypeRef, newType: TypeRef, shapes: DocumentShapes, memo: StepMemo): TypeRef {
  if (oldType.kind === 'nullable' && newType.kind === 'nullable') {
    return { ...oldType, inner: inStep(oldType.inner, newType.inner, shapes, memo) };
  }
  if (oldType.kind === 'array' && newType.kind === 'array') {
    return { ...oldType, items: inStep(oldType.items, newType.items, shapes, memo) };
  }
  if (oldType.kind === 'map' && newType.kind === 'map') {
    return { ...oldType, valueType: inStep(oldType.valueType, newType.valueType, shapes, memo) };
  }
  if (oldType.kind !== 'union' || newType.kind !== 'union' || oldType.variants.length !== newType.variants.length) {
    return oldType;
  }
  const taken = new Set<number>();
  const places = newType.variants.map((variant) => {
    const k = oldType.variants.findIndex(
      (old, j) =>
        !taken.has(j) &&
        sameShapeWithin(old, variant, shapes, new Set(), 'across') &&
        sameLimits(inStep(old, variant, shapes, memo), variant),
    );
    if (k >= 0) taken.add(k);
    return k;
  });
  const order: number[] = [];
  for (const [i, k] of places.entries()) {
    if (k < 0 && taken.has(i)) return oldType;
    if (k < 0) taken.add(i);
    order.push(k < 0 ? i : k);
  }
  return {
    ...oldType,
    variants: order.map((k, i) => inStep(oldType.variants[k], newType.variants[i], shapes, memo)),
  };
}

/**
 * Whether, between two types read as one shape in order, a limit moved on
 * a variant of a union that is not an `anyOf` — at any level under the
 * variant, the limits the union's own schema carries aside, which bind the
 * value whichever branch it takes. Tightened rejects what the branch
 * admitted; loosened lets the branch match a value only another one
 * matched, which an exclusive union then rejects (`Fit`).
 */
function exclusiveLimitsMoved(a: TypeRef, b: TypeRef): boolean {
  if (a.kind === 'nullable' && b.kind === 'nullable') return exclusiveLimitsMoved(a.inner, b.inner);
  if (a.kind === 'array' && b.kind === 'array') return exclusiveLimitsMoved(a.items, b.items);
  if (a.kind === 'map' && b.kind === 'map') return exclusiveLimitsMoved(a.valueType, b.valueType);
  if (a.kind !== 'union' || b.kind !== 'union') return false;
  return a.variants.some((variant, i) => {
    const other = b.variants[i];
    if (other === undefined) return false;
    return a.compositionKind === 'anyOf' ? exclusiveLimitsMoved(variant, other) : !sameLimits(variant, other);
  });
}

/** The same `property` and mapping keys, each key's two targets fitting; absent on both sides fits too. */
function compatibleDiscriminator(
  a: { property: string; mapping: Record<string, string> } | undefined,
  b: { property: string; mapping: Record<string, string> } | undefined,
  fit: Fit,
  shapes: DocumentShapes,
): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.property !== b.property) return false;
  const aKeys = Object.keys(a.mapping).sort();
  const bKeys = Object.keys(b.mapping).sort();
  if (aKeys.length !== bKeys.length || !aKeys.every((key, i) => key === bKeys[i])) return false;
  return aKeys.every((key) =>
    compatibleWithin({ kind: 'model', name: a.mapping[key] }, { kind: 'model', name: b.mapping[key] }, fit, shapes),
  );
}

function sameModelShape(
  oldModel: Model,
  newModel: Model,
  shapes: DocumentShapes,
  seen: Set<string>,
  reading: Reading,
): boolean {
  const oldFields = new Map(oldModel.fields.map((field) => [field.name, field]));
  const newFields = new Map(newModel.fields.map((field) => [field.name, field]));
  if (oldFields.size !== newFields.size) return false;
  for (const [name, oldField] of oldFields) {
    const newField = newFields.get(name);
    if (!newField) return false;
    if (stableStringify(omitKeys(oldField, FIELD_DOC_KEYS)) !== stableStringify(omitKeys(newField, FIELD_DOC_KEYS))) {
      return false;
    }
    // The limits the field's type carries are its shape, as its own are (#545).
    if (!sameLimits(oldField.type, newField.type)) return false;
    if (!sameShapeWithin(oldField.type, newField.type, shapes, seen, reading)) return false;
  }
  if (
    stableStringify(omitKeys(oldModel, MODEL_IDENTITY_KEYS)) !==
    stableStringify(omitKeys(newModel, MODEL_IDENTITY_KEYS))
  ) {
    return false;
  }
  if (!!oldModel.variants !== !!newModel.variants) return false;
  if (
    oldModel.variants &&
    newModel.variants &&
    (!sameVariantLimits(oldModel.variants, newModel.variants) ||
      !sameVariants(oldModel.variants, newModel.variants, shapes, seen, reading))
  ) {
    return false;
  }
  return sameDiscriminator(oldModel.discriminator, newModel.discriminator, shapes, seen, reading);
}

/**
 * Whether `a` and `b` carry the same limits at every level — on the type
 * itself and, in lockstep, on an array's items, a map's values, a nullable
 * wrapper's inner type and a union's variants pairwise (#545). Read by
 * `sameModelShape` for each field's type and each variant of a named
 * union, where a field's own limits are already shape, and not at the top
 * of `sameShapeWithin`: there `typeRefsEqual` passes over limits as
 * `diffFields` passes over a field's, so a limit edited on a body's
 * secondary representation is no retype while the same edit on its
 * primary or on a field reports nothing (#545 review). A model or enum
 * reference carries none (the model's own are compared with the model);
 * two types of different kinds are left to the shape comparison.
 */
function sameLimits(a: TypeRef, b: TypeRef): boolean {
  if (stableStringify(typeRefConstraints(a)) !== stableStringify(typeRefConstraints(b))) return false;
  switch (a.kind) {
    case 'array':
      return b.kind !== 'array' || sameLimits(a.items, b.items);
    case 'map':
      return b.kind !== 'map' || sameLimits(a.valueType, b.valueType);
    case 'nullable':
      return b.kind !== 'nullable' || sameLimits(a.inner, b.inner);
    case 'union':
      return (
        b.kind !== 'union' ||
        a.variants.length !== b.variants.length ||
        a.variants.every((variant, i) => sameLimits(variant, b.variants[i]))
      );
    default:
      return true;
  }
}

/** Whether a named union's variants carry the same limits pairwise (`sameLimits`); a different count is left to `sameVariants`. */
function sameVariantLimits(a: TypeRef[], b: TypeRef[]): boolean {
  return a.length !== b.length || a.every((variant, i) => sameLimits(variant, b[i]));
}

function sameVariants(
  a: TypeRef[],
  b: TypeRef[],
  shapes: DocumentShapes,
  seen: Set<string>,
  reading: Reading,
): boolean {
  return a.length === b.length && a.every((variant, i) => sameShapeWithin(variant, b[i], shapes, seen, reading));
}

/** The same `property`, the same mapping keys, each mapped to one shape; absent on both sides is the same too. */
function sameDiscriminator(
  a: { property: string; mapping: Record<string, string> } | undefined,
  b: { property: string; mapping: Record<string, string> } | undefined,
  shapes: DocumentShapes,
  seen: Set<string>,
  reading: Reading,
): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.property !== b.property) return false;
  const aKeys = Object.keys(a.mapping).sort();
  const bKeys = Object.keys(b.mapping).sort();
  if (aKeys.length !== bKeys.length || !aKeys.every((key, i) => key === bKeys[i])) return false;
  return aKeys.every((key) =>
    sameShapeWithin(
      { kind: 'model', name: a.mapping[key] },
      { kind: 'model', name: b.mapping[key] },
      shapes,
      seen,
      reading,
    ),
  );
}

function sameEnumShape(a: Enum, b: Enum): boolean {
  const values = (entry: Enum): string =>
    entry.values
      .map((value) => stableStringify(omitKeys(value, ENUM_VALUE_DOC_KEYS)))
      .sort()
      .join('|');
  return values(a) === values(b) && (a.default ?? null) === (b.default ?? null) && !!a.deprecated === !!b.deprecated;
}

/** The entries of `value` whose key is not in `keys` and whose value is set. */
function omitKeys(value: object, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entryValue]) => entryValue !== undefined && !keys.has(key)),
  );
}

/** `JSON.stringify` with object keys sorted and unset entries dropped, so equal shapes serialize equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
