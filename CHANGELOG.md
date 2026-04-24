# Changelog

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
* add PHP 8.1 enum extraction and BaseWorkOSResource model base class ([c477e66](https://github.com/workos/oagen/commit/c477e6650675b8098c89c447744b96a8675284bb))
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
