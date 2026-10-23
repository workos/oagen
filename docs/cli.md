# CLI Reference

All commands support `--help` for full usage details.

## `oagen generate`

Generate SDK code from an OpenAPI spec.

```bash
oagen generate --spec openapi.yml --lang node --output ./sdk --namespace Acme
```

| Argument               | Required | Default                 | Description                                                                                                                                                                                              |
| ---------------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <path>`        | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file.                                                                                                                                                                        |
| `--lang <language>`    | Yes      |                         | Target language — must have a registered emitter (via `oagen.config.ts`)                                                                                                                                 |
| `--output <dir>`       | Yes      |                         | Directory to write generated files into                                                                                                                                                                  |
| `--namespace <name>`   | No       | Spec's `info.title`     | SDK namespace in PascalCase — used directly for code identifiers (e.g., `Acme::Client`) and converted to `snake_case` for file paths (e.g., `lib/acme/`). Use PascalCase with the exact casing you want. |
| `--dry-run`            | No       | `false`                 | Print the list of file paths that would be generated, without writing anything to disk                                                                                                                   |
| `--api-surface <path>` | No       |                         | Path to baseline API surface JSON for compat overlay                                                                                                                                                     |
| `--target <dir>`       | No       |                         | Target directory for live SDK integration — generated files are merged into this directory instead of `--output`                                                                                         |
| `--no-compat-check`    | No       | `false`                 | Skip compat overlay even if `--api-surface` is provided                                                                                                                                                  |

## `oagen diff`

Compare two OpenAPI specs and output a diff report as JSON. Use this to review what changed before regenerating.

An `operation-modified` change carries `serversChanged` (breaking) when the servers the operation is actually served from — its own `servers`, else the document's — changed: the two lists are matched on URL template and variables, ignoring descriptions, enum order and position, except that a reorder that moves the first entry's resolved URL counts. URLs are compared in their RFC 3986 form (see **Servers** below), so a host that only changed case is no change. An operation that inherits the document's servers on both sides is not reported here even when the document's own list moved. OpenAPI's default server is one list however it is spelled: an operation that writes `servers: [{ url: '/' }]` out under a document that declares no servers (or `servers: []`) is served from the same place as one that inherits, so neither gaining nor losing that entry is reported.

```bash
oagen diff --old v1.yml --new v2.yml
```

| Argument       | Required | Description                   |
| -------------- | -------- | ----------------------------- |
| `--old <path>` | Yes      | Path to the old/previous spec |
| `--new <path>` | Yes      | Path to the new/current spec  |

**Exit codes:** 0 = no changes, 1 = additive or modified changes, 2 = breaking changes.

### Change kinds

Every entry in `changes` carries a `kind` and a `classification` (`additive` or `breaking`). A `-modified` change also lists what changed inside it and is breaking when any of those is.

| `kind`               | Classification                                                                                                                             | Fields                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base-url-changed`   | breaking; additive when the old spec's default address was `''` or `/`                                                                     | `oldBaseUrl`, `newBaseUrl` (as written; `''` for no server; `/` when the first server resolves to `/`, which means the same)                                   |
| `server-added`       | additive                                                                                                                                   | `url` (the template as written in the new spec)                                                                                                                |
| `server-removed`     | breaking                                                                                                                                   | `url` (the template as written in the old spec)                                                                                                                |
| `server-modified`    | from `variableChanges`                                                                                                                     | `url` (the template as written in the new spec), `variableChanges[]`                                                                                           |
| `security-changed`   | breaking when a caller built for the old default — or a webhook handler, when a webhook inherits it — no longer passes; additive otherwise | `oldSecurity`, `newSecurity` (`[]` for none)                                                                                                                   |
| `model-added`        | additive                                                                                                                                   | `name`                                                                                                                                                         |
| `model-removed`      | breaking                                                                                                                                   | `name`                                                                                                                                                         |
| `model-modified`     | from `fieldChanges`                                                                                                                        | `name`, `fieldChanges[]`                                                                                                                                       |
| `enum-added`         | additive                                                                                                                                   | `name`                                                                                                                                                         |
| `enum-removed`       | breaking                                                                                                                                   | `name`                                                                                                                                                         |
| `enum-modified`      | from `valueChanges`                                                                                                                        | `name`, `valueChanges[]`                                                                                                                                       |
| `service-added`      | additive                                                                                                                                   | `name`                                                                                                                                                         |
| `service-removed`    | breaking                                                                                                                                   | `name`                                                                                                                                                         |
| `operation-added`    | additive                                                                                                                                   | `serviceName`, `operationName`                                                                                                                                 |
| `operation-removed`  | breaking                                                                                                                                   | `serviceName`, `operationName`                                                                                                                                 |
| `operation-modified` | from `paramChanges` and the `…Changed` flags                                                                                               | `serviceName`, `operationName`, `paramChanges[]`, `responseChanged`, `requestBodyChanged`, `pathChanged`, … (see `OperationModified` in `src/differ/types.ts`) |

