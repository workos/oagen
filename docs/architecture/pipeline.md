# Pipeline Architecture

## Overview

oagen provides a three-stage pipeline for transforming OpenAPI specs into SDK code: Parse → Emit → Write. Emitters are registered plugins that implement the `Emitter` interface.

```
┌──────────────────┐     ┌─────────────────────┐      ┌──────────────┐
│   OpenAPI Spec   │────▶│   Parser Pipeline    │────▶│     IR       │
│   (YAML/JSON)    │     │                      │     │  (ApiSpec)   │
└──────────────────┘     └─────────────────────┘      └──────┬───────┘
                                                             │
                         ┌──────────────────────┐            │
                         │  Emitter (per lang)  │◀───────────┘
                         │  generator methods   │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │   GeneratedFile[]    │
                         │  { path, content }   │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │      Writer          │
                         │  (disk + headers)    │
                         └──────────────────────┘
```

## Stage 1: Parse (`src/parser/`)

Entry point: `parse.ts` → `parseSpec(specPath: string): Promise<ApiSpec>`

1. **refs.ts** — Loads the spec file and bundles it with `@redocly/openapi-core` (`dereference: false`): external `$ref`s are inlined, internal `$ref`s stay in place for the parser to resolve at the site that reads them (`components/schemas` through the schema walker; `components/parameters`, `requestBodies`, `headers`, `responses` and `pathItems` by the operation, webhook or response that declares the ref), and a `$ref` nothing in the document answers fails the parse (`Failed to parse spec: Can't resolve $ref`)
2. **schemas.ts** — Walks `components.schemas`, extracts `Model[]` and `Enum[]` (an array component yields no model: a `$ref` to it is typed as the array, and only what its items reference becomes a model or enum)
3. **operations.ts** — Walks `paths` (an entry written as a `$ref` into `components/pathItems` is first resolved by **path-item-refs.ts**, the resolver **webhooks.ts** uses for a `webhooks` entry; one that cannot be resolved is warned about and skipped), groups endpoints into `Service[]` with `Operation[]`
4. **pagination.ts** — Detects the pagination strategy from the query parameters the operation declares (a cursor parameter; an offset or page parameter plus a page size), reads the first page number (`pageStart`) from the page parameter's schema and the end-of-iteration field (`has_more`, `total_pages`, `total`, … in any spelling) from the response envelope, and applies an `x-pagination` extension or an `operationHints` entry over detection, field by field (see [Overriding detection](ir-types.md#overriding-detection)); `responses.ts` recognizes a list envelope in the response and unwraps it only when such a parameter, or an override naming a declared one, drives the iterator — an envelope nothing pages stays a plain response model, with a warning
5. **webhooks.ts** — Walks the top-level `webhooks` map (OpenAPI 3.1) into `Webhook[]`, one per HTTP method of each entry, after the operations: the payload and parameter models it mints (`<Stem>Payload`, `<Stem>XMeta`) step around every model and enum name the components and operations decided. `x-webhooks` is not read, and a document that carries one is warned about
6. **normalize-inline-models.ts**, **collect-inline-enums.ts** — Merge the inline models every pass minted (same-named copies folded onto one definition or qualified by their site, `…Json` models collapsed onto their base), then lift every inline enum into `spec.enums`; `servers.ts` and `security.ts` read the document's `servers` and `security`, and `parse.ts` reads `components.securitySchemes` into `auth` and validates that every model reference resolves

### Operation Name Inference

If an `operationId` is present, it takes precedence. Names are inferred from HTTP method + path pattern:

| Method | Path Pattern                  | Inferred Name        |
| ------ | ----------------------------- | -------------------- |
| GET    | `/users`                      | `list`               |
| GET    | `/users/{id}`                 | `get`                |
| POST   | `/users`                      | `create`             |
| PUT    | `/users/{id}`                 | `update`             |
| DELETE | `/users/{id}`                 | `delete`             |
| GET    | `/store/pets`                 | `listPets`           |
| GET    | `/store/pets/{id}`            | `getPet`             |
| GET    | `/store/pets/{id}/status`     | `getPetStatus`       |
| DELETE | `/store/pets/{id}/avatar`     | `deletePetAvatar`    |
| POST   | `/store/pets/{id}/adopt`      | `adoptPet`           |
| POST   | `/store/pets/{id}/photos`     | `createPhotos`       |
| POST   | `/accounts/users/{id}/ban`    | `banUser`            |
| DELETE | `/users/bulk-delete`          | `bulkDelete`         |
| POST   | `/store/pets/bulk-delete`     | `bulkDeletePets`     |
| PUT    | `/users/{id}/update-password` | `updatePasswordUser` |

