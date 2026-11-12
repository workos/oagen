# Changelog

## [0.35.0](https://github.com/workos/oagen/compare/v0.34.1...v0.35.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **parser:** settle a mapping pointer outside the union's variants to the model it points at ([#660](https://github.com/workos/oagen/issues/660))
* **differ:** report a validation keyword tightened or loosened on a field, parameter or header ([#659](https://github.com/workos/oagen/issues/659))
* **parser:** read a component's union beside an allOf that only annotates as the named union ([#658](https://github.com/workos/oagen/issues/658))
* **compat:** scope verify and staleness to the operations as generate resolves them ([#657](https://github.com/workos/oagen/issues/657))
* **parser:** read a discriminator's const through an allOf, a nullable wrapper or an alias chain ([#656](https://github.com/workos/oagen/issues/656))
* **parser:** name the models of two operationIds that clean to one stem apart, never shared ([#655](https://github.com/workos/oagen/issues/655))
* **parser:** read a nullable wrapper around an inline enum component as the enum, never an alias ([#654](https://github.com/workos/oagen/issues/654))
* **parser:** conjoin a $ref and an inline allOf, or two $refs, that declare one allOf property ([#653](https://github.com/workos/oagen/issues/653))
* **parser:** hash a webhook key and an operationId of one text apart, so neither payload is lost ([#652](https://github.com/workos/oagen/issues/652))
* **parser:** settle an explicit dataPath through a pointer site onto the model its items hold ([#651](https://github.com/workos/oagen/issues/651))
* **parser:** read each entry of a type list by its own keywords, never as the same model twice ([#650](https://github.com/workos/oagen/issues/650))
* **parser:** count a response body as received only under media types whose schema is read ([#649](https://github.com/workos/oagen/issues/649))
* **parser:** name a shared error body's inline enum from its field, never from an operation ([#648](https://github.com/workos/oagen/issues/648))
* **parser:** keep the live copy when one operation's success bodies differ only by deprecated ([#647](https://github.com/workos/oagen/issues/647))
* **parser:** read a bare $ref alias of an object component as a model carrying its fields ([#646](https://github.com/workos/oagen/issues/646))
* **parser:** a content or headers written beside a $ref contests no title, as it types nothing ([#645](https://github.com/workos/oagen/issues/645))
* **parser:** let a deprecated component, or one that deprecates a field, take no live error body ([#644](https://github.com/workos/oagen/issues/644))
* **parser:** read a list envelope whose stop field sits in a oneOf beside its allOf as a list ([#643](https://github.com/workos/oagen/issues/643))
* **parser:** type a request body written as a oneOf of string consts as the enum anyOf gives ([#642](https://github.com/workos/oagen/issues/642))
* **parser:** wrap a $ref to a nullable object component in nullable, as the same schema inline is ([#641](https://github.com/workos/oagen/issues/641))
* **parser:** compare limits at every level of a field's type before a component takes an error body ([#639](https://github.com/workos/oagen/issues/639))
* **parser:** read a list envelope whose data is a pointer to an array as the list it is ([#638](https://github.com/workos/oagen/issues/638))
* **parser:** spell a stepped discriminated variant's number behind No after a digit (PetV2No2) ([#636](https://github.com/workos/oagen/issues/636))
* **parser:** qualify a field named like its component as ReplyReply instead of Reply2 ([#635](https://github.com/workos/oagen/issues/635))
* **utils:** singularize a -ses or -xes word in a model name as a path segment is (causes → Cause) ([#632](https://github.com/workos/oagen/issues/632))
* **parser:** read an operation's callbacks into the IR as Callback entries, and diff them ([#626](https://github.com/workos/oagen/issues/626))
* **parser:** let a deprecated component admit no inline copy, so deprecating one is a flag flip ([#625](https://github.com/workos/oagen/issues/625))
* **differ:** compare the security scheme definitions under components.securitySchemes ([#624](https://github.com/workos/oagen/issues/624))
* **differ:** classify a moved success status code as breaking unless the old code is still declared ([#623](https://github.com/workos/oagen/issues/623))
* **parser:** name a shared error body from its required fields alone ([#598](https://github.com/workos/oagen/issues/598))
* **parser:** give an allOf combined with a oneOf/anyOf one reading at every site ([#597](https://github.com/workos/oagen/issues/597))
* **parser:** read the names a …Json fold renames per kind, a model's apart from an enum's ([#595](https://github.com/workos/oagen/issues/595))
* **parser:** skip a Content-Type response header in the sent-only component walk ([#594](https://github.com/workos/oagen/issues/594))
* **ir:** carry a schema's validation keywords on the type built from it ([#593](https://github.com/workos/oagen/issues/593))
* **parser:** follow a schema $ref deeper into a component as the JSON Pointer it is ([#592](https://github.com/workos/oagen/issues/592))
* **parser:** derive an inline union's discriminator mapping from its $ref variants' consts ([#590](https://github.com/workos/oagen/issues/590))
* **parser:** type a $ref to a const, multi-type or untyped component as the schema inline ([#589](https://github.com/workos/oagen/issues/589))
* **parser:** type a $ref to an alias of an enum component as the enum ([#588](https://github.com/workos/oagen/issues/588))
* **parser:** read an allOf of one typing member beside annotating members as that member ([#587](https://github.com/workos/oagen/issues/587))
* **parser:** read a nullable const union beside an enum list as the enum, not its one variant ([#586](https://github.com/workos/oagen/issues/586))
* **parser:** walk an explicit dataPath through the variants of a oneOf/anyOf ([#585](https://github.com/workos/oagen/issues/585))
* **cli:** pass compat-extract and verify the settings generate reads ([#584](https://github.com/workos/oagen/issues/584))
* **differ:** report a primary replaced among several 2xx responses as removed, not as a move ([#583](https://github.com/workos/oagen/issues/583))
* **differ:** compare a request body's required flag on a body carried in its contents alone ([#582](https://github.com/workos/oagen/issues/582))
* **parser:** name a later 2xx's secondary body for its status code, never the primary's ([#581](https://github.com/workos/oagen/issues/581))
* **parser:** qualify an operation's header and parameter models by its operationId stem ([#579](https://github.com/workos/oagen/issues/579))
* **parser:** number a parameter or header model stem as it is cased, behind `No` after a digit ([#578](https://github.com/workos/oagen/issues/578))
* **parser:** read a webhook operationId that names nothing as absent, as an operation's ([#577](https://github.com/workos/oagen/issues/577))
* **parser:** read an operationIdTransform result that names nothing as no operationId ([#576](https://github.com/workos/oagen/issues/576))
* **parser:** strip every trailing overload marker from an operationId ([#575](https://github.com/workos/oagen/issues/575))
* **parser:** ignore the content and headers beside a response $ref that resolves to nothing ([#574](https://github.com/workos/oagen/issues/574))
* **parser:** type a $ref to a primitive component as the primitive ([#558](https://github.com/workos/oagen/issues/558))
* **parser:** keep an operation's summary out of its description ([#557](https://github.com/workos/oagen/issues/557))
* **parser:** resolve a path item $ref to a paths or webhooks entry ([#554](https://github.com/workos/oagen/issues/554))
* **parser:** read a webhook whose name starts with x- ([#553](https://github.com/workos/oagen/issues/553))
* **parser:** map a wrapped variant beside an enum or array $ref ([#552](https://github.com/workos/oagen/issues/552))
* **parser:** keep an allOf-annotated enum $ref over a variant's enum ([#550](https://github.com/workos/oagen/issues/550))
* **parser:** iterate the items a component field's allOf model holds ([#549](https://github.com/workos/oagen/issues/549))
* **parser:** reject a stop field the flattened allOf model lacks ([#548](https://github.com/workos/oagen/issues/548))
* **parser:** read an operationId that names nothing as absent ([#547](https://github.com/workos/oagen/issues/547))
* **cli:** pass fieldHints to every command that parses a spec ([#546](https://github.com/workos/oagen/issues/546))
* **parser:** keep deprecated on a flattened discriminator's values ([#544](https://github.com/workos/oagen/issues/544))
* **parser:** ignore Accept, Content-Type and Authorization headers ([#542](https://github.com/workos/oagen/issues/542))
* **parser:** keep a field object of a component the SDK only sends off a looser component ([#524](https://github.com/workos/oagen/issues/524))
* **parser:** share one model between identical field and response copies leaving a name ([#523](https://github.com/workos/oagen/issues/523))
* **parser:** qualify a dropped inline twin rather than orphan its nested model ([#522](https://github.com/workos/oagen/issues/522))
* **parser:** fold only what a Json model reaches, off enum names, with its x-* keys ([#521](https://github.com/workos/oagen/issues/521))
* **parser:** set numbers and hashes in model and enum names off from a trailing digit ([#520](https://github.com/workos/oagen/issues/520))
* **parser:** share a stepped enum name only within the operation that stepped to it ([#519](https://github.com/workos/oagen/issues/519))
* **parser:** name a secondary media type's model from what `oagen diff` compares ([#517](https://github.com/workos/oagen/issues/517))
* **parser:** name a secondary 2xx or 3xx body for itself, not by the primary's shape ([#511](https://github.com/workos/oagen/issues/511))
* **parser:** step a component response's body past an operation's own inline body ([#510](https://github.com/workos/oagen/issues/510))
* **parser:** name a component response's headers and bodies before any operation's own ([#509](https://github.com/workos/oagen/issues/509))
* **parser:** step a parameter or header model past a nested enum in either order ([#504](https://github.com/workos/oagen/issues/504))
* **parser:** qualify a renamed inline model by its path, not the derived operation name ([#503](https://github.com/workos/oagen/issues/503))
* **parser:** contest a title between an inline allOf's $ref and inline members ([#498](https://github.com/workos/oagen/issues/498))
* **parser:** qualify a later variant that repeats a contested title ([#496](https://github.com/workos/oagen/issues/496))
* **parser:** contest a title only among unions the parser types ([#495](https://github.com/workos/oagen/issues/495))
* **parser:** step a union variant around names taken at any depth ([#494](https://github.com/workos/oagen/issues/494))
* **parser:** give a field an array component's limits and docs, a nullable oneOf one included ([#493](https://github.com/workos/oagen/issues/493))
* **parser:** keep a discriminated variant off its component's name ([#492](https://github.com/workos/oagen/issues/492))
* **parser:** map a wrapped named-union variant by the one model it wraps ([#490](https://github.com/workos/oagen/issues/490))
* **parser:** build a component field's array items from the oneOf or allOf beside their properties ([#489](https://github.com/workos/oagen/issues/489))
* **parser:** keep a variant's const or enum over a wider property written beside its oneOf ([#488](https://github.com/workos/oagen/issues/488))
* **parser:** keep a response whose one property is a union of tagged objects ([#487](https://github.com/workos/oagen/issues/487))
* **parser:** name an allOf response body for its operation, not a variant's const ([#485](https://github.com/workos/oagen/issues/485))
* **parser:** type variant declarations differing only in flags, limits or docs as one shape ([#484](https://github.com/workos/oagen/issues/484))
* **parser:** conjoin an object $ref and an inline object declaring one property ([#483](https://github.com/workos/oagen/issues/483))
* **parser:** combine an array's items across allOf members as a property's declarations ([#482](https://github.com/workos/oagen/issues/482))
* **parser:** give each operation reusing an operationId its own inline models ([#481](https://github.com/workos/oagen/issues/481))
* **parser:** name an action the same whatever else the document declares ([#480](https://github.com/workos/oagen/issues/480))
* **parser:** tell two singletons apart by the parent's plural rather than a number ([#479](https://github.com/workos/oagen/issues/479))
* **parser:** keep a nested collection's name when nothing tells it from the service path ([#478](https://github.com/workos/oagen/issues/478))
* **parser:** restore an item's service noun as written when the singular is taken ([#477](https://github.com/workos/oagen/issues/477))
* **parser:** keep a plural segment and its singular as two words of a qualifier ([#476](https://github.com/workos/oagen/issues/476))
* **parser:** name the service from the first tag that has a name ([#475](https://github.com/workos/oagen/issues/475))
* **parser:** read no requestBody from a +json media range ([#473](https://github.com/workos/oagen/issues/473))
* **parser:** read a null variant in any spelling ([#467](https://github.com/workos/oagen/issues/467))
* **parser:** unwrap a list envelope whose data array is an allOf of the array ([#466](https://github.com/workos/oagen/issues/466))
* **parser:** keep a secondary 2xx envelope that lacks the override's stop field ([#465](https://github.com/workos/oagen/issues/465))
* **parser:** read a stop field in any spelling ([#464](https://github.com/workos/oagen/issues/464))
* **parser:** split a path segment only at a custom method's colon ([#461](https://github.com/workos/oagen/issues/461))
* **differ:** report a move to or from an unread content map and keep JSON-to-JSON moves additive ([#460](https://github.com/workos/oagen/issues/460))
* **differ:** keep a variant added to an inline union additive ([#458](https://github.com/workos/oagen/issues/458))
* **differ:** report an operation gaining or losing its only 2xx/3xx when it has no body ([#456](https://github.com/workos/oagen/issues/456))
* **differ:** read a moved security default only from a node that inherits it in both documents ([#454](https://github.com/workos/oagen/issues/454))
* **differ:** compare a webhook's required flag only while both sides carry a payload ([#453](https://github.com/workos/oagen/issues/453))

### Features

* **differ:** compare the security scheme definitions under components.securitySchemes ([#624](https://github.com/workos/oagen/issues/624)) ([3f9f707](https://github.com/workos/oagen/commit/3f9f7076abacfb0455fbbc0c8aa7d9c1e7090c89))
* **differ:** report a validation keyword tightened or loosened on a field, parameter or header ([#659](https://github.com/workos/oagen/issues/659)) ([f53be48](https://github.com/workos/oagen/commit/f53be48a24e8e855b22d527660b62462cd612076))
* **ir:** carry a schema's validation keywords on the type built from it ([#593](https://github.com/workos/oagen/issues/593)) ([1d1c7f9](https://github.com/workos/oagen/commit/1d1c7f943ec3f11ebba3a07eb7de68385c7ed9b1))
* **ir:** let a consumer resolve method names from operationIds ([#472](https://github.com/workos/oagen/issues/472)) ([091b925](https://github.com/workos/oagen/commit/091b9257c14efcbc2e15bc27ce46d30d67abbb61))
* **parser:** read an operation's callbacks into the IR as Callback entries, and diff them ([#626](https://github.com/workos/oagen/issues/626)) ([0fa9e6d](https://github.com/workos/oagen/commit/0fa9e6d3507fd0ef598d3ed5ea549f1eb82fcb88))
* **parser:** record a composed component's bases and each inherited field's base in the IR ([#661](https://github.com/workos/oagen/issues/661)) ([5724384](https://github.com/workos/oagen/commit/5724384164e54d8bf09c8ba9bca3ff171c42c160))


### Bug Fixes

* **cli:** pass compat-extract and verify the settings generate reads ([#584](https://github.com/workos/oagen/issues/584)) ([f171a9f](https://github.com/workos/oagen/commit/f171a9f6de7c9aa9f70f413691482cbc52f5f025))
* **cli:** pass fieldHints to every command that parses a spec ([#546](https://github.com/workos/oagen/issues/546)) ([685fd39](https://github.com/workos/oagen/commit/685fd39063aa22db002e369bc8f9ed936be59711))
* **compat:** scope verify and staleness to the operations as generate resolves them ([#657](https://github.com/workos/oagen/issues/657)) ([948c895](https://github.com/workos/oagen/commit/948c895cde78f1d61fa2dd99119d9e5a2da89862))
* **differ:** classify a moved success status code as breaking unless the old code is still declared ([#623](https://github.com/workos/oagen/issues/623)) ([8500c98](https://github.com/workos/oagen/commit/8500c98e627b3286883f0b6f8513663d038c6fd4))
* **differ:** compare a request body's required flag on a body carried in its contents alone ([#582](https://github.com/workos/oagen/issues/582)) ([46034df](https://github.com/workos/oagen/commit/46034df5eb97b6c6e71183c32b1134334e717568))
* **differ:** compare a webhook's required flag only while both sides carry a payload ([#453](https://github.com/workos/oagen/issues/453)) ([4fdc070](https://github.com/workos/oagen/commit/4fdc0704881c903bf3610ddfcb4d15f8e7fedcd4))
* **differ:** keep a variant added to an inline union additive ([#458](https://github.com/workos/oagen/issues/458)) ([04fd615](https://github.com/workos/oagen/commit/04fd615ece95cd9c5632e48b6d624e788306b5ab))
* **differ:** read a moved security default only from a node that inherits it in both documents ([#454](https://github.com/workos/oagen/issues/454)) ([d5125dc](https://github.com/workos/oagen/commit/d5125dc40aa29342984b8e28042e4a783757476d))
* **differ:** report a body moved between two models both documents declare as retyped ([#455](https://github.com/workos/oagen/issues/455)) ([c2fab5c](https://github.com/workos/oagen/commit/c2fab5cc44eacd42b8c266aedfe953d8157f8290))
* **differ:** report a list envelope field added, removed or retyped ([#459](https://github.com/workos/oagen/issues/459)) ([5ecb2dd](https://github.com/workos/oagen/commit/5ecb2dd675c77230a218719eba10ebceb6d6f387))
* **differ:** report a move to or from an unread content map and keep JSON-to-JSON moves additive ([#460](https://github.com/workos/oagen/issues/460)) ([0252f8a](https://github.com/workos/oagen/commit/0252f8a90663fb18ce75bc8113f2c57733dd2923))
* **differ:** report a primary replaced among several 2xx responses as removed, not as a move ([#583](https://github.com/workos/oagen/issues/583)) ([97006d3](https://github.com/workos/oagen/commit/97006d31e15f7ebc63525b71253d7a16b12e486c))
* **differ:** report an operation gaining or losing its only 2xx/3xx when it has no body ([#456](https://github.com/workos/oagen/issues/456)) ([7e858d2](https://github.com/workos/oagen/commit/7e858d265d9e8b2b168306523f08d82f90cf9cef))
* **differ:** report no header or media type of a 2xx added to an operation that had none ([#457](https://github.com/workos/oagen/issues/457)) ([9228076](https://github.com/workos/oagen/commit/92280767ba9a42a7fdbd79aff890662f3a875ad1))
* **parser:** a content or headers written beside a $ref contests no title, as it types nothing ([#645](https://github.com/workos/oagen/issues/645)) ([0e8ac8d](https://github.com/workos/oagen/commit/0e8ac8d124d69597266553ee6230e91aa12bdf5f))
* **parser:** accept an x-pagination stop field every oneOf variant declares ([#463](https://github.com/workos/oagen/issues/463)) ([efc256d](https://github.com/workos/oagen/commit/efc256dfa30070cdecdb605de3416b4c52ba84e2))
* **parser:** build a component field's array items from the oneOf or allOf beside their properties ([#489](https://github.com/workos/oagen/issues/489)) ([2a3cb22](https://github.com/workos/oagen/commit/2a3cb226d5380f8d1c680a98ac717beacbbc0461))
* **parser:** combine an array's items across allOf members as a property's declarations ([#482](https://github.com/workos/oagen/issues/482)) ([9001210](https://github.com/workos/oagen/commit/90012109513960d9ea9d93c70b68507eccbaa453))
* **parser:** compare limits at every level of a field's type before a component takes an error body ([#639](https://github.com/workos/oagen/issues/639)) ([d055ef7](https://github.com/workos/oagen/commit/d055ef7e419ef41d1f119c1964d85c6aa8f9264e))
* **parser:** conjoin a $ref and an inline allOf, or two $refs, that declare one allOf property ([#653](https://github.com/workos/oagen/issues/653)) ([e7da9d8](https://github.com/workos/oagen/commit/e7da9d8d0569f2c4f51285e809cbd03f8d2d821f))
* **parser:** conjoin an object $ref and an inline object declaring one property ([#483](https://github.com/workos/oagen/issues/483)) ([01ee6d5](https://github.com/workos/oagen/commit/01ee6d5a7f06a310268593c9cb861cc20cbdbaae))
* **parser:** contest a title between an inline allOf's $ref and inline members ([#498](https://github.com/workos/oagen/issues/498)) ([abf7071](https://github.com/workos/oagen/commit/abf70715d872dd98fff618cbb1bc2ff4b81b8dbc))
* **parser:** contest a title only among unions the parser types ([#495](https://github.com/workos/oagen/issues/495)) ([7396835](https://github.com/workos/oagen/commit/7396835474ef11974370804da6bcd137d019478d))
* **parser:** count a response body as received only under media types whose schema is read ([#649](https://github.com/workos/oagen/issues/649)) ([f31caa5](https://github.com/workos/oagen/commit/f31caa53e1049832c9dfc6c40675352a1b5780e9))
* **parser:** decide every contested callback name of a round together, in identity order ([#628](https://github.com/workos/oagen/issues/628)) ([fe3c3d4](https://github.com/workos/oagen/commit/fe3c3d438b8e9a132737f3cd7a825dcb0892f916))
* **parser:** derive an inline union's discriminator mapping from its $ref variants' consts ([#590](https://github.com/workos/oagen/issues/590)) ([f952e3c](https://github.com/workos/oagen/commit/f952e3c98e59531c0ad4afa7f9c273ebf7773345))
* **parser:** document a wrapped inline enum and request body by the one wrapper rule ([#500](https://github.com/workos/oagen/issues/500)) ([a67bd1d](https://github.com/workos/oagen/commit/a67bd1d5044c2f0c0388225d8c164bcb01f46d70))
* **parser:** drop text beside an unresolved response $ref in OAS 3.0 ([#543](https://github.com/workos/oagen/issues/543)) ([f629056](https://github.com/workos/oagen/commit/f629056d9191788165a685a4b91d9d627d5772ac))
* **parser:** end the extraction at a merge it is already materializing ([#566](https://github.com/workos/oagen/issues/566)) ([#596](https://github.com/workos/oagen/issues/596)) ([0f2f8e1](https://github.com/workos/oagen/commit/0f2f8e1aa292498d32621b936eb60ed72c852ac8))
* **parser:** end the title walk at a conjunction it has already read ([#551](https://github.com/workos/oagen/issues/551)) ([4748709](https://github.com/workos/oagen/commit/4748709e01e9de2dbec01c68d2f536b1c0bd1f77))
* **parser:** fold only what a Json model reaches, off enum names, with its x-* keys ([#521](https://github.com/workos/oagen/issues/521)) ([3fc4635](https://github.com/workos/oagen/commit/3fc46350ba50d451a8209689ec18cfcf90b19b2b))
* **parser:** follow a schema $ref deeper into a component as the JSON Pointer it is ([#592](https://github.com/workos/oagen/issues/592)) ([695bfc5](https://github.com/workos/oagen/commit/695bfc5f246ad373d90741b2b99a1d2a6f558142))
* **parser:** give a field an array component's limits and docs, a nullable oneOf one included ([#493](https://github.com/workos/oagen/issues/493)) ([f9422aa](https://github.com/workos/oagen/commit/f9422aab5d9799a5b632cbd5d2a489e90a0df21c))
* **parser:** give an allOf combined with a oneOf/anyOf one reading at every site ([#597](https://github.com/workos/oagen/issues/597)) ([82b13d0](https://github.com/workos/oagen/commit/82b13d07d475abb4370bf13fc4ae8752c6ae4225))
* **parser:** give each operation reusing an operationId its own inline models ([#481](https://github.com/workos/oagen/issues/481)) ([6608e0d](https://github.com/workos/oagen/commit/6608e0d1d10817e553fd609196f7c2c558d44d22))
* **parser:** give each value of a flattened discriminator its own variant's text ([#499](https://github.com/workos/oagen/issues/499)) ([481afaf](https://github.com/workos/oagen/commit/481afafde8693cf7c51c2f940cfada1c1a5af77b))
* **parser:** hash a webhook key and an operationId of one text apart, so neither payload is lost ([#652](https://github.com/workos/oagen/issues/652)) ([f783779](https://github.com/workos/oagen/commit/f7837792136336fd5f369bc0b4bc65f37f811f52))
* **parser:** ignore Accept, Content-Type and Authorization headers ([#542](https://github.com/workos/oagen/issues/542)) ([c4b6823](https://github.com/workos/oagen/commit/c4b6823f9a12326ab2625c3458bac26c17f773c7))
* **parser:** ignore the content and headers beside a response $ref that resolves to nothing ([#574](https://github.com/workos/oagen/issues/574)) ([a696bd8](https://github.com/workos/oagen/commit/a696bd81d14f369f6106a19d9abc941e4d3ecb8d))
* **parser:** iterate the items a component field's allOf model holds ([#549](https://github.com/workos/oagen/issues/549)) ([249666a](https://github.com/workos/oagen/commit/249666a96cbc1f0277d73a37ae481f4ae5818feb))
* **parser:** keep a deprecated header schema's flag on the header ([#518](https://github.com/workos/oagen/issues/518)) ([296fcd9](https://github.com/workos/oagen/commit/296fcd94c6ad94e2fe344250e761db6f4106372b))
* **parser:** keep a discriminated variant off its component's name ([#492](https://github.com/workos/oagen/issues/492)) ([6540560](https://github.com/workos/oagen/commit/65405602bafd009380db6b00127d2d2a2cdb91a3))
* **parser:** keep a field object of a component the SDK only sends off a looser component ([#524](https://github.com/workos/oagen/issues/524)) ([52dd3bd](https://github.com/workos/oagen/commit/52dd3bdcba327d683f90e6475fff51daa7227a23))
* **parser:** keep a nested collection's name when nothing tells it from the service path ([#478](https://github.com/workos/oagen/issues/478)) ([90076bc](https://github.com/workos/oagen/commit/90076bc1e639799ce7942a83ef0211d63f02ff54))
* **parser:** keep a plural segment and its singular as two words of a qualifier ([#476](https://github.com/workos/oagen/issues/476)) ([4342346](https://github.com/workos/oagen/commit/43423468b0776a7f47f13027366c44e436048af2))
* **parser:** keep a response whose one property is a union of tagged objects ([#487](https://github.com/workos/oagen/issues/487)) ([87dccf9](https://github.com/workos/oagen/commit/87dccf9c531ce507ddcaf5b170f9f16a8d57adbf))
* **parser:** keep a secondary 2xx envelope that lacks the override's stop field ([#465](https://github.com/workos/oagen/issues/465)) ([365b31b](https://github.com/workos/oagen/commit/365b31bde7eafb752627ecb82f549168488d7b72))
* **parser:** keep a variant's const or enum over a wider property written beside its oneOf ([#488](https://github.com/workos/oagen/issues/488)) ([0221fbe](https://github.com/workos/oagen/commit/0221fbe0a343271f1e98579fa8381ba4e5197b0d))
* **parser:** keep an allOf-annotated enum $ref over a variant's enum ([#550](https://github.com/workos/oagen/issues/550)) ([fd38d16](https://github.com/workos/oagen/commit/fd38d16fd1a77ff9727975daa62fe00afd88670c))
* **parser:** keep an operation's summary out of its description ([#557](https://github.com/workos/oagen/issues/557)) ([c191327](https://github.com/workos/oagen/commit/c19132731c6f50f164a60f5a487917b8c246e251))
* **parser:** keep deprecated on a flattened discriminator's values ([#544](https://github.com/workos/oagen/issues/544)) ([abd2134](https://github.com/workos/oagen/commit/abd213442c20f241a4fa7fafeba9c8553277ae1f))
* **parser:** keep requestBodyRequired on a body carried in requestBodyContents alone ([#474](https://github.com/workos/oagen/issues/474)) ([6d8bcda](https://github.com/workos/oagen/commit/6d8bcda2d14cd99c3ef32e2330161fb06b9a6250))
* **parser:** keep the live copy when one operation's success bodies differ only by deprecated ([#647](https://github.com/workos/oagen/issues/647)) ([6e5d46a](https://github.com/workos/oagen/commit/6e5d46ae2438918e8d289f164b7973bb67080769))
* **parser:** keep the wrapper layer's description on a response body merged from an inline allOf ([#640](https://github.com/workos/oagen/issues/640)) ([ea8e8b7](https://github.com/workos/oagen/commit/ea8e8b70a9f9798d1b8af852354dbb21770f870f))
* **parser:** let a deprecated component admit no inline copy, so deprecating one is a flag flip ([#625](https://github.com/workos/oagen/issues/625)) ([dbc08a9](https://github.com/workos/oagen/commit/dbc08a9e11877151bb635f5c0256ed17708925cd))
* **parser:** let a deprecated component, or one that deprecates a field, take no live error body ([#644](https://github.com/workos/oagen/issues/644)) ([08d3078](https://github.com/workos/oagen/commit/08d3078b2c83d47b908529777449007e778834d4))
* **parser:** map a wrapped named-union variant by the one model it wraps ([#490](https://github.com/workos/oagen/issues/490)) ([09bc5bd](https://github.com/workos/oagen/commit/09bc5bd60641be12d31497197116193e5467e98b))
* **parser:** map a wrapped variant beside an enum or array $ref ([#552](https://github.com/workos/oagen/issues/552)) ([c344f40](https://github.com/workos/oagen/commit/c344f40f0d58aff4ad5dd43b1cd8b201072b49b0))
* **parser:** name a component response's headers and bodies before any operation's own ([#509](https://github.com/workos/oagen/issues/509)) ([1cfac21](https://github.com/workos/oagen/commit/1cfac2119de79b38c494487d837581c53a713c29))
* **parser:** name a later 2xx's secondary body for its status code, never the primary's ([#581](https://github.com/workos/oagen/issues/581)) ([22236ec](https://github.com/workos/oagen/commit/22236ecebbe653c8fdfd35c9785a112716e6498f))
* **parser:** name a secondary 2xx or 3xx body for itself, not by the primary's shape ([#511](https://github.com/workos/oagen/issues/511)) ([658ae06](https://github.com/workos/oagen/commit/658ae0603f871eb165dcb045e656e024f82bf071))
* **parser:** name a secondary media type's model from what `oagen diff` compares ([#517](https://github.com/workos/oagen/issues/517)) ([3b23424](https://github.com/workos/oagen/commit/3b234241ef7570161ee929a083fafe6210c46e70))
* **parser:** name a shared error body from its required fields alone ([#598](https://github.com/workos/oagen/issues/598)) ([080852c](https://github.com/workos/oagen/commit/080852cafe51c31c3f4cf36e689f399ec271a3b6))
* **parser:** name a shared error body's inline enum from its field, never from an operation ([#648](https://github.com/workos/oagen/issues/648)) ([6cfda41](https://github.com/workos/oagen/commit/6cfda41b8ef667f026b581c3db2bc3426dd90d82))
* **parser:** name an action the same whatever else the document declares ([#480](https://github.com/workos/oagen/issues/480)) ([5a5ac13](https://github.com/workos/oagen/commit/5a5ac1382c791b39e6b2ba96d6804f771ea9b715))
* **parser:** name an allOf response body for its operation, not a variant's const ([#485](https://github.com/workos/oagen/issues/485)) ([53f6b7b](https://github.com/workos/oagen/commit/53f6b7b48cc8c848a1d5a5e78107494f187c59d3))
* **parser:** name the models of two operationIds that clean to one stem apart, never shared ([#655](https://github.com/workos/oagen/issues/655)) ([7043154](https://github.com/workos/oagen/commit/7043154faa607d003c0e0f27ab99c382063676e2))
* **parser:** name the service from the first tag that has a name ([#475](https://github.com/workos/oagen/issues/475)) ([5526a05](https://github.com/workos/oagen/commit/5526a05484630d34a8726245d142281b76846681))
* **parser:** number a parameter or header model stem as it is cased, behind `No` after a digit ([#578](https://github.com/workos/oagen/issues/578)) ([fd74e94](https://github.com/workos/oagen/commit/fd74e944566dd34e7eecf6153c7ec2b6dbabdd6f))
* **parser:** qualify a dropped inline twin rather than orphan its nested model ([#522](https://github.com/workos/oagen/issues/522)) ([f040398](https://github.com/workos/oagen/commit/f040398f35eee5d13b2d282ead7607c5cf6f39e0))
* **parser:** qualify a field named like its component as ReplyReply instead of Reply2 ([#635](https://github.com/workos/oagen/issues/635)) ([2aa1d17](https://github.com/workos/oagen/commit/2aa1d17cf5cb8dc838befa433824acb955209fc1))
* **parser:** qualify a later variant that repeats a contested title ([#496](https://github.com/workos/oagen/issues/496)) ([f23434e](https://github.com/workos/oagen/commit/f23434e6aca93896181bd632ba6e40af0251acdd))
* **parser:** qualify a renamed inline model by its path, not the derived operation name ([#503](https://github.com/workos/oagen/issues/503)) ([332b118](https://github.com/workos/oagen/commit/332b118f7a1de18f315a784dc534b7e8ee5f7dce))
* **parser:** qualify an operation's header and parameter models by its operationId stem ([#579](https://github.com/workos/oagen/issues/579)) ([b9343b7](https://github.com/workos/oagen/commit/b9343b7dfbb56f93d8fdac2aea327f66218a1222))
* **parser:** read a bare $ref alias of an object component as a model carrying its fields ([#646](https://github.com/workos/oagen/issues/646)) ([9475c28](https://github.com/workos/oagen/commit/9475c2812745ca6f2cd13234a6e2512c69736100))
* **parser:** read a component's union beside an allOf that only annotates as the named union ([#658](https://github.com/workos/oagen/issues/658)) ([5dd50fa](https://github.com/workos/oagen/commit/5dd50fad78daf33884d19258ec6f57e54429b152))
* **parser:** read a discriminator's const through an allOf, a nullable wrapper or an alias chain ([#656](https://github.com/workos/oagen/issues/656)) ([ff13ab9](https://github.com/workos/oagen/commit/ff13ab9901025d50dc3f0922f5f75d4ae9f2fce1))
* **parser:** read a list envelope whose data is a pointer to an array as the list it is ([#638](https://github.com/workos/oagen/issues/638)) ([7ea9b2f](https://github.com/workos/oagen/commit/7ea9b2fcfa16e020b15ac88b83b51eb7e4523cd6))
* **parser:** read a list envelope whose stop field sits in a oneOf beside its allOf as a list ([#643](https://github.com/workos/oagen/issues/643)) ([d3d9ad5](https://github.com/workos/oagen/commit/d3d9ad58368b0f98140979aeca1e45d8b3868b1f))
* **parser:** read a null variant in any spelling ([#467](https://github.com/workos/oagen/issues/467)) ([171f4d9](https://github.com/workos/oagen/commit/171f4d99b79f7180a9b22f4345d8f99225de01ab))
* **parser:** read a nullable const union beside an enum list as the enum, not its one variant ([#586](https://github.com/workos/oagen/issues/586)) ([379ecfb](https://github.com/workos/oagen/commit/379ecfba4a18ba537880bdf905acf24ecf7c915a))
* **parser:** read a nullable wrapper around an inline enum component as the enum, never an alias ([#654](https://github.com/workos/oagen/issues/654)) ([5e78830](https://github.com/workos/oagen/commit/5e78830a26b7e7d31f64c9bf2b59c1f237777d22))
* **parser:** read a response header's externalDocs from an annotating allOf member ([#637](https://github.com/workos/oagen/issues/637)) ([4b979e6](https://github.com/workos/oagen/commit/4b979e69a89d3f6ef15c6c33ff81bd547df1e266))
* **parser:** read a stop field in any spelling ([#464](https://github.com/workos/oagen/issues/464)) ([4de4a9c](https://github.com/workos/oagen/commit/4de4a9c2d38ee9a7996baa62712cad679f939686))
* **parser:** read a webhook operationId that names nothing as absent, as an operation's ([#577](https://github.com/workos/oagen/issues/577)) ([0b369a1](https://github.com/workos/oagen/commit/0b369a1887a7eecef3f7420acfc9e429f6cd7c4d))
* **parser:** read a webhook whose name starts with x- ([#553](https://github.com/workos/oagen/issues/553)) ([227adce](https://github.com/workos/oagen/commit/227adce4a0e6dcc93a3383bf1d703c00b197a981))
* **parser:** read an allOf of one typing member beside annotating members as that member ([#587](https://github.com/workos/oagen/issues/587)) ([8426468](https://github.com/workos/oagen/commit/8426468579e90ecf98d7d2836a4f7a76aac1e432))
* **parser:** read an operationId that names nothing as absent ([#547](https://github.com/workos/oagen/issues/547)) ([b56d496](https://github.com/workos/oagen/commit/b56d496bd491003605404769e0c79b5c1551f6c4))
* **parser:** read an operationIdTransform result that names nothing as no operationId ([#576](https://github.com/workos/oagen/issues/576)) ([976890e](https://github.com/workos/oagen/commit/976890e7f32b18a401e0d55363150d7e854969f7))
* **parser:** read each entry of a type list by its own keywords, never as the same model twice ([#650](https://github.com/workos/oagen/issues/650)) ([bdc14b1](https://github.com/workos/oagen/commit/bdc14b1075841b9ed04dbe400736d86e1a220e41))
* **parser:** read no requestBody from a +json media range ([#473](https://github.com/workos/oagen/issues/473)) ([3eccb5e](https://github.com/workos/oagen/commit/3eccb5e91edebd421a296ec290e20b33e3251e38))
* **parser:** read the names a …Json fold renames per kind, a model's apart from an enum's ([#595](https://github.com/workos/oagen/issues/595)) ([e6a07e0](https://github.com/workos/oagen/commit/e6a07e0387448f2006e61c8005f14945c021910e))
* **parser:** read the stop field beside every object a nested dataPath passes through ([#462](https://github.com/workos/oagen/issues/462)) ([f2e9b4f](https://github.com/workos/oagen/commit/f2e9b4f09a83a494d6559329d346ec8250e7f8e6))
* **parser:** reject a stop field the flattened allOf model lacks ([#548](https://github.com/workos/oagen/issues/548)) ([04623c0](https://github.com/workos/oagen/commit/04623c07d60b7ae37bf37f3df2e9c4ede71fc892))
* **parser:** resolve a path item $ref to a paths or webhooks entry ([#554](https://github.com/workos/oagen/issues/554)) ([7fa6747](https://github.com/workos/oagen/commit/7fa6747a1a2498c4f19c5b9f8d8438123de97b32))
* **parser:** restore an item's service noun as written when the singular is taken ([#477](https://github.com/workos/oagen/issues/477)) ([0234bc1](https://github.com/workos/oagen/commit/0234bc18b2103de4d0fbd27343e4ffdc6e5514db))
* **parser:** set numbers and hashes in model and enum names off from a trailing digit ([#520](https://github.com/workos/oagen/issues/520)) ([8bf46a1](https://github.com/workos/oagen/commit/8bf46a1c8bab1cd6b554724e01ae84a593110c97))
* **parser:** settle a mapping pointer outside the union's variants to the model it points at ([#660](https://github.com/workos/oagen/issues/660)) ([c84a8b4](https://github.com/workos/oagen/commit/c84a8b47ae846485a92ccb1e6d4023ee191d0891))
* **parser:** settle an explicit dataPath through a pointer site onto the model its items hold ([#651](https://github.com/workos/oagen/issues/651)) ([099fca7](https://github.com/workos/oagen/commit/099fca76de87fba121946528f9ddb2da171f6e0e))
* **parser:** share a stepped enum name only within the operation that stepped to it ([#519](https://github.com/workos/oagen/issues/519)) ([985968f](https://github.com/workos/oagen/commit/985968fb480b7afe454eea956635e54c8438e315))
* **parser:** share one model between identical field and response copies leaving a name ([#523](https://github.com/workos/oagen/issues/523)) ([6c947ca](https://github.com/workos/oagen/commit/6c947cad19eee46b542257ae1c8b2d807d7402c6))
* **parser:** skip a Content-Type response header in the sent-only component walk ([#594](https://github.com/workos/oagen/issues/594)) ([a63ef89](https://github.com/workos/oagen/commit/a63ef896535dc069a10b9b12d6e7c3084c3e1112))
* **parser:** skip a response entry that is not an object with a warning instead of a TypeError ([#633](https://github.com/workos/oagen/issues/633)) ([deadc24](https://github.com/workos/oagen/commit/deadc247e6e5c42a1abc6918d3859f88e5c1533f))
* **parser:** spell a stepped discriminated variant's number behind No after a digit (PetV2No2) ([#636](https://github.com/workos/oagen/issues/636)) ([956cce9](https://github.com/workos/oagen/commit/956cce9c419b41b0b93942087324a95191da9c28))
* **parser:** split a path segment only at a custom method's colon ([#461](https://github.com/workos/oagen/issues/461)) ([8e7d939](https://github.com/workos/oagen/commit/8e7d9390982eebbdbf00ba3b0f6fc7f023f44cb9))
* **parser:** step a component response's body past an operation's own inline body ([#510](https://github.com/workos/oagen/issues/510)) ([5984eb8](https://github.com/workos/oagen/commit/5984eb8465bdf4a3a89dabc40279e59a260936db))
* **parser:** step a parameter or header model past a nested enum in either order ([#504](https://github.com/workos/oagen/issues/504)) ([a7efb54](https://github.com/workos/oagen/commit/a7efb54ab5909a400d4802bd9575de52d1a3cc10))
* **parser:** step a union variant around names taken at any depth ([#494](https://github.com/workos/oagen/issues/494)) ([e158d18](https://github.com/workos/oagen/commit/e158d189deba234d52d097878125ed30e91e0357))
* **parser:** strip every trailing overload marker from an operationId ([#575](https://github.com/workos/oagen/issues/575)) ([873b8df](https://github.com/workos/oagen/commit/873b8df96643d9c7bee29aff9d66468a16a23eb0))
* **parser:** tell two singletons apart by the parent's plural rather than a number ([#479](https://github.com/workos/oagen/issues/479)) ([fcb2f37](https://github.com/workos/oagen/commit/fcb2f37188d05947fba7a21de2a67a065a3a7b3c))
* **parser:** type a $ref to a const, multi-type or untyped component as the schema inline ([#589](https://github.com/workos/oagen/issues/589)) ([48fc9f6](https://github.com/workos/oagen/commit/48fc9f6edd6a4d4017468c4de2cb4fa743d6b5dd))
* **parser:** type a $ref to a primitive component as the primitive ([#558](https://github.com/workos/oagen/issues/558)) ([dd18d8e](https://github.com/workos/oagen/commit/dd18d8e91083462a208a17f1bb8c7e1e2b92ba55))
* **parser:** type a $ref to an alias of an enum component as the enum ([#588](https://github.com/workos/oagen/issues/588)) ([cb88c06](https://github.com/workos/oagen/commit/cb88c0632a999cad6ff7e408a9100976e3e118cf))
* **parser:** type a request body written as a oneOf of string consts as the enum anyOf gives ([#642](https://github.com/workos/oagen/issues/642)) ([6f6f1f5](https://github.com/workos/oagen/commit/6f6f1f59dc8a811b9cf1d882b53e6e54bbc7de2f))
* **parser:** type variant declarations differing only in flags, limits or docs as one shape ([#484](https://github.com/workos/oagen/issues/484)) ([d6438bd](https://github.com/workos/oagen/commit/d6438bdd106461d64686b721912ef1366038868d))
* **parser:** unwrap a list envelope whose data array is an allOf of the array ([#466](https://github.com/workos/oagen/issues/466)) ([4cca169](https://github.com/workos/oagen/commit/4cca169c5eeb75cfe07a9887dc5fdf828b4de660))
* **parser:** walk an explicit dataPath through the variants of a oneOf/anyOf ([#585](https://github.com/workos/oagen/issues/585)) ([8ba90dd](https://github.com/workos/oagen/commit/8ba90dd0134aac49e079525c00360458969d2e15))
* **parser:** warn on a response $ref that is not a string, as the webhook reader does ([#573](https://github.com/workos/oagen/issues/573)) ([2b6c95f](https://github.com/workos/oagen/commit/2b6c95f3433808ae9bf78a3de04eea743d47a9b5))
* **parser:** wrap a $ref to a nullable object component in nullable, as the same schema inline is ([#641](https://github.com/workos/oagen/issues/641)) ([ebd7095](https://github.com/workos/oagen/commit/ebd70950ab876f25f6af18df3fd5f513a09ae082))
* **utils:** singularize a -ses or -xes word in a model name as a path segment is (causes → Cause) ([#632](https://github.com/workos/oagen/issues/632)) ([5c3ff40](https://github.com/workos/oagen/commit/5c3ff40c2d2f213c30e7a6cc5dd276198d0e8b78))

## [0.34.1](https://github.com/workos/oagen/compare/v0.34.0...v0.34.1) (2026-10-30)


### Bug Fixes

* **parser:** name shared error bodies from their shape, never by number ([#513](https://github.com/workos/oagen/issues/513)) ([61b310f](https://github.com/workos/oagen/commit/61b310fbbf01cc31b67a576c50a1df2249cbcba5))

## [0.34.0](https://github.com/workos/oagen/compare/v0.33.0...v0.34.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **parser:** fold inline error bodies onto shared, shape-named models ([#497](https://github.com/workos/oagen/issues/497))
* **differ:** make a server variable default that resolves to the same URL additive ([#452](https://github.com/workos/oagen/issues/452))

### Bug Fixes

* **differ:** make a server variable default that resolves to the same URL additive ([#452](https://github.com/workos/oagen/issues/452)) ([697fb65](https://github.com/workos/oagen/commit/697fb65d5deab388d8ebaeb5b040890c3cdbbc0f))
* **parser:** fold inline error bodies onto shared, shape-named models ([#497](https://github.com/workos/oagen/issues/497)) ([9fd1a5f](https://github.com/workos/oagen/commit/9fd1a5f67d8b2777c6b2a3dbfc3d967922870677))

## [0.33.0](https://github.com/workos/oagen/compare/v0.32.1...v0.33.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **differ:** make a host moved in front of a listed `/` breaking ([#451](https://github.com/workos/oagen/issues/451))

### Bug Fixes

* **compat:** reserve exact-name model matches before Jaccard inference ([#486](https://github.com/workos/oagen/issues/486)) ([76c0311](https://github.com/workos/oagen/commit/76c0311cd7f77297f8c51e8bfd19177ffc1c0244))
* **differ:** make a host moved in front of a listed `/` breaking ([#451](https://github.com/workos/oagen/issues/451)) ([2e14498](https://github.com/workos/oagen/commit/2e14498c8688f7366823b93439b6260087716e40))
* **smoke:** say so when an operation declares no responses ([#448](https://github.com/workos/oagen/issues/448)) ([2bf3758](https://github.com/workos/oagen/commit/2bf3758dede382039b061226320e027e30290a44))

## [0.32.1](https://github.com/workos/oagen/compare/v0.32.0...v0.32.1) (2026-10-26)


### Bug Fixes

* **parser:** name a kept list envelope for its operation, not `List` ([#419](https://github.com/workos/oagen/issues/419)) ([0d1b818](https://github.com/workos/oagen/commit/0d1b8186314772d0dcc7a45e7953b2d9786bf7a9))

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