**Servers.** `baseUrl` is `servers[0]` with its variables' defaults filled in, so `base-url-changed` is reported once whenever that resolved host differs: alongside whichever server change moved it, and on its own when the list was only reordered. Servers are matched on their `url` template, independent of position, so a changed template is a `server-removed` plus a `server-added`. A template declared more than once is matched as a multiset: its old and new entries pair up by the strongest signal available, each pass taking the first unmatched candidate in declaration order — identical variables first (so a reordered list, or one whose duplicates are unchanged, reports nothing), then the same variable defaults, then the same resolved URL, then position — and the surplus on either side is a `server-added` or a `server-removed`. Within a matched server, `variableChanges` lists each variable by name; descriptions are not compared. A document with no `servers`, one with `servers: []`, and one whose only server is `/` — description and variables aside, since `/` references no variable — all have OpenAPI's default server — a single server at `/` — and are compared as declaring no server: nothing is reported between any two of them (a variable declared on `/` included), and moving from any of them to a named host is an additive `base-url-changed` plus a `server-added`, with no `server-removed` for `/`. A document whose list means the default is matched as `[{ url: '/' }]`, and the `/` it is only implied to have is never reported as added or removed: `/` gaining a named host beside it is one `server-added`, losing that host is one `server-removed`, and moving from any spelling of the default to a named host is an additive `base-url-changed` plus a `server-added`. Beside a named host, `/` is a server a caller can pick, so it is added and removed like any other. The default address is compared with `''` and `/` read as one, so a first server that merely resolves to `/` (`{root}` with default `/`) has not moved from the default, while a `baseUrl` that names a host with no `servers` beside it (an IR built by hand; the parser never produces that shape) is compared as written, so a host change there is still a `base-url-changed`. `/` with a variable is the default too, since `/` references no variable and the variable cannot change where it points; beside a named host it comes and goes like any listed `/`. A variable the `url` template never references — no `{name}` placeholder for it in the template — cannot reach any resolved URL, so every change to it is additive, whatever its kind: removing it, changing its default or narrowing its values takes nothing away from any caller. For the four kinds that are breaking on a referenced variable — `variable-removed`, `variable-default-changed`, `variable-enum-added` and `variable-enum-value-removed` — the entry's `details` then ends with `{name} is not in the URL template, so no resolved URL moves` (after `; ` when the kind already carries text); `variable-added`, `variable-enum-removed` and `variable-enum-value-added` are additive for any variable and are reported exactly as the table shows. The "breaking" rows below apply to a variable the template references.

Every URL in that comparison — `baseUrl`, each `url` template and each resolved URL — is read in its RFC 3986 form (`normalizeServerUrl`, exported from the package): the scheme and the host are case-insensitive, a port that is empty or the scheme's default (`80` for `http` and `ws`, `443` for `https` and `wss`) is the same as none, a wholly literal authority with no path is the same as one followed by `/`, and in a percent-encoded octet the hex digits' case does not count and one that encodes an unreserved character (a letter, a digit, `-`, `.`, `_`, `~`) is the same as that character. So `https://PETS.example.com`, `HTTPS://pets.example.com:443/` and `https://pets.example.com` are one server, and a document that moves between them reports nothing. The path, query and fragment are case-sensitive and compared as written otherwise (`/v1` and `/V1`, or `/v1` and `/v1/`, are two servers). A `{name}` placeholder is kept as written, so `{Region}` and `{region}` are two templates and a template is never the URL it resolves to. A placeholder's value may carry any delimiter — a `@` that makes the text before it a username, a `:` and a port, a `/` and a path, a `://` and a whole URL — so nothing from the first placeholder on is folded, and a part is folded only when it is complete before that point: the scheme when its `:` comes first, the authority when its end (`/`, `?`, `#` or the end of the template) comes first. `HTTPS://API.example.com/{version}` is `https://api.example.com/{version}` and `HTTPS://API.example.com{basePath}` is `https://API.example.com{basePath}`, while `https://api.example.com{basePath}` and `https://api.example.com{basePath}/` (`/v1` and `/v1/` with `basePath` defaulting to `/v1`), `https://{host}:443/v2` and `https://{host}/v2`, `https://USER{suffix}/v1` and `https://user{suffix}/v1`, or `{prefix}://api.example.com` and `{prefix}://api.example.com/` stay two servers. From the first placeholder up to the next `/`, `?` or `#` not even percent-encoding is folded, since a value may put that text in a scheme or a port, where `%` has no meaning (`{scheme}%73://notes.example.com` and `{scheme}s://notes.example.com` stay two servers); from that delimiter on, percent-encoding folds again. Every folding thus applies to text whose part no variable value can change, so two templates read as one resolve to one URL under every value of their variables. Not folded at all: dot-segments (`/v1/../v2` is compared as written) and internationalised host names (`https://bücher.example.com` and `https://xn--bcher-kva.example.com` are two servers). Variable names, defaults and enum values are compared as written. Every `url`, `oldBaseUrl` and `newBaseUrl` a change carries is the spelling of the spec that declares it.