The collection vs. instance distinction is determined by whether the path ends with a `{param}` segment. The resource is the last literal segment, dropped when it is the segment the service was named from — compared by position, so `GET /teams/{id}/teams` in `Teams` is `listTeams`, the teams under one team, while `GET /teams` is `list` — and singularised for an instance operation (`pets` → `Pet`, `api_keys` → `ApiKey`, `addresses` → `Address`, `aliases` → `Alias`, `analyses` → `Analysis`; `status` and other words that do not look plural are kept). The same rule spells every other path segment a name takes: a segment a `{param}` follows is singular, any other is kept as written — and the stemmer's limits reach those segments too (`sms/{smsId}` between the service and the resource contributes `Sm`, `canvas/{id}` contributes `Canva`).

A literal after a `{param}` that does not look plural is a singleton of that item: one thing about one pet, read with the item verb (`get`, not `list`) and named after the method's verb, the singular parent and the segment — `GET /store/pets/{id}/status` → `getPetStatus`, `DELETE /users/{id}/avatar` → `deleteUserAvatar`, `PUT` → `updateUserAvatar`, `HEAD` → `checkUserAvatar`, and `POST /orders/{id}/status` → `createOrderStatus`. The parent is kept even when it is the first segment, as it is for an action: `GET /pets/{id}/status` in `Pets` is `getPetStatus`. A plural literal after a `{param}` (`/users/{id}/photos`, `/orgs/{id}/api_keys`) is a nested collection: `listPhotos`, `createApiKeys`. An irregular plural that `singularizePathSegment` does not recognise (`children`, `people`, `data`) does not look plural, so `GET /pets/{id}/children` is the singleton `getPetChildren`; give it an `operationId`.

An action is a literal that names what the operation does; it is the whole verb phrase of the name and the method's verb is left off. Three shapes are actions. A POST on a literal that follows a `{param}` and does not end in `s`: the segment is the verb and the singular parent is appended (`adoptPet`), even when the parent is the first segment, so two actions with the same name on different resources do not collide — unless the verb already ends with the parent's words (`POST /companies/verification/{id}/restart-id-verification` → `restartIdVerification`); a POST on a singleton that does not end in `s` (`POST /users/{id}/avatar`) is therefore misread as the action `avatarUser` — give it an `operationId`. For any method, a literal whose words include the method's own verb, which the name would otherwise repeat: `DELETE /pets/bulk-delete` → `bulkDelete`, `GET /pets/list-all` → `listAll`, `GET /pets:batchGet` → `batchGet`, `PUT /users/{id}/update-password` → `updatePasswordUser`; `list` and `check` count only as the first word, since as a later word they name a thing, so `GET /pets/{id}/wish-list` is the singleton `getPetWishList` and `GET /pets/allow-list` the collection `listAllowList`. A literal carrying another method's verb is not an action: after a `{param}` it is a singleton (`GET /users/{id}/last-update` → `getUserLastUpdate`), before none a collection (`GET /pets/update` → `listUpdate`, `GET /pets/last-update` → `listLastUpdate`). And, for a POST only, a literal with no `{param}` before it whose last word is any CRUD verb (`get`, `list`, `create`, `update`, `delete`, `check`): `POST /pets/bulk-delete` → `bulkDelete`, `POST /users/bulk-update` → `bulkUpdate`, `POST /v1/pets:batchGet` → `batchGet`; the last word only, so `POST /pets/delete-candidates` stays `createDeleteCandidates`, and any other literal with no `{param}` before it is a collection (`POST /pets/search` → `createSearch`). An action after a `{param}` takes the singular parent as its resource; one with no `{param}` before it takes the collection it sits under, dropped when that is the first segment: `DELETE /pets/bulk-delete` in `Pets` is `bulkDelete`, `DELETE /store/pets/bulk-delete` is `bulkDeletePets`. API root and version segments (`api`, `rest`, `v1`, `2.0`) are never the parent, so `POST /api/v1/{companyId}/sendDocument` is the bare `sendDocument`. A custom method in the Google AIP-136 style — the verb written after a colon on the segment it acts on — is read as that segment followed by the verb wherever a path is read for a name (the resource, the parent of an action or a singleton, the `By<Param>` qualifier, the inline model prefix), so `POST /v1/pets/{petId}:adopt` is `adoptPet` exactly as `/v1/pets/{petId}/adopt` is, never `createByPetIdAdopt`, `GET /v1/pets/{petId}:status` is `getPetStatus`, `DELETE /v1/pets:bulkDelete` is `bulkDelete`, and `POST /pets:search` is read as `/pets/search` and stays a `create`. The verb never names a service: `/v1/pets:batchGet` lands in `Pets` like `/v1/pets`, and `/v1/{name}:cancel` stays in `V1` beside `/v1/{name}`, where the slash-written `/v1/{name}/cancel` names `Cancel`. The operation's `path` is kept as written.

