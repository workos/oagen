# Changelog

## [0.32.0](https://github.com/workos/oagen/compare/v0.31.0...v0.32.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* **parser:** a list body whose pagination companion is spelled in camelCase, PascalCase or kebab-case (`pageInfo`, `PageInfo`, `page-info`, `listMetadata`, …) is now unwrapped as a list envelope (`ListPetsResponse` + `ListPetsResponsePageInfo` become `string[]` + `PageInfo`, with `pageInfo.hasNextPage` as the stop field even beside a `total`), and a body whose companion only matched a pattern across a camelCase word boundary (`nameTag`, `homeTable`) is now a plain response model ([#363](https://github.com/workos/oagen/issues/363))
* **parser:** an operation returning a list envelope with no query parameter that can drive an iterator (no paging parameter at all, or a `page`/`offset` parameter without a page-size one) loses its `pagination` and its `response` becomes the wrapper model (`ListPetsResponse { data, total_pages }`) instead of the bare array; a `strategy: 'none'` envelope whose required companion carries a constant `type`/`object` is the full wrapper rather than that companion alone; a non-primary 2xx body of another shape is `<Op>Response<code>` (`CreatePetResponse201`) instead of the primary's model ([#361](https://github.com/workos/oagen/issues/361))
* **parser:** an `allOf` component gains the `properties` written beside its `allOf` (`Dog { name }` → `Dog { breed, name }`), a name declared twice keeps the first always-applying declaration, a primary body `allOf: [{ $ref: X }]` is `X` instead of a copied `<Op>Response`, a field, parameter, header or error body `allOf: [{ $ref: X }, { $ref: Y }]` (or with a `required` beside the `$ref`) is the merged `<Parent><Field>` model instead of a bare `X`, and an `allOf` + `oneOf` with a single const-pinned variant dispatches instead of flattening ([#359](https://github.com/workos/oagen/issues/359))
* **parser:** inline error bodies are named `<Op>Error<code>` everywhere: a secondary media type's body moves from `<Op><MediaType>Error` to `<Op>Error<code><MediaType>` (`GetNoteError404ApplicationYaml`), a `4XX`/`5XX` body from `<Op>ClientErrorResponse`/`<Op>ServerErrorResponse` to `<Op>Error4Xx`/`<Op>Error5Xx`, and a taken name steps to `…Body` instead of a number ([#356](https://github.com/workos/oagen/issues/356))
* **parser:** in a document that declared a model and an enum under one name, the model is renamed (`GetPetResponse` → `GetPetResponse2`, `PetOwner` → `PetOwner2`, `ListMetadata` → `ListPetsListMetadata`, an object error body beside an enum error body of the same stem → `GetPetError404Body`), reported by `oagen diff` as a breaking `model-removed` ([#355](https://github.com/workos/oagen/issues/355))
* **parser:** models and enums minted for a response written as a `$ref` into `components/responses` are named after the component instead of each operation (`NotesXMeta` and `PetsXMeta` become one `CardXMeta`, `GetNoteApplicationYamlResponse` and `GetPetApplicationYamlResponse` one `CardApplicationYamlResponse`), stepping by number (`CardXMeta2`) on a clash ([#354](https://github.com/workos/oagen/issues/354))
* **parser:** a `default` or range body from `components/responses` is renamed from `<Op>DefaultResponse`/`<Op>ClientErrorResponse` to `<Component>Response`, a component body at an explicit error code that clashes with an operation's own model steps to `ProblemResponse2` instead of `ProblemResponseBody`, and `oagen diff` exits `2` when an inline `default` or range body moves into `components/responses` ([#353](https://github.com/workos/oagen/issues/353))
* **parser:** in documents that produced a model and an enum under one name, a parameter model moves to its location-qualified name (`PetsQueryStatus`), a deferred model to its qualified name (`PetsSearchPetsXMode`), an object error body to `…Body`, and a response-header object model named like the same operation's header-parameter enum moves from `PetsListPetsXStatus` to `PetsXStatus200` ([#348](https://github.com/workos/oagen/issues/348))
* **parser:** a parameter declared with `content` is typed from its `application/json`, `+json` or `text/plain` schema instead of as a `string` and carries `Parameter.contentType`; a response header declared only with `content` under a media type that isn't read becomes a `string` with a warning; `oagen diff` reports a parameter's media type moving as a breaking `param-content-type-changed` ([#347](https://github.com/workos/oagen/issues/347))
* **parser:** header parameters, and response headers, that differ only in case are one entry; types minted from a header name with inner capitals are renamed (`PetsETag` → `PetsEtag`, `PetsXRateLimitPolicy` → `PetsXRatelimitPolicy`); `ParamChange['kind']` gains `param-name-changed` ([#345](https://github.com/workos/oagen/issues/345))
* **differ:** server URLs are compared in their RFC 3986 form: `Operation.servers` is absent for a restatement in another spelling, a spelling-only server change no longer exits `2`, `server-modified.url` carries the new document's spelling, and `normalizeServerUrl` is a new export ([#343](https://github.com/workos/oagen/issues/343))
* **differ:** a change to a server variable the URL template doesn't reference is additive (exit `1`, was `2`); `Operation.servers` is absent for an operation whose own servers are `/` with variables under a document with no servers or only `/`; a variable change on `/` goes unreported only when `/` is the document's sole server (beside a named host it is an additive `server-modified`) ([#342](https://github.com/workos/oagen/issues/342))
* **differ:** `Operation.servers` is no longer set when an operation's or path item's servers are only `/` under a document at the default, and `oagen diff` treats no `servers`, `servers: []` and `servers: [{ url: '/' }]` as one; new exports `baseUrlBeyondDefault`, `isDefaultServerEntry`, `isDefaultServerList`, `serversOrDefault` ([#341](https://github.com/workos/oagen/issues/341))
* **parser:** a numbered operation name ending in a digit is set off with `No` (`listV12` → `listV1No2`, `getV22` → `getV2No2`) ([#339](https://github.com/workos/oagen/issues/339))
* **parser:** path-derived names of operations without an `operationId` change (`listMembersTeams` → `listMembers`, `listArchivedMembers2` → `listArchived`, `getPet2` → `getPets2`) ([#338](https://github.com/workos/oagen/issues/338))
* **parser:** tagged operations that an untagged neighbour had carved out of their tag move back into the tag's service (`Api.listNotes` → `Notes.listNotes`, reported as `service-removed`); a tagged `/` moves from service `""` to its tag's service, and an untagged one to `Default` ([#337](https://github.com/workos/oagen/issues/337))
* **parser:** an inline model named like a component folds onto it only when the component admits its shape (an identical one for a request body or parameter); otherwise it keeps its own fields under a site-qualified name (`GetPetResponse2`), and the component is never replaced ([#336](https://github.com/workos/oagen/issues/336))
* **parser:** an array component's empty model is removed and every `$ref` to it is typed as the array (`Pet[]`, with no `Pets` alias left); its inline items get `<Component>Item…` models ([#335](https://github.com/workos/oagen/issues/335))
* **parser:** an inline model built from an `allOf` with a `oneOf`/`anyOf` member gains the variants' fields wherever it appears, and `allOf: [{ $ref: Pet }, { oneOf }]` is typed as its own model instead of `Pet` ([#334](https://github.com/workos/oagen/issues/334))
* **parser:** non-object items of a direct array body move from `<Op>Response…` to `<Op>Item…` (`ListKindsResponse` → `ListKindsItem`); `properties` beside an `allOf`/`oneOf` become one inline model or union; a `data` nullable through `oneOf`/`anyOf` is read as a list envelope; a parameter typed like a same-named component gets its own qualified model (`PetsListPetsFilter`) ([#333](https://github.com/workos/oagen/issues/333))
* **parser:** a response-header enum whose members an earlier status code's header already stepped to shares that enum (`PetsXPolicy429`), so `PetsXPolicy503` and `PetsXPolicyDefault` are no longer minted ([#332](https://github.com/workos/oagen/issues/332))
* **parser:** an inline body identical to one on another status code shares that code's model, so `…Response201`, `…Error409` and status-coded header models (`DocumentsXMeta429`, `PetCreatePetXMeta`) are removed, with the models and enums only they reached ([#331](https://github.com/workos/oagen/issues/331))
* **parser:** path-named singletons are named for every method (`listStatus` → `getPetStatus`), verb-carrying segments lose the method's verb (`deleteBulkDelete` → `bulkDelete`, `updateUpdatePassword` → `updatePasswordUser`), and an action beside the CRUD operation of its name takes the collection (`createUpdate` → `updatePets`) ([#324](https://github.com/workos/oagen/issues/324))
* **parser:** in documents with a colon in a path, a custom method is named like its slash form (`createByPetIdAdopt` → `adoptPet`), services named from a colon segment merge into the resource's service (`PetsBatchGet.create` → `Pets.createBatchGet`), and the slash form's inline models lose their hash (`ReportsByIdExport9F0D0EPostRequest` → `ReportsByIdExportPostRequest`) ([#322](https://github.com/workos/oagen/issues/322))
* **parser:** of a plural/singular path pair, the plural keeps its own name (`getCompany`/`getCompany2` → `getCompanies`/`getCompany`, `getPet2` → `getPets`), deeper item segments are singular (`getToyCats` → `getToyCat`), and `By<Param>` suffixes the singular makes unnecessary disappear (`listMembersTeamsByOrgIdByTeamId` → `listMembersTeam`) ([#321](https://github.com/workos/oagen/issues/321))
* **parser:** a component `oneOf`/`anyOf` of string consts is an `Enum`, and a `$ref` to it an `EnumRef` (`nullable` when it admits `null`), instead of a named union of literal variants with an empty model ([#318](https://github.com/workos/oagen/issues/318))
* **parser:** `Operation.response` is `unknown` instead of `string` for an operation with no 2xx or 3xx response (only `default`, only error codes, only ranges, or an empty or missing `responses`) ([#317](https://github.com/workos/oagen/issues/317))
* **parser:** `PaginationMeta.strategy` gains `'page'`, reported instead of `'offset'` for `page`/`page_number`/`page_num` with a page-size parameter, and a body whose only companion is a stop field (`hasMore`, `has_next`, `pageCount`, …) is unwrapped as a list envelope ([#245](https://github.com/workos/oagen/issues/245))
* **parser:** `Model.discriminator` is also set for a pure `oneOf`/`anyOf` component with a `discriminator` or a const property every variant shares, whose inline object variants become models of their own, and a `$ref` to a named union that admits `null` resolves to `nullable` ([#244](https://github.com/workos/oagen/issues/244))
* **parser:** `errors[].type` for an inline error body now names `<Op>Error<code>` instead of the bare `Error<code>`. The old name never resolved to a model, so nothing could have been generated from it correctly, but any emitter or snapshot that printed the name verbatim observes a different string, and `spec.models` gains one model per inline error body. On the WorkOS spec 250 of 266 operations' error TypeRefs change (`Error404` → `AgentBlueprintsGetError404`, …).
* **parser:** Names that an SDK generated from an untagged, rooted spec exposes can change. `operationId`-named operations and tagged services are untouched.
* **parser:** fallback names of item operations are singular (`getUsers` → `getUser`), POST actions on one item lead with the action (`createPin` → `pinNote`, `createAdopt` → `adoptPet`), and response-header models of `operationId`-less operations are qualified by the path stem (`NotesCreatePinXMeta` → `NotesByIdPinPostXMeta`) ([#230](https://github.com/workos/oagen/issues/230))
* **parser:** path-derived names that collided within a service are renamed: repeated words are dropped (`listNotesNotes` → `listNotes`), paths told apart by their parameters gain `By<Param>` (`Notes.listByTeamId`), paths flattening to the same words are numbered (`list2`), and a reused `operationId` is suffixed (`listNotes2`) with a warning ([#227](https://github.com/workos/oagen/issues/227))
* **parser:** an untagged document whose paths share an API root (`/api`, `/v1`, `/api/v1`, …) gets one service per resource instead of one named after the root, and fallback names drop the root and service words (`Api.listNotes` → `Notes.list`) ([#224](https://github.com/workos/oagen/issues/224))

### Features

* **differ:** diff security and tags on operations and webhooks ([#326](https://github.com/workos/oagen/issues/326)) ([9f6e3e0](https://github.com/workos/oagen/commit/9f6e3e0106ff648a42baea62e09722c39e77a0b2))
* **differ:** report an operation's request body encoding change ([#340](https://github.com/workos/oagen/issues/340)) ([a8c286c](https://github.com/workos/oagen/commit/a8c286c59d444c741c7bb8a40929776e83019e47))
* **differ:** report baseUrl and servers changes ([#255](https://github.com/workos/oagen/issues/255)) ([faf802a](https://github.com/workos/oagen/commit/faf802ac1773cd7f204bf35e7f8400fae52a6e19))
* **differ:** report deprecation changes on every IR node ([#261](https://github.com/workos/oagen/issues/261)) ([19188c9](https://github.com/workos/oagen/commit/19188c996cd2b29e4b7923e44ac047ec6edc660d))
* **parser:** carry a request body's description into the IR ([#367](https://github.com/workos/oagen/issues/367)) ([235bca2](https://github.com/workos/oagen/commit/235bca207719509311d20e8f533ccc6cc1588f2e))
* **parser:** carry an inline enum schema's description onto its enum ([#368](https://github.com/workos/oagen/issues/368)) ([46a17d2](https://github.com/workos/oagen/commit/46a17d2dace009a399d4a053dfa63e222fea51a4))
* **parser:** carry deprecated on models and enums ([#229](https://github.com/workos/oagen/issues/229)) ([254e6e2](https://github.com/workos/oagen/commit/254e6e2f424a205d29258a905747e3babce6c2d4))
* **parser:** carry the primary success status code for smoke checks ([#327](https://github.com/workos/oagen/issues/327)) ([9691b9e](https://github.com/workos/oagen/commit/9691b9e77a0769044d500d7d9e40399d03241e6a))
* **parser:** carry x-* extensions into the IR ([#369](https://github.com/workos/oagen/issues/369)) ([dd0b50b](https://github.com/workos/oagen/commit/dd0b50b8b199e7202f04a3b569fe6e1973459d38))
* **parser:** keep externalDocs in the IR ([#228](https://github.com/workos/oagen/issues/228)) ([7ffaf94](https://github.com/workos/oagen/commit/7ffaf94352880d1361564aa0ef70b77bf6522457))
* **parser:** keep externalDocs on fields, params, headers, enums ([#259](https://github.com/workos/oagen/issues/259)) ([8227291](https://github.com/workos/oagen/commit/822729168c1f6aaff87e33be109eace3266edad5))
* **parser:** keep path-level and operation-level servers ([#257](https://github.com/workos/oagen/issues/257)) ([7e447f0](https://github.com/workos/oagen/commit/7e447f015a310eef8b543cec76b3ed461ef42fed))
* **parser:** keep response content types in the IR ([#233](https://github.com/workos/oagen/issues/233)) ([189077f](https://github.com/workos/oagen/commit/189077f84e4dceee583d21adb4741b0b963be8e4))
* **parser:** keep response descriptions in the IR ([#223](https://github.com/workos/oagen/issues/223)) ([d8bb75f](https://github.com/workos/oagen/commit/d8bb75f73f005e4182152185e903edfdd9725a9a))
* **parser:** keep server variables and resolve baseUrl defaults ([#226](https://github.com/workos/oagen/issues/226)) ([23595f7](https://github.com/workos/oagen/commit/23595f762c6626d3c2bc36e2e12d45c73c89be35))
* **parser:** keep the default and range responses in the IR ([#232](https://github.com/workos/oagen/issues/232)) ([92cf9c1](https://github.com/workos/oagen/commit/92cf9c162772d0da491965e3128836c824eb9df9))
* **parser:** keep the list items property description ([#222](https://github.com/workos/oagen/issues/222)) ([c01e2be](https://github.com/workos/oagen/commit/c01e2be72fb9de72fcbb559c70a0257d6e740a56))
* **parser:** keep variants and discriminator on named unions ([#244](https://github.com/workos/oagen/issues/244)) ([a9f01a5](https://github.com/workos/oagen/commit/a9f01a5d2342adb5daeeb32564e35b0d695d9680))
* **parser:** keep whether a request body is required ([#225](https://github.com/workos/oagen/issues/225)) ([4936cee](https://github.com/workos/oagen/commit/4936cee636ef2fafc75f19f6c6925938981053c9))
* **parser:** page strategy, end-of-iteration field, x-pagination ([#245](https://github.com/workos/oagen/issues/245)) ([e9c4583](https://github.com/workos/oagen/commit/e9c458371d306afe98446f209280e4fdf7bbff2a))
* **parser:** parse top-level webhooks into the IR ([#231](https://github.com/workos/oagen/issues/231)) ([2e5d8fc](https://github.com/workos/oagen/commit/2e5d8fc12480bc43e63d6bae9d031e81047682dd))
* **parser:** read request bodies by essence, keep every media type ([#329](https://github.com/workos/oagen/issues/329)) ([ab510b8](https://github.com/workos/oagen/commit/ab510b825e2c71cf72ad72bf429cc4efe825f1ba))


### Bug Fixes

* **differ:** classify operation server changes as the document does ([#349](https://github.com/workos/oagen/issues/349)) ([d919010](https://github.com/workos/oagen/commit/d919010edef13906dd9e39b1d971e69342d7ecc1))
* **differ:** compare an operation's cookie parameters ([#344](https://github.com/workos/oagen/issues/344)) ([bb2e67a](https://github.com/workos/oagen/commit/bb2e67ad16ad49ab25c43ce00a45fe61ecad6692))
* **differ:** compare response headers on every response entry ([#346](https://github.com/workos/oagen/issues/346)) ([31dec30](https://github.com/workos/oagen/commit/31dec304f1825ff8ba313886241192a24e2f3446))
* **differ:** compare response media types by essence ([#330](https://github.com/workos/oagen/issues/330)) ([3a0d66e](https://github.com/workos/oagen/commit/3a0d66e41f28fa1a1922af06cb8780de20593a39))
* **differ:** compare server URLs in their RFC 3986 form ([#343](https://github.com/workos/oagen/issues/343)) ([bb7bb9b](https://github.com/workos/oagen/commit/bb7bb9bb6810e064c7bb49dee08b8a339bb6a54e))
* **differ:** keep a variant added to a discriminated union additive ([#358](https://github.com/workos/oagen/issues/358)) ([39e48a1](https://github.com/workos/oagen/commit/39e48a1c3e6dbff12b4e2d856367749d3dd37834))
* **differ:** make unreferenced server variable changes additive ([#342](https://github.com/workos/oagen/issues/342)) ([87600e4](https://github.com/workos/oagen/commit/87600e4f10ccc76eacc017ceb24fe6d7277507a2))
* **differ:** report an added optional request body as additive ([#253](https://github.com/workos/oagen/issues/253)) ([ba40919](https://github.com/workos/oagen/commit/ba40919956c5a840e3e3e8bffe676b386e45374e))
* **differ:** treat servers [{ url: '/' }] and no servers as one ([#341](https://github.com/workos/oagen/issues/341)) ([789e153](https://github.com/workos/oagen/commit/789e15330428bc07a442a014ddf39c61b504082c))
* **parser:** add a path qualifier only when it tells names apart ([#338](https://github.com/workos/oagen/issues/338)) ([a21396a](https://github.com/workos/oagen/commit/a21396a5776b0c80795228fe640db0939559ace5))
* **parser:** admit a Json fold's children before collapsing them ([#357](https://github.com/workos/oagen/issues/357)) ([0e75a1a](https://github.com/workos/oagen/commit/0e75a1a9446443980561ebf614a18b96e4ccfeba))
* **parser:** create models for inline error response bodies ([#243](https://github.com/workos/oagen/issues/243)) ([491fea2](https://github.com/workos/oagen/commit/491fea20675067212c70bc0c94be1c7220061614))
* **parser:** drive an iterator only by a declared query parameter ([#361](https://github.com/workos/oagen/issues/361)) ([b8f6326](https://github.com/workos/oagen/commit/b8f6326132a8caabfff4e7770efd9b4b72eea241))
* **parser:** extract item models for untyped array responses ([#242](https://github.com/workos/oagen/issues/242)) ([908b716](https://github.com/workos/oagen/commit/908b7160c7c1b0dcf09d0193af6ca8ed47bbb13d))
* **parser:** fold a deprecated inline copy onto its live component ([#364](https://github.com/workos/oagen/issues/364)) ([910c9dc](https://github.com/workos/oagen/commit/910c9dc5e64032701956b493a308255c69e37996))
* **parser:** fold inline models onto components only when admitted ([#336](https://github.com/workos/oagen/issues/336)) ([f38be75](https://github.com/workos/oagen/commit/f38be758a3c8090c03c1307931a5e30a99511e66))
* **parser:** keep a component's properties written beside its allOf ([#359](https://github.com/workos/oagen/issues/359)) ([d3f14bc](https://github.com/workos/oagen/commit/d3f14bc6d06c0bd10b0c176bb118e7bc48b06b59))
* **parser:** keep a parameter model off every enum name ([#348](https://github.com/workos/oagen/issues/348)) ([56a758e](https://github.com/workos/oagen/commit/56a758e4680436591712e0b2c3d8dac4b9cdc96c))
* **parser:** keep a renamed nested model with its parent ([#365](https://github.com/workos/oagen/issues/365)) ([de29dfb](https://github.com/workos/oagen/commit/de29dfb2ea9690e22b59aeef5259ae493c824e8d))
* **parser:** keep an inline model off the document's enum names ([#355](https://github.com/workos/oagen/issues/355)) ([7948715](https://github.com/workos/oagen/commit/7948715f012d7cdd6d4da55d3c9722c29f91a2a1))
* **parser:** keep deprecated models off live operations and fields ([#263](https://github.com/workos/oagen/issues/263)) ([f57e0d3](https://github.com/workos/oagen/commit/f57e0d3bd9a7af7068b10cd3f209f3810497f4a8))
* **parser:** keep fallback operation names unique within a service ([#227](https://github.com/workos/oagen/issues/227)) ([83b3eb4](https://github.com/workos/oagen/commit/83b3eb4634af2731e5e8712dfebb9b29d5fcd71c))
* **parser:** keep path-named operations unique under an API root ([#258](https://github.com/workos/oagen/issues/258)) ([8b4425d](https://github.com/workos/oagen/commit/8b4425d7426ef417282f9ad0662e637ae4aad195))
* **parser:** keep plural path names, singularise item segments ([#321](https://github.com/workos/oagen/issues/321)) ([2c9aab1](https://github.com/workos/oagen/commit/2c9aab11d949c58028eb6cda798653be3d64ee7b))
* **parser:** match response media types by essence ([#240](https://github.com/workos/oagen/issues/240)) ([169bd20](https://github.com/workos/oagen/commit/169bd2085ab4496ccb4f63a053415395989df436))
* **parser:** materialize a union nested under a oneOf variant ([#319](https://github.com/workos/oagen/issues/319)) ([0921edd](https://github.com/workos/oagen/commit/0921edd786236d129a62f662c3111dc1d9a4520e))
* **parser:** merge the oneOf member of an inline allOf everywhere ([#334](https://github.com/workos/oagen/issues/334)) ([4b90ed2](https://github.com/workos/oagen/commit/4b90ed2cd9d209335fe3559dba2769f5e8f89ad1))
* **parser:** name a custom-method path like its slash form ([#322](https://github.com/workos/oagen/issues/322)) ([63ae120](https://github.com/workos/oagen/commit/63ae120ee197c4e6e93ad1ab4678dfa08103d1ee))
* **parser:** name every inline error body `<Op>Error<code>` ([#356](https://github.com/workos/oagen/issues/356)) ([824c7e4](https://github.com/workos/oagen/commit/824c7e4bc9fd1e6fdead783fad11a6b4e8d2e7ec))
* **parser:** name singleton and action segments for every method ([#324](https://github.com/workos/oagen/issues/324)) ([0dfbcdf](https://github.com/workos/oagen/commit/0dfbcdf8fafaf3b6def66f854acf7057b4ecbcfb))
* **parser:** path item summary/description, webhook externalDocs ([#323](https://github.com/workos/oagen/issues/323)) ([6b137d9](https://github.com/workos/oagen/commit/6b137d9aec11df412511515cea4e060bf8025dd5))
* **parser:** promote inline enums of request and success bodies ([#332](https://github.com/workos/oagen/issues/332)) ([8c7433d](https://github.com/workos/oagen/commit/8c7433dfc7a61aa4e13bae967281e150ed1dad32))
* **parser:** qualify a title two shapes take at different depths ([#320](https://github.com/workos/oagen/issues/320)) ([1e80b71](https://github.com/workos/oagen/commit/1e80b7184a335189c37ad44017070ed57e6013c9))
* **parser:** read a pagination companion in any spelling ([#363](https://github.com/workos/oagen/issues/363)) ([8012550](https://github.com/workos/oagen/commit/801255081fb02aae0f917a86e1964e985711566f))
* **parser:** read a status code only from a three-digit 100–599 key ([#328](https://github.com/workos/oagen/issues/328)) ([e2e9e8a](https://github.com/workos/oagen/commit/e2e9e8a75a8480f09dc43d18f207ca5457d3b045))
* **parser:** read the stop field of every wrapper a dataPath keeps ([#360](https://github.com/workos/oagen/issues/360)) ([1ad8db9](https://github.com/workos/oagen/commit/1ad8db979ab7350ffde95568f857955bc3ffa27c))
* **parser:** resolve a paths entry written as a $ref path item ([#350](https://github.com/workos/oagen/issues/350)) ([0ad6223](https://github.com/workos/oagen/commit/0ad6223fdb69cc6b40afe221fa43677e7fd44822))
* **parser:** set a numeric suffix off from a name ending in a digit ([#339](https://github.com/workos/oagen/issues/339)) ([6876603](https://github.com/workos/oagen/commit/6876603d8313c45e0bac6d76c05203e9b920a961))
* **parser:** set EnumValue description and deprecated from the spec ([#318](https://github.com/workos/oagen/issues/318)) ([bf7ad06](https://github.com/workos/oagen/commit/bf7ad0695752af292b9867bc594c5f4f5009ef4c))
* **parser:** share a component response body at default and ranges ([#353](https://github.com/workos/oagen/issues/353)) ([085e944](https://github.com/workos/oagen/commit/085e944d6705481ab63e64d2588c6daee0c05850))
* **parser:** share a component response's media types and headers ([#354](https://github.com/workos/oagen/issues/354)) ([b015ea8](https://github.com/workos/oagen/commit/b015ea832deef6f6c8370e99f5841c51041b93d7))
* **parser:** share identical inline bodies across status codes ([#331](https://github.com/workos/oagen/issues/331)) ([1a4123a](https://github.com/workos/oagen/commit/1a4123abdc28e8169db2599740c28ca09f450b86))
* **parser:** share one name among identical copies leaving a name ([#366](https://github.com/workos/oagen/issues/366)) ([fe212ff](https://github.com/workos/oagen/commit/fe212ffdeb3c3c7fcb86f2a578669c1944e67e8b))
* **parser:** singular resource and action verbs in fallback names ([#230](https://github.com/workos/oagen/issues/230)) ([c7bff45](https://github.com/workos/oagen/commit/c7bff4568962f4b8d6aa68eaa348d9ea5dfae037))
* **parser:** skip a shared API root when naming services from paths ([#224](https://github.com/workos/oagen/issues/224)) ([4ac088b](https://github.com/workos/oagen/commit/4ac088bcf9fc1144972d8ac6c481dbe3ab703c24))
* **parser:** split tagged services over the tag's own operations ([#337](https://github.com/workos/oagen/issues/337)) ([5ccdda8](https://github.com/workos/oagen/commit/5ccdda86e34c661b841987f9adda05a65d4a8632))
* **parser:** treat header parameters as one whatever their case ([#345](https://github.com/workos/oagen/issues/345)) ([de5cf5f](https://github.com/workos/oagen/commit/de5cf5ff15031b6df13c511aeee4ed635b4e480c))
* **parser:** type a $ref to an array component as the array ([#335](https://github.com/workos/oagen/issues/335)) ([f9b35dc](https://github.com/workos/oagen/commit/f9b35dc3e50538fb7eb36fb9e64c72eff7ae3943))
* **parser:** type a parameter declared with content from its schema ([#347](https://github.com/workos/oagen/issues/347)) ([ed2b0de](https://github.com/workos/oagen/commit/ed2b0de6bb63ddba9badf5be69c7f76fb00ea978))
* **parser:** type an operation with no 2xx/3xx response as unknown ([#317](https://github.com/workos/oagen/issues/317)) ([4b05edc](https://github.com/workos/oagen/commit/4b05edc3e5d0078b8f6a240024b62c35295ad196))
* **parser:** type error bodies served as +json media types ([#239](https://github.com/workos/oagen/issues/239)) ([24a0691](https://github.com/workos/oagen/commit/24a0691554e4d5946f7cc0975a2f93aa16fe5828))
* **parser:** type inline array items alike at every site ([#333](https://github.com/workos/oagen/issues/333)) ([3d6627b](https://github.com/workos/oagen/commit/3d6627b2edde0ecf4b7ec8547fe4d1b5b1207233))
* **parser:** warn on x-pagination fields the operation cannot satisfy ([#362](https://github.com/workos/oagen/issues/362)) ([98552cd](https://github.com/workos/oagen/commit/98552cd8dcb14e04a0c38a5754676eb22acd29ae))
* **parser:** warn when an operation's callbacks are ignored ([#325](https://github.com/workos/oagen/issues/325)) ([bef9652](https://github.com/workos/oagen/commit/bef96528f5232dde96144060f17a30152e4e8764))

## [0.31.0](https://github.com/workos/oagen/compare/v0.30.2...v0.31.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **parser:** name operationId-less inline models from the full path ([#201](https://github.com/workos/oagen/issues/201))
* **parser:** group security requirements, carry document default ([#185](https://github.com/workos/oagen/issues/185))

### Features

* **parser:** carry scheme names on AuthScheme and accept HTTP Basic ([#178](https://github.com/workos/oagen/issues/178)) ([cc8267f](https://github.com/workos/oagen/commit/cc8267f28543a9a6b2d0c6f4d7581411eceea62f))
* **parser:** carry validation keywords as constraints ([#202](https://github.com/workos/oagen/issues/202)) ([0b4dfef](https://github.com/workos/oagen/commit/0b4dfef2b1151803d24498754cb537c18726e2e4))
* **parser:** group security requirements, carry document default ([#185](https://github.com/workos/oagen/issues/185)) ([a76dbdc](https://github.com/workos/oagen/commit/a76dbdc15ebb1a8686b3290ac7629ea1869234e6))
* **parser:** keep an operation's summary as its own field ([#196](https://github.com/workos/oagen/issues/196)) ([6cb86e5](https://github.com/workos/oagen/commit/6cb86e54a6c6fb5e71163590384ec9bee42df989))
* **parser:** keep declared response headers in the IR ([#200](https://github.com/workos/oagen/issues/200)) ([262e54d](https://github.com/workos/oagen/commit/262e54dbf5a387b4fb950823c0af7b001a680250))
* **parser:** keep list-envelope companions on PaginationMeta ([#184](https://github.com/workos/oagen/issues/184)) ([3e8f5f3](https://github.com/workos/oagen/commit/3e8f5f3274f9354fff26dcfa6036db7c38481372))
* **parser:** name undiscriminated variants from title or property ([#219](https://github.com/workos/oagen/issues/219)) ([f31503e](https://github.com/workos/oagen/commit/f31503ef7253a9fb2804a585c642cc176bee0dab))
* **parser:** pass original schema name to schemaNameTransform ([#179](https://github.com/workos/oagen/issues/179)) ([829aea7](https://github.com/workos/oagen/commit/829aea7ce70c3a2165cd0f795ef93406d093abc7))
* **parser:** read JSON Schema examples on fields and params ([#198](https://github.com/workos/oagen/issues/198)) ([7870f54](https://github.com/workos/oagen/commit/7870f54e1aa2c16f3486e0d04a6d109e0f85575e))
* **parser:** set Service.description from document tags ([#197](https://github.com/workos/oagen/issues/197)) ([bbbdec8](https://github.com/workos/oagen/commit/bbbdec8d37ed457a63d7fde15046b4b4ed52c236))


### Bug Fixes

* **parser:** drop null enum members and carry nullability through enum refs ([#180](https://github.com/workos/oagen/issues/180)) ([6b21a8c](https://github.com/workos/oagen/commit/6b21a8c7207d028dd8470c195260b687a2de9082))
* **parser:** extract array-oneOf and map-value inline models ([#199](https://github.com/workos/oagen/issues/199)) ([9ad2870](https://github.com/workos/oagen/commit/9ad28703cc2d9b7f8dbc8397c2a39610bf446b36))
* **parser:** name operationId-less inline models from the full path ([#201](https://github.com/workos/oagen/issues/201)) ([67df628](https://github.com/workos/oagen/commit/67df6286e69cb7f6f6d998eca6a82ed8ccec38e5))
* **parser:** read parameter description from its schema ([#195](https://github.com/workos/oagen/issues/195)) ([55bfbd8](https://github.com/workos/oagen/commit/55bfbd879d66011c21f65ee9fe1f1303f247f687))

## [0.30.2](https://github.com/workos/oagen/compare/v0.30.1...v0.30.2) (2026-09-10)


### Bug Fixes

* **parser:** send body-duplicated query params body-only ([#168](https://github.com/workos/oagen/issues/168)) ([ec1d19b](https://github.com/workos/oagen/commit/ec1d19bea36a1fef3e8b4c6a111b465931d6f3f4))

## [0.30.1](https://github.com/workos/oagen/compare/v0.30.0...v0.30.1) (2026-09-08)


### Bug Fixes

* **compat:** record where an added parameter landed ([#165](https://github.com/workos/oagen/issues/165)) ([9424d55](https://github.com/workos/oagen/commit/9424d55698985636db1dbb2c1774215f706744e5))

## [0.30.0](https://github.com/workos/oagen/compare/v0.29.4...v0.30.0) (2026-09-01)


### Features

* **resolve:** detect method-name collisions before the build matrix ([#161](https://github.com/workos/oagen/issues/161)) ([10d2f6d](https://github.com/workos/oagen/commit/10d2f6d282438710abed99e6fa876467863e883b))

## [0.29.4](https://github.com/workos/oagen/compare/v0.29.3...v0.29.4) (2026-08-31)


### Bug Fixes

* **merger:** make Kotlin managed-accessor pruning actually fire ([#159](https://github.com/workos/oagen/issues/159)) ([7526fa8](https://github.com/workos/oagen/commit/7526fa89eb27352c0c165537170a2071aae39390))

## [0.29.3](https://github.com/workos/oagen/compare/v0.29.2...v0.29.3) (2026-08-31)


### Bug Fixes

* **parser:** type mutually-exclusive body group members correctly ([#158](https://github.com/workos/oagen/issues/158)) ([efd597e](https://github.com/workos/oagen/commit/efd597edc44f5ffa8bcb850ad8127a5f660e3fc6))
* resolve $ref parameters in operation parameters arrays ([#154](https://github.com/workos/oagen/issues/154)) ([020bc76](https://github.com/workos/oagen/commit/020bc76bf4234ff2e65a1e4efe8f00387ebffc02))

## [0.29.2](https://github.com/workos/oagen/compare/v0.29.1...v0.29.2) (2026-08-06)


### Bug Fixes

* **compat:** normalize Python type forms before diffing ([#151](https://github.com/workos/oagen/issues/151)) ([f0729ff](https://github.com/workos/oagen/commit/f0729ff9a5a17d05400e011542b7d3e75b07d863))

## [0.29.1](https://github.com/workos/oagen/compare/v0.29.0...v0.29.1) (2026-08-06)


### Bug Fixes

* **deps:** bump @redocly/openapi-core for js-yaml ^5 support ([#149](https://github.com/workos/oagen/issues/149)) ([6616230](https://github.com/workos/oagen/commit/6616230dec95cad2bf166c0aa94428278df1f2d3))

## [0.29.0](https://github.com/workos/oagen/compare/v0.28.1...v0.29.0) (2026-08-05)


### Features

* **parser:** support optionalFields in mutually-exclusive body groups ([#147](https://github.com/workos/oagen/issues/147)) ([be2e140](https://github.com/workos/oagen/commit/be2e140d46a89121cd5976c0cf1fe90ec3e27a39))

## [0.28.1](https://github.com/workos/oagen/compare/v0.28.0...v0.28.1) (2026-07-28)


### Bug Fixes

* **differ:** classify required response-only fields as additive ([#144](https://github.com/workos/oagen/issues/144)) ([b3b0faa](https://github.com/workos/oagen/commit/b3b0faa189c16fd4dd6b3cec230c30bda1a0d98b))

## [0.28.0](https://github.com/workos/oagen/compare/v0.27.0...v0.28.0) (2026-07-26)


### Features

* **compat:** read Elixir enum members from values/0 and dump/1 ([#141](https://github.com/workos/oagen/issues/141)) ([5e52f43](https://github.com/workos/oagen/commit/5e52f434720d36da574775a8c17b0542f9c7d793))

## [0.27.0](https://github.com/workos/oagen/compare/v0.26.1...v0.27.0) (2026-07-23)


### Features

* **compat:** add Swift (iOS) API surface extractor ([#139](https://github.com/workos/oagen/issues/139)) ([e7e82f4](https://github.com/workos/oagen/commit/e7e82f4cfe921afb0f4669e85b3bdc944df18e33))


### Bug Fixes

* escape block-comment terminators in generated doc comments ([#137](https://github.com/workos/oagen/issues/137)) ([15114ec](https://github.com/workos/oagen/commit/15114ec7f50a0ec5e8051d02becfb5f5124fdec9))

## [0.26.1](https://github.com/workos/oagen/compare/v0.26.0...v0.26.1) (2026-07-21)


### Bug Fixes

* emit nested inline models for inline request bodies ([#135](https://github.com/workos/oagen/issues/135)) ([2f19c70](https://github.com/workos/oagen/commit/2f19c7085cabf27b65b11d0817f3c84b8a03cf1a))

## [0.26.0](https://github.com/workos/oagen/compare/v0.25.1...v0.26.0) (2026-07-21)


### Features

* **ir:** export resolveMountTarget from the package root ([#133](https://github.com/workos/oagen/issues/133)) ([e0c72dd](https://github.com/workos/oagen/commit/e0c72dde26226a35a41412eab6fea0107bdc35d2))

## [0.25.1](https://github.com/workos/oagen/compare/v0.25.0...v0.25.1) (2026-07-16)


### Bug Fixes

* Respect naming policy in variant names and snippet wrappers ([#131](https://github.com/workos/oagen/issues/131)) ([d54caae](https://github.com/workos/oagen/commit/d54caae60f6f9c0c6a0617eb06391975df3d0430))

## [0.25.0](https://github.com/workos/oagen/compare/v0.24.6...v0.25.0) (2026-07-16)


### Features

* **ir:** support trailing-* wildcard keys in mount rules ([a74a353](https://github.com/workos/oagen/commit/a74a3532157a269007c265c525521cd66dfb71c1))


### Bug Fixes

* fmt ([0ab83d0](https://github.com/workos/oagen/commit/0ab83d0c44944eb419ee6307c7f2bce76a5dc0c1))

## [0.24.6](https://github.com/workos/oagen/compare/v0.24.5...v0.24.6) (2026-07-06)


### Bug Fixes

* **engine:** stop writing volatile manifest timestamp ([#126](https://github.com/workos/oagen/issues/126)) ([f847bc4](https://github.com/workos/oagen/commit/f847bc4410f2f4a174bcccd86f60fb2a04ddd93d))

## [0.24.5](https://github.com/workos/oagen/compare/v0.24.4...v0.24.5) (2026-07-06)


### Bug Fixes

* **parser:** resolve $ref branches in response allOf merge ([#127](https://github.com/workos/oagen/issues/127)) ([a1874b1](https://github.com/workos/oagen/commit/a1874b194e4c39511cdcabea5cca48e063b0e159))

## [0.24.4](https://github.com/workos/oagen/compare/v0.24.3...v0.24.4) (2026-07-02)


### Bug Fixes

* **engine:** validate modelHints against full spec ([#123](https://github.com/workos/oagen/issues/123)) ([e694e80](https://github.com/workos/oagen/commit/e694e80e4430077a97905eaaa59a67276d60ad29))

## [0.24.3](https://github.com/workos/oagen/compare/v0.24.2...v0.24.3) (2026-07-01)


### Bug Fixes

* **engine:** minimal scoped generation — model/enum scope to selected operations ([#121](https://github.com/workos/oagen/issues/121)) ([4859ff1](https://github.com/workos/oagen/commit/4859ff1da8bbd3f64256089c7e053be337b2f13f))

## [0.24.2](https://github.com/workos/oagen/compare/v0.24.1...v0.24.2) (2026-07-01)


### Bug Fixes

* **engine:** scope model/enum files to emit surface, not selection ([#119](https://github.com/workos/oagen/issues/119)) ([f765517](https://github.com/workos/oagen/commit/f765517dccd8530662e0367792bcb938cfc0b0da))

## [0.24.1](https://github.com/workos/oagen/compare/v0.24.0...v0.24.1) (2026-06-30)


### Bug Fixes

* **engine:** scope aggregate surface to selected + on-disk services ([#117](https://github.com/workos/oagen/issues/117)) ([e4500fe](https://github.com/workos/oagen/commit/e4500fe356d34794fe0be31bfcf05cbe087a3a89))

## [0.24.0](https://github.com/workos/oagen/compare/v0.23.0...v0.24.0) (2026-06-26)


### Features

* **parser:** fold discriminated-union request bodies ([8c61f57](https://github.com/workos/oagen/commit/8c61f57a826397f08396900a690e3a62ccfee493))

## [0.23.0](https://github.com/workos/oagen/compare/v0.22.7...v0.23.0) (2026-06-22)


### Features

* **generate:** scoped SDK generation via `--services` (emitter-aware) ([#114](https://github.com/workos/oagen/issues/114)) ([cd2eac7](https://github.com/workos/oagen/commit/cd2eac71ffd73b88a6ba95c7a7c8644a7f89443c))

## [0.22.7](https://github.com/workos/oagen/compare/v0.22.6...v0.22.7) (2026-06-19)


### Bug Fixes

* de-duplicate spliced imports; add fieldHints config ([#112](https://github.com/workos/oagen/issues/112)) ([ca9fb1b](https://github.com/workos/oagen/commit/ca9fb1bfc37376857e42a2f42fa2f5016f6a8ce1))

## [0.22.6](https://github.com/workos/oagen/compare/v0.22.5...v0.22.6) (2026-06-16)


### Bug Fixes

* **snippets:** de-duplicate fields present in both query and body ([#109](https://github.com/workos/oagen/issues/109)) ([433dda0](https://github.com/workos/oagen/commit/433dda00daef4ebd7b322236e7020b3299850db6))
* **snippets:** scope query/body dedupe to body fields only ([#111](https://github.com/workos/oagen/issues/111)) ([8a367cf](https://github.com/workos/oagen/commit/8a367cf97036e780ab9523daeb48dd9b1da92d3f))

## [0.22.5](https://github.com/workos/oagen/compare/v0.22.4...v0.22.5) (2026-06-11)


### Bug Fixes

* **engine:** treat region-protected declarations as present during merge ([#104](https://github.com/workos/oagen/issues/104)) ([e8e1299](https://github.com/workos/oagen/commit/e8e12992ffdd4c8a6cd684752b17b52e575a6df9))

## [0.22.4](https://github.com/workos/oagen/compare/v0.22.3...v0.22.4) (2026-06-03)


### Bug Fixes

* preserve blank line before ignore blocks after C# using directives ([06c197e](https://github.com/workos/oagen/commit/06c197efe35175d9707a0af003c6fa0e3e492653))

## [0.22.3](https://github.com/workos/oagen/compare/v0.22.2...v0.22.3) (2026-06-03)


### Bug Fixes

* pin tree-sitter-c-sharp to exact 0.23.1 ([3284a68](https://github.com/workos/oagen/commit/3284a68e4ef9ec287f0c19bba4632bcc8ae5509d))

## [0.22.2](https://github.com/workos/oagen/compare/v0.22.1...v0.22.2) (2026-06-03)


### Bug Fixes

* skip ambiguous anchors and pin tree-sitter-c-sharp ([#100](https://github.com/workos/oagen/issues/100)) ([da7be0e](https://github.com/workos/oagen/commit/da7be0e30ddd9259b8296f36ae19297116e9579f))

## [0.22.1](https://github.com/workos/oagen/compare/v0.22.0...v0.22.1) (2026-06-03)


### Bug Fixes

* respect overwriteExisting for test files without autogen header ([#96](https://github.com/workos/oagen/issues/96)) ([be9efc5](https://github.com/workos/oagen/commit/be9efc5212066ff8afaa04de22250d96dcdb46f7))

## [0.22.0](https://github.com/workos/oagen/compare/v0.21.1...v0.22.0) (2026-06-03)


### Features

* **snippets:** add snippet emitter framework primitives ([#97](https://github.com/workos/oagen/issues/97)) ([2c75d77](https://github.com/workos/oagen/commit/2c75d77dc46a1ff8a021181e4b3835dc743befa6))

## [0.21.1](https://github.com/workos/oagen/compare/v0.21.0...v0.21.1) (2026-06-01)


### Bug Fixes

* **renovate:** explicitly enable minor and patch updates ([#93](https://github.com/workos/oagen/issues/93)) ([888a3a0](https://github.com/workos/oagen/commit/888a3a04c4a9aa8923249bbb9c1fb8a09f1db002))
* writer idempotency, manifest churn, and parser rename cascading ([#95](https://github.com/workos/oagen/issues/95)) ([5f2d84f](https://github.com/workos/oagen/commit/5f2d84f1ff602b57755408a270da2ebdd14e4b12))

## [0.21.0](https://github.com/workos/oagen/compare/v0.20.0...v0.21.0) (2026-05-21)


### Features

* **parser:** detect discriminated unions through allOf-wrapped variants ([#91](https://github.com/workos/oagen/issues/91)) ([a0907b9](https://github.com/workos/oagen/commit/a0907b94f2ac79c93b2cff999a16256f781cb42f))


### Bug Fixes

* improve generate-smoke-test skill score (85% → 92%) ([#75](https://github.com/workos/oagen/issues/75)) ([08d5708](https://github.com/workos/oagen/commit/08d570800edd91409b20f1c9aa634f2df1d27e30))

## [0.20.0](https://github.com/workos/oagen/compare/v0.19.6...v0.20.0) (2026-05-20)


### Features

* **compat:** keep parent symbol_removed at breaking severity in detected renames ([#89](https://github.com/workos/oagen/issues/89)) ([5c42f96](https://github.com/workos/oagen/commit/5c42f963d525e062c816e607e60a1ae678cc4f12))

## [0.19.6](https://github.com/workos/oagen/compare/v0.19.5...v0.19.6) (2026-05-20)


### Bug Fixes

* **merger:** prune stale managed members during deep merge ([#87](https://github.com/workos/oagen/issues/87)) ([2ef3786](https://github.com/workos/oagen/commit/2ef378683295e4aecfc8c13c8cba340882e65fca))

## [0.19.5](https://github.com/workos/oagen/compare/v0.19.4...v0.19.5) (2026-05-20)


### Bug Fixes

* **writer:** dedupe Ruby `require` lines by path, not raw line ([#85](https://github.com/workos/oagen/issues/85)) ([72963c2](https://github.com/workos/oagen/commit/72963c2e77bcd30716ec94449e067c157dcedddc))

## [0.19.4](https://github.com/workos/oagen/compare/v0.19.3...v0.19.4) (2026-05-19)


### Bug Fixes

* **writer:** don't splice `import type {` as a Python simple import ([#83](https://github.com/workos/oagen/issues/83)) ([8f7e245](https://github.com/workos/oagen/commit/8f7e24557bc76027f1615fe51731669f6c465034))

## [0.19.3](https://github.com/workos/oagen/compare/v0.19.2...v0.19.3) (2026-05-19)


### Bug Fixes

* **writer:** splice hand-written TypeScript imports during overwrite ([#80](https://github.com/workos/oagen/issues/80)) ([0072235](https://github.com/workos/oagen/commit/0072235b3b44d3727a3b38150bcc186b39361089))

## [0.19.2](https://github.com/workos/oagen/compare/v0.19.1...v0.19.2) (2026-05-18)


### Bug Fixes

* **compat:** walk single-underscore Python module files ([#78](https://github.com/workos/oagen/issues/78)) ([347f2ad](https://github.com/workos/oagen/commit/347f2adfc61d6daae2ec5cf016d5d3ed6fc79bc1))

## [0.19.1](https://github.com/workos/oagen/compare/v0.19.0...v0.19.1) (2026-05-18)


### Bug Fixes

* **compat:** method-param reorder severity follows passing style ([#76](https://github.com/workos/oagen/issues/76)) ([6f7d4dc](https://github.com/workos/oagen/commit/6f7d4dcbfedac643e0dc33eb2a16b93a2f2e7148))

## [0.19.0](https://github.com/workos/oagen/compare/v0.18.2...v0.19.0) (2026-05-14)


### Features

* **config:** per-language emitterOptions; fix regen overwrite signal ([#73](https://github.com/workos/oagen/issues/73)) ([60ebffb](https://github.com/workos/oagen/commit/60ebffbacd01f021f8a15086d3c3cae56089010e))

## [0.18.2](https://github.com/workos/oagen/compare/v0.18.1...v0.18.2) (2026-05-13)


### Bug Fixes

* some slight alteration to pagination logic ([328c816](https://github.com/workos/oagen/commit/328c816fae24b5ef381657e83f372c49005d05d5))

## [0.18.1](https://github.com/workos/oagen/compare/v0.18.0...v0.18.1) (2026-05-06)


### Bug Fixes

* **parser,differ:** catch silent default & format regressions ([#68](https://github.com/workos/oagen/issues/68)) ([0ece2f0](https://github.com/workos/oagen/commit/0ece2f098ca3267879cd7c3743fb4bd8818138b6))

## [0.18.0](https://github.com/workos/oagen/compare/v0.17.3...v0.18.0) (2026-05-06)


### Features

* capture enum default value in IR ([#66](https://github.com/workos/oagen/issues/66)) ([67fdf02](https://github.com/workos/oagen/commit/67fdf02b4b7ecf7b753520691535fe189988b596))

## [0.17.3](https://github.com/workos/oagen/compare/v0.17.2...v0.17.3) (2026-05-06)


### Bug Fixes

* **writer:** repair on-disk filename casing on case-insensitive filesystems ([#63](https://github.com/workos/oagen/issues/63)) ([c6f93d4](https://github.com/workos/oagen/commit/c6f93d40162977af2d8a58d6540c1b0574f4f2dc))

## [0.17.2](https://github.com/workos/oagen/compare/v0.17.1...v0.17.2) (2026-05-05)


### Bug Fixes

* **merger:** bump tree-sitter-kotlin to v0.4.0 (GH) for multi-line constructors ([#61](https://github.com/workos/oagen/issues/61)) ([611888a](https://github.com/workos/oagen/commit/611888af1bc5463caf78a07f2d423686a28feca6))

## [0.17.1](https://github.com/workos/oagen/compare/v0.17.0...v0.17.1) (2026-05-05)


### Bug Fixes

* $ref-to-enum classification and overload-index leakage in derived names ([#59](https://github.com/workos/oagen/issues/59)) ([fd5ac29](https://github.com/workos/oagen/commit/fd5ac29879af2dcbf23352bc39c2bcf9354c9ba0))

## [0.17.0](https://github.com/workos/oagen/compare/v0.16.0...v0.17.0) (2026-05-05)


### Features

* **parser:** populate inline oneOf discriminator mapping and extract every variant ([#57](https://github.com/workos/oagen/issues/57)) ([2d01eb8](https://github.com/workos/oagen/commit/2d01eb853989e554c3af672f2cea885b1b261ccb))

## [0.16.0](https://github.com/workos/oagen/compare/v0.15.0...v0.16.0) (2026-05-03)


### Features

* **parser:** name oneOf variants from discriminator const values ([#55](https://github.com/workos/oagen/issues/55)) ([7191442](https://github.com/workos/oagen/commit/71914424c8166404157cccd15f09f1728fd8da12))

## [0.15.0](https://github.com/workos/oagen/compare/v0.14.1...v0.15.0) (2026-05-02)


### Features

* **compat:** emit field/enum_member info for PHP, Python, Ruby ([#53](https://github.com/workos/oagen/issues/53)) ([6a21ac1](https://github.com/workos/oagen/commit/6a21ac1d36ee85e235a00e3f14822b98cf381dc7))

## [0.14.1](https://github.com/workos/oagen/compare/v0.14.0...v0.14.1) (2026-05-02)


### Bug Fixes

* **compat:** rename-detection edge cases for real-world snapshots ([#51](https://github.com/workos/oagen/issues/51)) ([436de7e](https://github.com/workos/oagen/commit/436de7e56d7b431bc353a3ebddffa9ca29f6e1e3))

## [0.14.0](https://github.com/workos/oagen/compare/v0.13.0...v0.14.0) (2026-05-02)


### Features

* **compat:** detect type and enum renames as soft-risk, not breaking ([#49](https://github.com/workos/oagen/issues/49)) ([727021a](https://github.com/workos/oagen/commit/727021a8ab8e680f7e93f7ded3daf687adc61831))

## [0.13.0](https://github.com/workos/oagen/compare/v0.12.0...v0.13.0) (2026-04-30)


### Features

* transformSpec hook + forked-schema remediation hint ([#48](https://github.com/workos/oagen/issues/48)) ([1e101c3](https://github.com/workos/oagen/commit/1e101c3d706715bc55a1ab77216820529114c91b))


### Bug Fixes

* do not write to JSON files ([61fe7f4](https://github.com/workos/oagen/commit/61fe7f40c3f045ddb9d9714866b95518296a074e))

## [0.12.0](https://github.com/workos/oagen/compare/v0.11.0...v0.12.0) (2026-04-30)


### Features

* **ir:** add modelHints config for explicit model→service placement ([#45](https://github.com/workos/oagen/issues/45)) ([eef6aca](https://github.com/workos/oagen/commit/eef6aca74764e44e63c7b68cd730a4f9ef01c442))

## [0.11.0](https://github.com/workos/oagen/compare/v0.10.4...v0.11.0) (2026-04-27)


### Features

* **compat:** propagate sourceFile into CompatSnapshot ([#43](https://github.com/workos/oagen/issues/43)) ([6045e18](https://github.com/workos/oagen/commit/6045e1849257965d28b67ca5168188926a101d33))

## [0.10.4](https://github.com/workos/oagen/compare/v0.10.3...v0.10.4) (2026-04-27)


### Bug Fixes

* **compat:** stop filtering service class methods by manifest operations ([#41](https://github.com/workos/oagen/issues/41)) ([f7f7787](https://github.com/workos/oagen/commit/f7f7787548b11f3f208dd8cc387a96a021a96298))

## [0.10.3](https://github.com/workos/oagen/compare/v0.10.2...v0.10.3) (2026-04-26)


### Bug Fixes

* **compat:** filter service wrapper constructors from diff output ([#39](https://github.com/workos/oagen/issues/39)) ([a7da939](https://github.com/workos/oagen/commit/a7da93919b093bbd0bfe4a578c80de2d95665ef8))

## [0.10.2](https://github.com/workos/oagen/compare/v0.10.1...v0.10.2) (2026-04-25)


### Bug Fixes

* **compat:** exclude service class constructors from snapshots ([#37](https://github.com/workos/oagen/issues/37)) ([ee89bc6](https://github.com/workos/oagen/commit/ee89bc6e4c2f59e9dde259568631fb5509097e43))

## [0.10.1](https://github.com/workos/oagen/compare/v0.10.0...v0.10.1) (2026-04-25)


### Bug Fixes

* **compat:** pass schemaNameTransform to compat-extract spec parser ([#35](https://github.com/workos/oagen/issues/35)) ([7569926](https://github.com/workos/oagen/commit/7569926898ee8eff2529d05bc422c1649bc33539))

## [0.10.0](https://github.com/workos/oagen/compare/v0.9.2...v0.10.0) (2026-04-25)


### Features

* **compat:** use spec-level identity for cross-language change grouping ([#33](https://github.com/workos/oagen/issues/33)) ([9837c72](https://github.com/workos/oagen/commit/9837c72915e1ed00d76797eb5ad79a470c3a4ccf))

## [0.9.2](https://github.com/workos/oagen/compare/v0.9.1...v0.9.2) (2026-04-24)


### Bug Fixes

* **compat:** accept Python packages without root __init__.py ([#31](https://github.com/workos/oagen/issues/31)) ([e638f76](https://github.com/workos/oagen/commit/e638f76428ce544a1acfa8c6950cb47839b2af37))

## [0.9.1](https://github.com/workos/oagen/compare/v0.9.0...v0.9.1) (2026-04-24)


### Bug Fixes

* **compat:** filter hand-written symbols from baseline using manifest ([#29](https://github.com/workos/oagen/issues/29)) ([24381f6](https://github.com/workos/oagen/commit/24381f6fba9be2fb74a54cb3e391d7dc32b2d2fa))

## [0.9.0](https://github.com/workos/oagen/compare/v0.8.0...v0.9.0) (2026-04-24)


### Features

* compat pipeline, plugin bundles, and manifest consolidation ([#27](https://github.com/workos/oagen/issues/27)) ([8562e1d](https://github.com/workos/oagen/commit/8562e1dd035ec0aa8930923187a85b7fe962cf8d))

## [0.8.0](https://github.com/workos/oagen/compare/v0.7.0...v0.8.0) (2026-04-23)


### Features

* **compat:** add cross-language compatibility safeguards engine ([#25](https://github.com/workos/oagen/issues/25)) ([451f3eb](https://github.com/workos/oagen/commit/451f3ebcbca770b9ce322abb6c06717a191d370d))


### Bug Fixes

* add discriminated unions, parameter groups, and engine improvements ([#23](https://github.com/workos/oagen/issues/23)) ([bb3e9cf](https://github.com/workos/oagen/commit/bb3e9cfd5680ae79a2ce95aaa2f798178d52b034))

## [0.7.0](https://github.com/workos/oagen/compare/v0.6.0...v0.7.0) (2026-04-22)


### Features

* parameter groups, merger improvements, and extractor fixes ([#21](https://github.com/workos/oagen/issues/21)) ([68d28fd](https://github.com/workos/oagen/commit/68d28fd3ed27d97b463e5477dce2ee832d93d671))

## [0.6.0](https://github.com/workos/oagen/compare/v0.5.0...v0.6.0) (2026-04-14)


### Features

* engine, IR, and compat enhancements for dotnet + kotlin emitter support ([#19](https://github.com/workos/oagen/issues/19)) ([9240fb2](https://github.com/workos/oagen/commit/9240fb2d17a28a0a9717d942929ddbf1184efad1))

## [0.5.0](https://github.com/workos/oagen/compare/v0.4.0...v0.5.0) (2026-04-09)


### Features

* oagen updates to handle Golang ([#17](https://github.com/workos/oagen/issues/17)) ([babbf23](https://github.com/workos/oagen/commit/babbf23e59fc016885abb5aeb75676e5a825db57))

## [0.4.0](https://github.com/workos/oagen/compare/v0.3.0...v0.4.0) (2026-04-06)


### Features

* add SDK behavior and operation resolution support for PHP/Python generation ([#13](https://github.com/workos/oagen/issues/13)) ([5cf39d6](https://github.com/workos/oagen/commit/5cf39d6dd6337b1fc8faaf489da32645254e7693))

## [0.3.0](https://github.com/workos/oagen/compare/v0.2.0...v0.3.0) (2026-03-26)


### Features

* build modernization, tree-shaking, and emitter formatting ([#9](https://github.com/workos/oagen/issues/9)) ([6b8e442](https://github.com/workos/oagen/commit/6b8e442f297025c5764944312b313b7b56ddbee4))

## [0.2.0](https://github.com/workos/oagen/compare/v0.1.1...v0.2.0) (2026-03-25)


### Features

* generalize tree-sitter merging and improve overlay matching ([#6](https://github.com/workos/oagen/issues/6)) ([a65a225](https://github.com/workos/oagen/commit/a65a225a50bd977a34aa24abb84fc02bbf9bb4ae))

## [0.1.1](https://github.com/workos/oagen/compare/v0.1.0...v0.1.1) (2026-03-23)


### Bug Fixes

* deduplicate imports by identifier name, not just module path ([#3](https://github.com/workos/oagen/issues/3)) ([6f7d1c8](https://github.com/workos/oagen/commit/6f7d1c80ece31907ba2bbe226fd98ad11d55cf0f))
* move dotenv from devDependencies to dependencies ([#5](https://github.com/workos/oagen/issues/5)) ([cc4cf14](https://github.com/workos/oagen/commit/cc4cf142da1be91a9f600b6893d24261cdc6ed29))
* update workflow to use proper token ([ab516ad](https://github.com/workos/oagen/commit/ab516ad2fb051356df3d5a79b6d180b32d8349ce))

## [0.1.0](https://github.com/workos/oagen/compare/v0.0.1...v0.1.0) (2026-03-22)


### Features

* add 'staleness' violation category to compat types ([0100002](https://github.com/workos/oagen/commit/0100002328bd3f4efb5f404be02513480e1fb1b4))
* add [@oagen-ignore-file](https://github.com/oagen-ignore-file) and comprehensive documentation ([83db16b](https://github.com/workos/oagen/commit/83db16b6aa418b327bbdf2a2400b1a52f7109cf6))
* add @oagen-ignore-start/[@oagen-ignore-end](https://github.com/oagen-ignore-end) region markers ([47d175f](https://github.com/workos/oagen/commit/47d175f4803037bc4c06d90f31d8f0d560428a28))
* add /check-emitter-parity skill for IR coverage auditing ([2edc6a4](https://github.com/workos/oagen/commit/2edc6a490b041e373f928f20e4682a303c6696ef))
* add `oagen init` command for deterministic emitter project scaffolding ([19f9626](https://github.com/workos/oagen/commit/19f9626363afc9ee695c2aeb478d6b5cd1f14a70))
* add additive merge support for go and rust ([5164c64](https://github.com/workos/oagen/commit/5164c647963190b95f2bc3bd7665fbd87fe09a12))
* add additive merge support for php ([a9c1828](https://github.com/workos/oagen/commit/a9c1828d52bc089d8be8040c3b8aa9cdbcc7a917))
* add additive merge support for python ([5046def](https://github.com/workos/oagen/commit/5046defd41a6669a0aa2e0acfdeabcbfbba1d70c))
* add async flag to IR Operation and OperationPlan ([509e266](https://github.com/workos/oagen/commit/509e266a450b21497caeefc83031e88ae1ff66cc))
* add contractVersion validation and configurable operationId transform ([4df93f2](https://github.com/workos/oagen/commit/4df93f2711f4a2adc0833a616f3cfb353336d095))
* add PHP 8.1 enum extraction and configurable model base class ([c477e66](https://github.com/workos/oagen/commit/c477e6650675b8098c89c447744b96a8675284bb))
* add readOnly/writeOnly diffing to field comparisons ([15ec058](https://github.com/workos/oagen/commit/15ec0582daf96a7069536310c00902da4b37fb90))
* add sdk:generate/verify/extract npm scripts to emitter project scaffold ([c81a6f1](https://github.com/workos/oagen/commit/c81a6f1edb3e1037c897c0969f58f13fa705b9a6))
* add self-correcting overlay retry loop to verify command ([cf6e1d8](https://github.com/workos/oagen/commit/cf6e1d8be5a38609528ea36b1ba290011f411805))
* add staleness detection module with tests ([500a847](https://github.com/workos/oagen/commit/500a8473addc6a2f1f9ecd539febd8a6a39a1d3f))
* **cli:** add --namespace option and pass operationIdTransform through verify ([2acd8e4](https://github.com/workos/oagen/commit/2acd8e4bae2527410709e3fdc549ab96230f93fc))
* **cli:** add oagenScripts helper and update gitignore template ([4d246cc](https://github.com/workos/oagen/commit/4d246ccecbcd826ba5f522f3bd4ac749280a512f))
* **cli:** merge package.json and append gitignore in init command ([36e7992](https://github.com/workos/oagen/commit/36e7992e24391032636e194e6da77da89bbdad04))
* **cli:** update init command and remove deprecated lint-structure script ([4af43f7](https://github.com/workos/oagen/commit/4af43f7ceed2d19223e3566c5b315d7cf8509d42))
* **compat:** add .NET/C# API surface extractor ([2f0ebf4](https://github.com/workos/oagen/commit/2f0ebf4e1bc2b5f6321753081a2516f6bbe86267))
* **compat:** add Elixir API surface extractor ([fe11474](https://github.com/workos/oagen/commit/fe114741f1908466c2550fdd62bfed9334009193))
* **compat:** add Go type equivalence and PHP signature equivalence ([33a6fb5](https://github.com/workos/oagen/commit/33a6fb5b38e7670b76a17c5a1b880369dccc6533))
* **compat:** add Kotlin API surface extractor ([e8de0bd](https://github.com/workos/oagen/commit/e8de0bd968e86a8094dd6e44750182dcf125b0c1))
* **compat:** improve differ with field-structure, enum, and signature matching ([ebda61c](https://github.com/workos/oagen/commit/ebda61cade83f3756006b0859316291603b06f16))
* **compat:** improve overlay suffix matching and wire up spec filter exports ([c9c6687](https://github.com/workos/oagen/commit/c9c668713050ace6b54c4702b1badf759a5e9ee3))
* **config:** add docUrl option to expand relative links in descriptions ([40d4f18](https://github.com/workos/oagen/commit/40d4f18805914bbd666c750ecb66b19d03684e35))
* **core:** add tree-sitter utilities and update IR types for multi-language support ([7169009](https://github.com/workos/oagen/commit/7169009d3c0fb23ea06f92839246803b382fa2b3))
* deep merge JSON files instead of overwriting ([3ccc839](https://github.com/workos/oagen/commit/3ccc839ed90ce381e97e6096be5691e7098417e6))
* **engine:** add docstring refresh pass to AST merger ([d8be278](https://github.com/workos/oagen/commit/d8be278f2aad647d98f333b060a4880569ca5258))
* **engine:** add docstring-only merge mode for target integration ([4663c10](https://github.com/workos/oagen/commit/4663c100bac7338643eccaef6379572ea63e2eef))
* **engine:** add integrateTarget flag and deep AST merge for methods/fields ([7633788](https://github.com/workos/oagen/commit/7633788479d2d6eefcf7f07e9b7844080a531f41))
* **engine:** implement extractDocstrings for all 6 language adapters ([744cc1a](https://github.com/workos/oagen/commit/744cc1ae0b88a1e7182c6538221df017f42655f3))
* **examples:** add reference TypeScript emitter with GitHub-flavored fixture spec ([2aeff1e](https://github.com/workos/oagen/commit/2aeff1ed7aeac821a8b702aa31edca6d1438f1ba))
* **extractors:** add Go, PHP, Python, Ruby, and Rust language extractors ([c96c00d](https://github.com/workos/oagen/commit/c96c00d8eadee252d0ec645f728cbc3745684a7e))
* **ir:** extend HttpMethod, encoding, pagination, auth, map, and literal types ([eb9ea2e](https://github.com/workos/oagen/commit/eb9ea2eb1eb142c4bd31b2e2ad59cc777565083c))
* **parser:** add cookie params, form-urlencoded, new HTTP methods, spec-driven idempotency ([4dc22b3](https://github.com/workos/oagen/commit/4dc22b363a81293c54248bdfe925cdd7263b535a))
* **parser:** combine operation summary and description into docstring ([73d9021](https://github.com/workos/oagen/commit/73d90216e1fafb4c552d3db5d246534580091a1b))
* **parser:** generalize response classification and pagination detection ([8cf3901](https://github.com/workos/oagen/commit/8cf3901eb34cb16b76be6fb5ab4b0dbedf2cc136))
* **smoke:** add wave-based operation planning and improve IdRegistry ([71999a4](https://github.com/workos/oagen/commit/71999a4027e936a74d15d96c8d10cfc9fb40dbd1))
* split compat and verify APIs into explicit package subpaths ([b1ddb9d](https://github.com/workos/oagen/commit/b1ddb9dad817c766a73ed28e56ebf801f1e57b05))
* warn when method-level violations cannot be auto-patched ([d661062](https://github.com/workos/oagen/commit/d661062ccfaa2ba8b305d694a05ea47787ca8294))
* wire --old-spec flag into verify command for staleness detection ([4a9b50b](https://github.com/workos/oagen/commit/4a9b50bf3db883f63bdbdc9953eb80dffe650a5b))


### Bug Fixes

* add defaultIsNullableOnlyDifference helper and fix nodeHints bug ([39f8920](https://github.com/workos/oagen/commit/39f8920b29da413d7ebc0cf571827bd02e797f59))
* add uniqueness guard to overlay prefix/suffix matching and [@oagen-keep](https://github.com/oagen-keep) docstring preservation ([69b2f7a](https://github.com/workos/oagen/commit/69b2f7a266f17329d457c43925a4df0b823c8d88))
* better fake name ([d8a5c47](https://github.com/workos/oagen/commit/d8a5c479eb68afcf1db5af9845d88b73c833da09))
* clean up docs ([#2](https://github.com/workos/oagen/issues/2)) ([a28ea62](https://github.com/workos/oagen/commit/a28ea62ceb5372f506070749407c689e165c8169))
* **compat:** compare raw preservedSymbols instead of rounded percentage for stall detection ([d34cfb6](https://github.com/workos/oagen/commit/d34cfb6ad39cda38bcae4e54ca68d1c8afeccd4c))
* **compat:** default Python modelBaseClasses to [], add writer merge warning ([1cbf5b0](https://github.com/workos/oagen/commit/1cbf5b0a29ddf943a9d858f65bf92913c398dd0d))
* **compat:** extract resource classes and prefix-match method names ([42a2b64](https://github.com/workos/oagen/commit/42a2b64928272762383cb8caa7b43186ba6ded78))
* **compat:** resolve property type class instead of parent in overlay ([30ba56c](https://github.com/workos/oagen/commit/30ba56c99d6e774001443bdb636b60c2c0e49103))
* **compat:** use case-insensitive overlay matching with word-suffix fallback ([41776d5](https://github.com/workos/oagen/commit/41776d550c654e800e45eb39ad907b15a758850c))
* correct type errors in staleness test fixtures ([3b6798d](https://github.com/workos/oagen/commit/3b6798d2cf2e617987b2641cbc5f940632f730c0))
* deduplicate emitter pipeline and field extraction, fix incremental headerPlacement bug ([67df1ce](https://github.com/workos/oagen/commit/67df1ce1b8f58e120c5900934a9a02a0f3ad7424))
* deduplicate Python __all__ assignments during merge ([4a248e6](https://github.com/workos/oagen/commit/4a248e6475b61e49ee6706976d7dc5f0f23feb85))
* drop note ([439ecc1](https://github.com/workos/oagen/commit/439ecc1f93b7a014be7f57c3b2827195cdc123f2))
* **engine:** clear skipIfExists on target integration so merger runs ([952002c](https://github.com/workos/oagen/commit/952002c475de10db693994af833ef05fb6617d2e))
* **engine:** deduplicate imports by module path and skip orphaned imports ([89b8e15](https://github.com/workos/oagen/commit/89b8e151f23a82ce656f74b19b932b6f33b1551f))
* **engine:** ensure header on merged files, not just skipIfExists ([2795a0c](https://github.com/workos/oagen/commit/2795a0c8859006bfb63447a6aaa797d45b11a3ca))
* **engine:** prepend header to skipIfExists files when missing ([c62e36e](https://github.com/workos/oagen/commit/c62e36edec8652acd0c29177c25cd05bf7495a2f))
* exclude CHANGELOG from prettier and fix lint_pr_title visibility ([6d8745b](https://github.com/workos/oagen/commit/6d8745bd2129c5404fb1e974f3576aef32dd2cd1))
* harden merger for tree-sitter edge cases and smarter merge logic ([83dbb43](https://github.com/workos/oagen/commit/83dbb439752bd1b45f2a136edaae0ca998be85bd))
* include new generated imports instead of unconditionally dropping ([939e36d](https://github.com/workos/oagen/commit/939e36d6cb7eed262a4889b96d90947d7fb0a8b9))
* make check-emitter-parity skill language-agnostic ([8e7766e](https://github.com/workos/oagen/commit/8e7766edcd322e9d2ac0450e0b378b99c91eb339))
* make husky hook files executable ([5019e5b](https://github.com/workos/oagen/commit/5019e5b99703f28357142006adc0c2b146d6983f))
* prevent incorrect Json-suffix merges, unresolved refs, and pagination false positives ([4a2452b](https://github.com/workos/oagen/commit/4a2452badf8988369bea1e27e1003742b86977a1))
* remove docstring-only merge mode from merger implementation ([908fe3e](https://github.com/workos/oagen/commit/908fe3e0a93094830cd25c410622b8d563d93318))
* remove docstring-only merge mode so integration adds new methods to existing files ([78cd941](https://github.com/workos/oagen/commit/78cd94125a04844a2eee93bc813b711bcdc4924f))
* remove this function ([4f5d7b1](https://github.com/workos/oagen/commit/4f5d7b11273cf94a15cb5c510c0ea4d3cb9494f4))
* resolve sdkPath to absolute and use tsx for CLI entry ([99bfd96](https://github.com/workos/oagen/commit/99bfd9675cb68021a2272a91418f15c42060218a))
* update package-lock ([24c232f](https://github.com/workos/oagen/commit/24c232f1b5ed98dd79ce9b49764bdcc8061032b7))
* update project detection + gitignore ([62d45f9](https://github.com/workos/oagen/commit/62d45f97deaa44c3e04205d52bbffa1248ab2549))
* update verify-command test for method path filtering, add cookieParams ([e769f58](https://github.com/workos/oagen/commit/e769f58478e43645a3959e3aa3937ee59c628311))


### Performance Improvements

* precompute field-name sets for interface diff ([d481a99](https://github.com/workos/oagen/commit/d481a991371c9d1eb44ec4e69299479e67cefdc8))
* precompute module bodies in Elixir parser ([d327eb5](https://github.com/workos/oagen/commit/d327eb5bf1f07c94888388f130178c2e32c4cec7))