| `variableChanges[].kind`      | Classification                                           | Meaning                                                      |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `variable-added`              | additive                                                 | A client can now pick it                                     |
| `variable-removed`            | breaking; additive when the template never references it | A client can no longer pick it                               |
| `variable-default-changed`    | breaking; additive when the template never references it | The server's resolved URL moves (`oldDefault`, `newDefault`) |
| `variable-enum-added`         | breaking; additive when the template never references it | Any value was accepted; now only the listed ones are         |
| `variable-enum-removed`       | additive                                                 | The restriction is lifted                                    |
| `variable-enum-value-added`   | additive                                                 | `value` can now be picked                                    |
| `variable-enum-value-removed` | breaking; additive when the template never references it | `value` can no longer be picked                              |

**Deprecation.** A node becoming deprecated, or no longer being deprecated, is reported and is additive in either direction (nothing a caller compiles against changes): `deprecatedChanged: true` on an `operation-modified`, `model-modified`, `enum-modified` or `webhook-modified` change, with `oldDeprecated`/`newDeprecated` beside it, and a `param-deprecated-changed`, `header-deprecated-changed`, `field-deprecated-changed` or `value-deprecated-changed` entry — carrying the same two values and `details` reading `live → deprecated` or `deprecated → live` — in that change's `paramChanges` (an operation's or a webhook's), `responseHeaderChanges` (an operation's response headers, see Response headers below), `fieldChanges` or `valueChanges`. A change whose only content is the flag is still reported (so the command exits 1), and a breaking change on the same node keeps the change breaking. Only `true` counts as deprecated: `false` and an absent key are the same thing. Each flip is also mirrored into `behaviorChanges` as a `deprecated-changed` entry naming the node (`operation`, `parameter`, `response-header`, `model`, `field`, `enum`, `enum-value`, `webhook` or `webhook-parameter`) and copying `oldDeprecated`/`newDeprecated` from the change, beside the `param-default-changed` entries that were already collected there; a `response-header` entry also carries the header's `statusCode` or `fallback` when its change does.

**Security.** What a request must carry is compared on the document and on every operation and webhook. `ApiSpec.security` — the default every operation and webhook that declares none of its own inherits — differing between the two documents is one `security-changed` change, with `oldSecurity`/`newSecurity` beside it (`[]` when a document declares none; `security: []` and an undeclared list both mean no authentication). An operation or webhook that declares its own list on either side is compared on what it actually requires — its own list, else that document's — and reported with `securityChanged: true` on its `operation-modified` or `webhook-modified` change, with `oldSecurity`/`newSecurity` beside it; one that inherits on both sides is not reported again for a moved default. Lists are compared as sets of alternatives, each a set of schemes with scopes as sets, so order and repetition are not changes. The classification is read from the node's side of the wire. For an operation, a caller built for the old list must still satisfy the new one: breaking when some old alternative satisfies no new one (a scheme or scope now required, an alternative removed, an anonymous alternative withdrawn), additive otherwise (an alternative added, a scheme or scope no longer needed, authentication made optional). For a webhook, a handler built for the old list must still find what it checked for in whatever the sender now presents: breaking when some new alternative carries no old one (a credential the sender stops presenting, an alternative it may now use that the old list never offered), additive otherwise (a credential the sender starts carrying beside the old ones, an alternative withdrawn). The document-level change is read from each side that inherits the default — the caller's when an operation in either document declares no `security` of its own, the receiver's when a webhook does — and is breaking if any such side breaks; when nothing inherits it, no request reads the default, so the change is additive. A change whose only content is security is still reported, and a breaking change on the same node keeps the change breaking. Every security change is mirrored into `behaviorChanges` as a `security-changed` entry naming the node (`document`, `operation` or `webhook`), copying the two lists and carrying the security change's own classification, which stays additive when the owning change is breaking for another reason.