Fallback names are unique within a service. An `operationId` is never renamed; a colliding fallback is qualified by its path, one qualifier at a time on whatever still collides — the resource noun; the segments between the service and the resource; `By<Param>` for each parameter the colliding paths do not all share (`/api/notes/{noteId}` beside `/api/{teamId}/notes/{noteId}` is `get` and `getByTeamId`, the shared `noteId` adding nothing); the API root words a path skipped beyond those the colliding rooted paths all skipped (`/api/notes` beside `/api/v1/notes` is `list` and `listV1`, a root-less path taking no part); the resource noun the plain name left off because it names the service, beside an `operationId` (`/api/notes` beside `operationId: list` on `/api/{teamId}/notes` is `listNotes`); the plural an item operation had before singularisation — and numbered as a last resort, the plain name staying with an `operationId`, then with the path that skipped the shorter root (a root-less `/health` keeps `list` over `/api/health`, a tagged `/notes` over `/api/v1/notes`), then with the lexically first path. A deeper segment is singular when a `{param}` follows it: `GET /store/cats/{id}/toys/{toyId}` beside `GET /store/dogs/{id}/toys/{toyId}` is `getToyCat` and `getToyDog` — unless that spelling would give a path the name of an `operationId` or of another path that the spelling as written sets apart, in which case the segments are taken as written, the plural being what tells them apart: `GET /store/pets/{id}/toys/{toyId}` beside `GET /store/pet/{id}/toys/{toyId}` is `getToyPets` and `getToyPet`, and `/store/cats/{id}/toys/{toyId}` beside `operationId: getToyCat` is `getToyCats`; and as written alike when another colliding path writes the same words, so one spelling in the paths is one qualifier in the names. Every qualifier applies through one rule. It is added only when it tells the colliding paths apart: `Teams` sits in both `/org/teams/members` and `/org/teams/{teamId}/members`, so they are `listMembers` and `listMembersByTeamId`, never `listMembersTeams` and `listMembersTeam`. A qualified name another operation in the service already has is skipped for that operation and the next qualifier is tried, so a number never lands on a name another operation already had: `/org/members/archived` beside `/org/teams/archived` and `/org/archived_members` is `listArchived`, `listArchivedTeams` and `listArchivedMembers`, never `listArchivedMembers2`, and `/api/notes` beside `operationId: list` on `/api/{teamId}/notes` and `operationId: listNotes` on `/api/{orgId}/notes` is `list2`, never `listNotes2`. A name held only by path-named operations naming the same noun is joined instead: `/notes` beside `operationId: list` restores `Notes` and meets the nested collection `/notes/{noteId}/notes` at `listNotes`, and the parameter then tells them apart, `listNotes` and `listNotesByNoteId` (`getNote` and `getNoteByChildId` for their items). Operations a qualifier does not tell from each other take one spelling and stay together for the next one: `/orgs/{orgId}/groups/members` and `/orgs/{orgId}/groups/{groupId}/members` beside `/orgs/teams/members` are `listMembersGroups` and `listMembersGroupsByGroupId`. A number is used only when no qualifier is left, on the spelling such operations share: `/api/v1/{userId}/notes` and `/api/v1/{user_id}/notes` beside `/api/{userId}/notes` are `listV1` and `listV1No2`. A name that already ends in a digit takes the number behind `No`, so that it cannot be read as part of the number the name ends with: `GET /api/v1` beside `GET /api/v1/` is `listV1` and `listV1No2`, never `listV12`, which would read as version 12, and `GET /pets/top10` beside `GET /pets/top10/` is `listTop10` and `listTop10No2`; a name ending in a letter takes the bare number (`list2`, `list3`, …). When nothing in a singular fallback's path tells it from the name it collides with — an `operationId` in the same service (`GET /store/pets/{id}` next to `operationId: getPet` on `/store/featured/{id}`), or another fallback whose path differs only by the plural (`GET /store/pet/{id}`) — the fallback keeps the plural it had before singularisation, `getPets`, if no operation outside its group has that name, rather than `getPet2`. Fallbacks that would all keep the same plural are numbered instead; fallbacks that share a plural some other fallback does not keep it and are numbered (`/store/Pets/{id}` and `/store/pets/{id}` beside `/store/pet/{id}` or `operationId: getPet` are `getPets`, `getPets2` and `getPet`); an action or a singleton, which has no plural to keep, is numbered too (`getPetStatus2`). An action that shares its name with a path-named CRUD or singleton operation yields first: `update` stays with `PUT /pets/{id}`, and `POST /pets/update` takes back the collection it dropped, `updatePets` (`createPets` for `POST /pets/create` beside `POST /pets`, `listAllPets` for `GET /pets/list-all` beside `GET /pets/all`), or, when that adds nothing, its name without the action rule (`createPetCreate` for `POST /store/pets/{id}/create` beside `POST /store/pets/{id}`, `createUpdate` for `POST /store/pets/update` beside `PUT /store/pets`). Two operations on one path share a name only when both are path-named and their methods take the same verb (PUT and PATCH both `update`). A path-named operation of another verb that would share an action name takes the name it has without the action rule: the verb the segment carries keeps the action, so `DELETE /pets/bulk-delete` is `bulkDelete` and `POST /pets/bulk-delete` beside it is `createBulkDelete`; with no method carrying the verb, POST keeps it and `PUT /pets/bulk-delete` beside it is `updateBulkDelete`; `PUT /users/{id}/update-password` keeps `updatePasswordUser` and a POST beside it is the singleton `createUserUpdatePassword`. A path-named operation that would share an `operationId`'s name on its path is numbered (a path-named PATCH beside `operationId: updatePet` on the PUT is `updatePet2`), and an `operationId` the document reuses on one path is numbered with a warning, as it is across paths. A name any pass gives an operation is checked against every name the service holds: an action takes the first of its names no operation holds (`createCreate` for `POST /pets/create` beside `POST /pets` when the GET on `/pets/create` carries `operationId: createPets`), and once every pass has run, a path-named operation left sharing a name on its path with an `operationId` or with another verb is numbered (a path-named PATCH beside `operationId: updatePet` on the PUT is `updatePet2`, and one on `/store/top10/{id}` beside `operationId: updateTop10` is `updateTop10No2`) — a name another operation holds is never what a qualifier gives, so `GET /api/notes` beside `operationId: list` on `/api/{teamId}/notes` becomes `listNotes`, and `list2`, never `listNotes2`, when `POST /api/notes` carries `operationId: listNotes`. Two colliding actions are qualified by the path of their parent, never by repeating the verb (`adoptPet` and `adoptPetRescue`, not `adoptPetAdopt`), and two colliding singletons by the path around the parent, never by repeating it (`getPetStatus` and `getPetStatusRescue`, not `getPetStatusPet`).

## Stage 2: Emit (`src/engine/`)

Entry point: `orchestrator.ts` → `generate(spec, emitter, options)`

The orchestrator calls each generator method in order:

```typescript
generateModels(models, ctx); // Data classes/structs
generateEnums(enums, ctx); // Enum types
generateResources(services, ctx); // API resource classes
generateClient(spec, ctx); // HTTP client
generateErrors(ctx); // Error hierarchy
generateTypeSignatures(spec, ctx); // Type annotations (optional)
generateTests(spec, ctx); // Tests + fixtures
buildOperationsMap?.(spec, ctx); // Operations map for .oagen-manifest.json (optional)
```

### OperationPlan

Before rendering, emitters call `planOperation(op)` from `src/engine/operation-plan.ts` to compute an `OperationPlan` — a flat struct of semantic decisions (`isDelete`, `hasBody`, `isIdempotentPost`, `pathParamsInOptions`, `isPaginated`, `responseModelName`, etc.). This separates _what_ the generated code should do from _how_ it is rendered as a string. The plan is shared across all language emitters.

Each method returns `GeneratedFile[]`. The orchestrator:

1. Collects all files
2. Prepends `emitter.fileHeader()` to each file's content
3. Passes to writer (or prints paths in dry-run mode)

### EmitterContext

Every generator method receives:

- `namespace` — snake_case version of the SDK namespace
- `namespacePascal` — PascalCase version
- `spec` — the full IR (for cross-references)
- `outputDir` — target directory

## Stage 3: Write (`src/engine/writer.ts`)

- Writes `GeneratedFile[]` to disk under the output directory
- Respects `skipIfExists` flag — won't overwrite files marked as hand-editable
- Creates directories as needed

## Emitter Registry (`src/engine/registry.ts`)

Simple map from language name → `Emitter` instance. Emitters are registered at startup via `oagen.config.ts`:

```typescript
// In oagen.config.ts (consumer project)
import { acmeEmittersPlugin } from "@acme/oagen-emitters";

export default {
  ...acmeEmittersPlugin,
  // spec interpretation policy...
};
```

## Diff Engine (`src/differ/`)

Compares two parsed specs (old vs new) and produces a `DiffReport` classifying changes as additive, breaking, or mixed. Used by the `oagen diff` CLI command for review before regenerating. It compares the document root (`baseUrl` and `servers`, with their variables, and the default `security`), models, enums, services and webhooks; every change kind and its classification is listed under [`oagen diff`](../cli.md#oagen-diff) in the CLI reference.