**Tags.** Operations are matched by name within a service, and the parser groups an operation into a service by `tags[0]` — the first usable entry, non-empty strings only, repeats folded (then the path-prefix split, see [Service naming](architecture/ir-types.md#service--operation)), so a `tags` edit is reported by where the operation ends up. When it stays in a service of the same name — any edit that leaves the first entry alone, a first tag respelled to the same service name (`pets` → `Pets`), or a first tag changed to one the split files back under the same path-named service — it is `tagsChanged: true` on the `operation-modified` change, with `oldTags`/`newTags` beside it (`[]` for none; the lists are compared in document order, so a reorder after the first entry counts). When the first entry moves it to a service of another name, there is no `operation-modified` to carry a flag: the diff reports the move, `operation-removed` from the old service (breaking) and `operation-added` to the new one (additive), or `service-removed` (breaking) and `service-added` (additive) when a service goes or comes with it — so swapping `['Pets', 'Store']` to `['Store', 'Pets']` on a document's only operation exits 2. A webhook belongs to no service, so every edit to its `tags` is `tagsChanged` on its `webhook-modified` change. `tagsChanged` is always additive: tags group and document a method and change nothing a caller compiles against. A change whose only content is such a tags edit is still reported (so the command exits 1), and tags are not mirrored into `behaviorChanges`.

**Parameters.** An operation's parameters are compared in every location it carries them — path, query, header and cookie — and a webhook's in header, query and cookie, through one walk, so a change is reported wherever the parameter lives. Parameters are matched by location and name (`parameterKey` in `src/ir/parameter-key.ts`, the identity the parser merges path-item and operation parameters on) — OpenAPI allows a path `id` beside a query `id` on one operation — and every `paramChanges` entry carries `paramLocation` (`path`, `query`, `header` or `cookie` on an operation; `header`, `query` or `cookie` on a webhook) to say which one it is about. A header's name is matched case-insensitively, since HTTP header names are (RFC 9110 §5.1): a header written `X-Pet-Token` in one spec and `x-pet-token` in the other is one parameter, its type, requiredness, default and `deprecated` compared as usual, and the spelling change is a `param-name-changed` entry — additive, with `oldName`/`newName` and `details` reading `name X-Pet-Token → x-pet-token` — beside whatever else changed, not a `param-removed` beside a `param-added`. The inline enum or model a header's schema mints is named from the lower-cased header name on both sides (`PetsXRatelimitPolicy` for `X-RateLimit-Policy` and `x-ratelimit-policy` alike; the same for a response header's), so a case change leaves the header's type, and the `enums` and `models` lists, where they were: no `param-type-changed`, no `enum-removed`, no `model-removed`. On the entries of a paired parameter, `paramName` is the name as the new spec writes it; a `param-removed` entry carries the old spec's name, which the new spec no longer has, and a `param-added` entry the new spec's. Path, query and cookie names are case-sensitive, so `Limit` and `limit` are two query parameters. A `param-name-changed` entry is not mirrored into `behaviorChanges`. A query parameter the request body owns (`Operation.bodyOwnedQueryParams`: declared as a body property too, on a body-carrying method) is not compared as a parameter — it travels in the body, whose model the differ compares field by field — so a query parameter the body takes over is reported as `param-removed` at `query`.

**Request body encoding.** `requestBodyEncoding` — the wire format a body is serialized as, read from the media type it is declared under: `json`, `form-data`, `form-urlencoded`, `binary` or `text` — differing between the two specs while both declare a body is reported as `requestBodyEncodingChanged: true` on the `operation-modified` change, with `oldRequestBodyEncoding`/`newRequestBodyEncoding` beside it. An SDK built for the old spec keeps serializing the body and labelling the request as that spec said, so the change is breaking when the new spec no longer accepts that representation — the media type the old body was read from is gone from its `requestBodyContentTypes`, or the body under it changed shape, compared as `retyped` is (`application/json` where the server now reads only `application/x-www-form-urlencoded`) — and additive when it still does, as when a media type the parser prefers is added beside it (`application/json` added beside a kept `application/x-www-form-urlencoded`: the parser now reads the body from JSON, existing callers keep sending the form body, and the server still reads it). A kept media type whose inline schema the parser names differently on the two sides (`CreatePetRequest` while it is the body `requestBody` is read from, `CreatePetApplicationXWwwFormUrlencodedRequest` once JSON is preferred) is still the same representation: the two models are compared field by field through the two specs' models, as `retyped` is, not by name. A body without media-type lists reads as breaking. A body appearing or disappearing takes its encoding with it and is `requestBodyChanged` alone; a body that changes type and encoding at once sets `requestBodyChanged` and `requestBodyEncodingChanged`. The encoding flag is reported beside the request body media-type comparison (below): a body moving from `application/json` to `application/x-www-form-urlencoded` sets `requestBodyEncodingChanged` and `requestBodyContentTypesChanged` both (the JSON media type is removed, the form one added), while a media type changing essence within one encoding (`application/json` → `application/vnd.api+json`) sets `requestBodyContentTypesChanged` alone. On a `webhook-modified` change the same comparison — made only while both specs declare a payload, as on an operation; a payload appearing or disappearing is `payload added` / `payload removed` alone and carries neither field — sets `requestBodyChanged` with `details` saying `encoding json → form-urlencoded` and the same two fields beside it, breaking from the receiver's side when the representation the sender now uses — the media type the new payload is read from, with its shape — is not one the old spec declared with that shape (the handler decodes a wire format it never saw), additive when it is (a media type dropped beside one the handler already decoded). A change whose only content is the encoding is still reported (the command exits 2 when it is breaking, 1 when it is additive), and the encoding is not mirrored into `behaviorChanges`.

**Response media types.** An `operation-modified` change lists, per response entry both specs declare, the media types the new spec `added` (additive), `removed` (breaking) or `retyped` (breaking) under `responseContentTypeChanges`, keyed by `statusCode` or, for the `default` and range responses, by `fallback`. Media types are matched by essence — `type/subtype`, case folded, parameters stripped — the rule the parser types a body by, so `Text/HTML` is `text/html` and `application/problem+json; charset=utf-8` is `application/problem+json`: a key that only changed case, whitespace or `charset` is no change, and reordering the keys is none either. A pair whose parameters other than `charset` differ (`application/pdf; version=1.7` → `; version=2.0`, a `profile` on `application/ld+json`) is listed under `reparameterized` with both spellings, additive: the body is typed the same, but the parameter may select another representation, so the change stays visible without being called breaking. Parameters are read as RFC 9110 writes them — a `;` inside a quoted value does not end the parameter, backslash escapes are decoded, the quotes are not part of the value — and compared as name/value pairs with names case-folded, in any order (never as one joined string, so `title="report; version=2"` and `title=report; version=2` are different parameters). Each media type is reported as written in the spec that declares it. Two keys of one essence declared side by side (`application/json` beside `application/json; charset=utf-8`) stay two media types: each pairs, in this order of preference, with the key spelled the same way on the other side, else one of its essence with the same parameters other than `charset` (so `Application/YAML; version=1` is still `application/yaml; version=1` wherever it moved), else one of its essence whose body is the same shape (so a key that only edited a parameter finds its body), else the other side's next unpaired key of its essence in document order; one left over is added or removed. A model the parser mints for a secondary media type is named from the essence too (`GetReportApplicationYamlResponse` for `application/yaml` and for `application/yaml; charset=utf-8` alike), so a key that only respells itself keeps its model name and is not reported as retyped. `retyped` means the body's shape changed: two bodies that are both models are compared field by field through the two specs' models (nested models and enums included, documentation aside), not by name. So when a key declared beside another spelling of its essence edits a parameter (`application/yaml; version=1` → `application/yaml; version=3`), which renames the model the parser mints for it, the body is reported as `reparameterized` (additive) and not as `retyped`; the rename surfaces as `model-removed` + `model-added`, which is what the generated SDK actually loses and gains. A schema change under such a key is still `retyped`. The same holds for a secondary body on an error, `default` or range response.

**Request body media types.** The media types a request body may be sent as — the `content` keys of the Request Body Object, carried as `requestBodyContentTypes` / `requestBodyContents` — are compared the same way, while both specs declare a body (a body appearing or disappearing is `requestBodyChanged` alone). On an `operation-modified` change, `requestBodyContentTypesChanged: true` comes with `requestBodyContentTypeChange` listing the media types `added` (additive: callers can newly send it), `removed` (breaking: a representation callers could send is gone) and `retyped` (breaking; only ever a secondary media type, since the body `requestBody` is read from is `requestBodyChanged`'s). As for responses, `retyped` is decided by shape, not by name: a `<Op><MediaType>Request` model that a parameter edit on a sibling-distinguished key only renamed is not a retype and surfaces as `model-removed` + `model-added`, and a changed parameter other than `charset` is `reparameterized`, additive, on an operation and on a webhook alike (`details` reads `payload media type text/csv; version=1 → text/csv; version=2`). On a `webhook-modified` change the same comparison is read from the receiver's side and sets `requestBodyChanged` with `details` such as `payload media type text/csv added`, beside a `requestBodyContentTypeChange` with the lists: a media type the sender can newly use, or whose body changed shape, is breaking (the handler must decode it); one it can no longer use is additive.

**Response headers.** An `operation-modified` change lists, per response entry both specs declare, the headers the new spec added, removed, retyped, re-required, respelled or deprecated under `responseHeaderChanges`, each entry carrying `headerName` as written in the spec that declares it (the new spec's spelling for a header both declare) and the response entry it belongs to: `statusCode` for an entry with an explicit status code — the primary success response when the operation declares more than one 2xx/3xx response, every other 2xx/3xx entry and every error — `fallback` for the `default` and range responses, and `Operation.responseStatusCode` as `statusCode` for a lone 2xx (neither only for a hand-built IR whose lone 2xx carries no code). A change is located at the entry of the spec that declares what changed: `header-removed` at the old spec's entry, every other kind at the new spec's — so an operation that lost its only 2xx (a lone `200` that became a lone `404`), whose new primary carries no code, reports that entry's headers removed under `200`; a `responseContentTypeChanges` entry that only removes, when the new spec's entry carries no code, is located at the old spec's entry the same way. Entries pair up between the two specs as they do for `responseContentTypeChanges` (see Success status below), and headers within an entry by name case-insensitively, as HTTP compares header names (RFC 9110 §5.1): `X-Rate-Limit` and `x-rate-limit` are one header, so a case-only rename is one additive `header-name-changed` entry with `oldName`/`newName` beside it rather than a removal beside an addition; two names of one folding declared side by side stay two headers, paired by exact spelling first. The SDK reads these headers off the response and never sends them, so each kind is classified from the reader's side, as a webhook's parameters are: `header-added` is additive, required or not (the server simply starts sending it); `header-removed` is breaking (an accessor the SDK exposed is gone); `header-type-changed` is breaking and `header-format-changed` additive, with the two formats in `details`, as for a parameter; `header-required-changed` is additive for optional → required (the header is now always sent) and breaking for required → optional, `details` saying which; `header-deprecated-changed` is additive either way, with `oldDeprecated`/`newDeprecated` and `details` beside it, and is mirrored into `behaviorChanges` as a `deprecated-changed` entry with `node: 'response-header'` (see Deprecation above). A 2xx the old spec declared and the new does not has no other flag to report its headers, so each is `header-removed`; an error or fallback response only one spec declares is `errorsChanged` or `fallbackResponsesChanged` alone, and a 2xx the new spec adds is no header change. A change whose only content is a header is still reported (the command exits 1 or 2 by its classification). A webhook's accepted responses carry no headers in the IR, so a `webhook-modified` change has no such list.

**Success status.** Response entries pair up between the two specs by status code — every 2xx/3xx entry, the primary among them (a lone 2xx by `Operation.responseStatusCode`, the code the parser read `response` from), and every error — so a lone `201` pairs with the other spec's `201` whether that spec declares it alone or beside a `200` it added, and the added `200` is no header or media-type change. When neither primary has a counterpart by code and both carry one, the primary moved (a lone `201` became a lone `200`): the two primaries pair and the move is reported once, as `responseStatusCodeChanged: true` on the `operation-modified` change with `oldResponseStatusCode`/`newResponseStatusCode` beside it, rather than every header and media type as removed under one code and added under the other. `responseStatusCodeChanged` is set whenever both specs carry a code and the two differ — a `201` that became the primary beside a `200` whose body lost its schema included — and is additive on its own: the old code may still be declared (the `200` added beside a lone `201` is that case), and whether a bare status move breaks callers is left to a separate issue — the flag says the move happened so a changelog can. An operation gaining or losing its only 2xx/3xx is not a move. It is not mirrored into `behaviorChanges`. Only a hand-built IR whose lone 2xx carries no code falls back to pairing it with the entry of the other spec that offers its media types, else with that spec's primary.

## `oagen extract`

Extract the public API surface from an existing SDK. Produces a JSON file used as input for compat overlay and verification.

```bash
oagen extract --sdk-path ./existing-sdk --lang ruby --output ./sdk/sdk-ruby-surface.json
oagen extract --sdk-path ./existing-sdk --lang ruby --output my-surface.json
```

| Argument            | Required | Default                   | Description                                                                                                     |
| ------------------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--sdk-path <path>` | Yes      |                           | Path to the live SDK                                                                                            |
| `--lang <language>` | Yes      |                           | Target language                                                                                                 |
| `--output <path>`   | No       | `sdk-{lang}-surface.json` | Output file path (recommend writing to your output dir, e.g. `./sdk/sdk-ruby-surface.json`, and gitignoring it) |

## `oagen compat-extract`

Extract a compat snapshot from a live SDK and write it to a JSON file. The snapshot is a machine-readable record of the SDK's public API surface, used as input to `compat-diff`.

```bash
oagen compat-extract --sdk-path ./existing-sdk --lang node --output .
oagen compat-extract --sdk-path ./existing-sdk --lang php --output ./sdk --spec openapi.yml
```

| Argument            | Required | Default                 | Description                                                                        |
| ------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `--sdk-path <path>` | Yes      |                         | Path to the live SDK                                                               |
| `--lang <language>` | Yes      |                         | Target language                                                                    |
| `--output <dir>`    | Yes      |                         | Directory to write `.oagen-compat-snapshot.json` into                              |
| `--spec <path>`     | No       | `OPENAPI_SPEC_PATH` env | Path to OpenAPI spec — enriches symbols with `operationId`, `route`, and `specSha` |

Always writes `.oagen-compat-snapshot.json` in the specified directory. The snapshot file is meant to be committed to the repository and updated on each release.

When `--spec` is provided, the command parses the spec and enriches callable symbols with `operationId` and `route` (HTTP method + path) by matching against spec operations. It also computes a SHA-256 of the spec file and stores it as `source.specSha` in the snapshot.

## `oagen compat-diff`

Diff two compat snapshot files and produce a classified change report. No extraction or spec required — pure file-in, report-out.

```bash
# Basic diff with terminal output
oagen compat-diff --baseline .oagen-compat-snapshot.json --candidate /tmp/candidate.json

# With machine-readable report and failure threshold
oagen compat-diff \
  --baseline .oagen-compat-snapshot.json \
  --candidate /tmp/candidate.json \
  --output compat-report.json \
  --fail-on breaking
```

| Argument             | Required | Default    | Description                                        |
| -------------------- | -------- | ---------- | -------------------------------------------------- |
| `--baseline <path>`  | Yes      |            | Path to the baseline compat snapshot JSON          |
| `--candidate <path>` | Yes      |            | Path to the candidate compat snapshot JSON         |
| `--output <path>`    | No       |            | Write machine-readable JSON report to this path    |
| `--fail-on <level>`  | No       | `breaking` | Fail threshold: `none`, `breaking`, or `soft-risk` |
| `--explain`          | No       | `false`    | Include provenance explanations in terminal output |

**Exit codes:** 0 = no changes exceed threshold, 1 = changes exceed threshold.

## `oagen compat-summary`

Format a compat report as a markdown PR comment. Reads the JSON report produced by `compat-diff --output` and outputs markdown to stdout or a file.

```bash
# Single language
oagen compat-summary --report compat-report.json | gh pr comment --body-file -

# Cross-language rollup (multiple reports)
oagen compat-summary --report php.json --report python.json --report go.json

# Write to a file
oagen compat-summary --report compat-report.json --output summary.md
```

| Argument             | Required | Default | Description                                                                |
| -------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `--report <path...>` | Yes      |         | Path(s) to compat report JSON(s) — pass multiple for cross-language rollup |
| `--output <path>`    | No       | stdout  | Write markdown to this file instead of stdout                              |

**Single report** output includes:

- Status header (pass/warning/fail)
- Summary table with breaking, soft-risk, and additive counts
- Breaking changes table (always visible)
- Soft-risk and additive changes in collapsible `<details>` sections

**Multiple reports** produce a cross-language rollup:

- Per-language summary table (breaking/soft-risk/additive per language)
- Conceptual changes table showing per-language severity for each change
- Same conceptual change across languages is shown as one row, not N separate rows

## `oagen verify`

Verify an already-generated SDK — run smoke tests and optional compat checks. Use after `oagen generate`.

```bash
oagen verify --lang node --output ./sdk --spec openapi.yml

# With compat check
oagen verify --lang node --output ./sdk --spec openapi.yml \
  --api-surface ./sdk/sdk-node-surface.json
```

| Argument                | Required | Default                         | Description                                                                                                   |
| ----------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--lang <language>`     | Yes      |                                 | Target language                                                                                               |
| `--output <dir>`        | Yes      |                                 | Path to the generated SDK                                                                                     |
| `--spec <path>`         | No       | `OPENAPI_SPEC_PATH` env         | Path to an OpenAPI 3.x spec file                                                                              |
| `--api-surface <path>`  | No       |                                 | Baseline API surface JSON — enables compat verification                                                       |
| `--raw-results <path>`  | No       | auto-generated                  | Path to an existing smoke baseline file to diff against                                                       |
| `--smoke-config <path>` | No       |                                 | Smoke config JSON for skip lists and service mappings                                                         |
| `--smoke-runner <path>` | No       |                                 | Custom smoke runner script (overrides built-in `sdk-test.ts`)                                                 |
| `--scope <mode>`        | No       | `spec-only` when `--spec` given | Compat scope: `full` compares all baseline symbols, `spec-only` only compares symbols derivable from the spec |
| `--diagnostics`         | No       | `false`                         | Output `verify-diagnostics.json` with structured violation breakdown                                          |
| `--max-retries <n>`     | No       | `3`                             | Max retry iterations for self-correcting overlay loop (set to 0 for single-pass)                              |

**Exit codes:**

| Code | Meaning                                                                 | Details                     |
| ---- | ----------------------------------------------------------------------- | --------------------------- |
| 0    | Clean — all checks passed                                               |                             |
| 1    | Findings — CRITICAL smoke mismatches, compat violations, or missing ops | `smoke-diff-findings.json`  |
| 2    | Compile error — SDK failed type check                                   | `smoke-compile-errors.json` |

## `oagen init`

Scaffold a new emitter project with all boilerplate files and a compilable stub emitter.

```bash
oagen init --lang ruby
oagen init --lang go --project ./my-emitter
```

| Argument            | Required | Default | Description                          |
| ------------------- | -------- | ------- | ------------------------------------ |
| `--lang <language>` | Yes      |         | Target language (e.g., `ruby`, `go`) |
| `--project <dir>`   | No       | `.`     | Directory to create the project in   |

Creates:

- `package.json` with `@workos/oagen` dependency and `sdk:generate`/`sdk:verify`/`sdk:extract` scripts
- `tsconfig.json`, `vitest.config.ts`, `tsup.config.ts` — build/test tooling
- `oagen.config.ts` — minimal config for local development, imports the plugin bundle
- `src/plugin.ts` — plugin bundle export registering the stub emitter
- `src/{language}/index.ts` — stub emitter implementing the full `Emitter` interface
- `src/index.ts` — barrel export including the plugin bundle
- Empty directories: `test/`, `smoke/`, `docs/sdk-architecture/`

After initialization, `npm run typecheck` passes immediately. Implement your emitter methods in `src/{language}/` to start generating SDK code.

## `oagen parse`

Parse an OpenAPI spec and output the IR as JSON to stdout. Useful for inspecting what the parser extracts.

```bash
oagen parse --spec openapi.yml
```

| Argument        | Required | Default                 | Description                                      |
| --------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>` | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |

## `oagen resolve`

Resolve operation names from the spec using the algorithm and optional hints. Outputs a review table (markdown) or JSON for programmatic use.

```bash
# Markdown review table (default)
oagen resolve --spec openapi.yml

# JSON output for CI/scripting
oagen resolve --spec openapi.yml --format json
```

| Argument            | Required | Default                 | Description                                      |
| ------------------- | -------- | ----------------------- | ------------------------------------------------ |
| `--spec <path>`     | No       | `OPENAPI_SPEC_PATH` env | Path to an OpenAPI 3.x spec file (YAML or JSON). |
| `--format <format>` | No       | `table`                 | Output format: `table` (markdown) or `json`.     |

When `oagen.config.ts` defines `operationHints` and/or `mountRules`, they are applied automatically. The table format flags operations that have no hint and are resolved purely by algorithm.

## `--config <path>`

All commands accept a global `--config <path>` option to load a specific config file instead of the default cwd-based discovery.

```bash
# Explicit config
oagen generate --config ../openapi-spec/oagen.config.ts --spec openapi.yml --lang node --output ./sdk

# Default: searches for oagen.config.ts in the current directory
oagen generate --spec openapi.yml --lang node --output ./sdk
```

When `--config` is omitted, the CLI searches the current working directory for `oagen.config.ts`, `oagen.config.js`, or `oagen.config.mjs` in that order.

## Configuration (`oagen.config.ts`)

Place an `oagen.config.ts` (or `.js`/`.mjs`) in the project that drives generation. The CLI loads this file at startup before any command runs.

The config file belongs to the **consumer project** (the project that owns spec interpretation policy), not the emitter library. Emitter packages export plugin bundles that the consumer config composes.

### Consumer config (recommended)

```ts
import type { OagenConfig } from "@workos/oagen";
import { acmeEmittersPlugin } from "@acme/oagen-emitters";

const config: OagenConfig = {
  ...acmeEmittersPlugin,
  docUrl: "https://docs.example.com",
  operationIdTransform: (id) => id.replace(/Controller_/, ""),
  operationHints,
  mountRules,
};

export default config;
```

### Standalone emitter config

For standalone emitter projects that also serve as the consumer:

```ts
import type { OagenConfig } from "@workos/oagen";
import { nodeEmitter } from "./src/node/index.js";

const config: OagenConfig = {
  emitters: [nodeEmitter],
};

export default config;
```

### Composing multiple plugin bundles

```ts
import type { OagenConfig } from "@workos/oagen";
import { acmeEmittersPlugin } from "@acme/oagen-emitters";
import { experimentalPlugin } from "@workos/oagen-experimental";

const config: OagenConfig = {
  emitters: [
    ...(acmeEmittersPlugin.emitters ?? []),
    ...(experimentalPlugin.emitters ?? []),
  ],
  extractors: [
    ...(acmeEmittersPlugin.extractors ?? []),
    ...(experimentalPlugin.extractors ?? []),
  ],
  smokeRunners: {
    ...(acmeEmittersPlugin.smokeRunners ?? {}),
    ...(experimentalPlugin.smokeRunners ?? {}),
  },
  operationHints,
  mountRules,
};

export default config;
```

### Options

| Key                    | Type                                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitters`             | `Emitter[]`                                       | Language emitters to register. Each emitter implements the `Emitter` interface and generates SDK files for one target language.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `extractors`           | `Extractor[]`                                     | API surface extractors to register. Each extractor parses a live SDK and produces an `ApiSurface` JSON used for compat verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `emitterProject`       | `string`                                          | Path to the emitter project directory. Used by skills to scaffold new emitters, tests, and smoke runners in the correct location.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `smokeRunners`         | `Record<string, string>`                          | Map from language key to custom smoke runner script path. Overrides the built-in `sdk-test.ts` for `oagen verify`. Can also be set per-invocation with `--smoke-runner`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `operationIdTransform` | `(id: string) => string`                          | Custom transform for operation IDs. Receives the raw `operationId` from the spec; return the desired operation name. No additional casing conversion is applied. When omitted, `operationId` values are converted to `camelCase`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `schemaNameTransform`  | `(name: string, originalName?: string) => string` | Custom transform for schema (model/enum) names. Applied after the built-in `cleanSchemaName` normalization. Receives the cleaned PascalCase name (`name`) and, for component schemas, the original name exactly as spelled in the document (`originalName`); return the desired name. Return `originalName` to opt a schema out of normalization, but only when its spelling is already a valid identifier: a bare `originalName ?? name` would also keep keys like `user-profile` or `Foo.Bar` that `cleanSchemaName` would otherwise have fixed. For example `(name, originalName) => (originalName && /^[A-Za-z_$][\w$]*$/.test(originalName) ? originalName : name)` keeps `HTTPConfig`, `URL`, and `Settings` instead of `HttpConfig`, `Url`, and `Setting`. `originalName` is `undefined` for any name oagen synthesises (inline enums, request-body variant models, title-derived names), so fall back to `name` for those. Collisions are detected automatically: if a transform would produce a duplicate name, the cleaned name is kept. |
| `transformSpec`        | `(spec: OpenApiDocument) => OpenApiDocument`      | Pre-IR overlay applied to the bundled OpenAPI document before any IR extraction. Use to patch around upstream spec quirks that would otherwise emit a breaking SDK change. See [`transformSpec` — Pre-IR Spec Overlay](advanced/transform-spec.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docUrl`               | `string`                                          | Base URL for documentation links. When set, relative markdown paths in descriptions (e.g. `[User](/reference/users/user)`) are expanded to full URLs (e.g. `[User](https://docs.example.com/reference/users/user)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `operationHints`       | `Record<string, OperationHint>`                   | Per-operation overrides keyed by `"METHOD /path"`. Override derived method names, remount to a different service, split union-body operations into typed wrappers, or state an operation's pagination explicitly (`pagination`, the same object as the spec's `x-pagination` extension; it wins over the extension and over detection). See [Operation Resolution](architecture/ir-types.md#operation-resolution).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mountRules`           | `Record<string, string>`                          | Service-level remounting. Maps IR service name to target service/namespace (PascalCase). Keys may be exact names or trailing-`*` prefix patterns (e.g. `"UserManagement*"`); an exact key wins over any wildcard, and among wildcards the longest prefix wins. All operations in the source service are mounted on the target unless overridden per-operation in `operationHints`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `modelHints`           | `Record<string, string>`                          | Pin specific models to a specific IR service for placement. Maps IR model name (post-`cleanSchemaName`/`schemaNameTransform`) → IR service name (PascalCase). Overrides the default "first service to reference the model wins" assignment. Both names must exist in the parsed spec; unknown names throw at generation time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
