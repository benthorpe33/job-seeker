# Changelog

## 1.0.0 (2026-09-23)


### Features

* adapt contacto mode by contact type (recruiter/HM/peer/interviewer) ([a665299](https://github.com/benthorpe33/job-seeker/commit/a665299cd85b8cb99fdb2a9a7b0a447513d097cc))
* add --min-score flag to batch runner ([#249](https://github.com/benthorpe33/job-seeker/issues/249)) ([6a75727](https://github.com/benthorpe33/job-seeker/commit/6a75727fe8b5f83f52613e7a3b3b93fda45f4041))
* add {{PHONE}} placeholder to CV template ([#287](https://github.com/benthorpe33/job-seeker/issues/287)) ([0129af9](https://github.com/benthorpe33/job-seeker/commit/0129af9ca679727d2dc7a2bbd06fd870df61fdd7))
* add Block G — posting legitimacy assessment ([bd668e4](https://github.com/benthorpe33/job-seeker/commit/bd668e420d21ce8ee9b72580c94a176674f2bd8d))
* add follow-up cadence tracker mode ([c04e682](https://github.com/benthorpe33/job-seeker/commit/c04e6826b503a69fc1b670f3dd105ddfa5fa5897))
* add Gemini CLI native integration and evaluator script  ([#349](https://github.com/benthorpe33/job-seeker/issues/349)) ([14575f6](https://github.com/benthorpe33/job-seeker/commit/14575f68c618806b5b19a5027c738a82e314bdb8))
* add Gemini CLI native integration and evaluator script (closes [#344](https://github.com/benthorpe33/job-seeker/issues/344)) ([14575f6](https://github.com/benthorpe33/job-seeker/commit/14575f68c618806b5b19a5027c738a82e314bdb8))
* add GitHub Actions CI + auto-labeler + welcome bot + /run skill ([e876d1d](https://github.com/benthorpe33/job-seeker/commit/e876d1d84316911dadee5e1d761484e659f5c134))
* add LaTeX/Overleaf CV export mode with pdflatex compilation ([#362](https://github.com/benthorpe33/job-seeker/issues/362)) ([63d18ec](https://github.com/benthorpe33/job-seeker/commit/63d18ec058bc1b3af86e4a622d6b674e1be7513b))
* add LaTeX/Overleaf CV export mode with pdflatex compilation (closes [#47](https://github.com/benthorpe33/job-seeker/issues/47)) ([63d18ec](https://github.com/benthorpe33/job-seeker/commit/63d18ec058bc1b3af86e4a622d6b674e1be7513b))
* add Nix flake devshell with Playwright support ([6821f26](https://github.com/benthorpe33/job-seeker/commit/6821f26cfe85ac08057b9b09db123992e67e5e33))
* add OpenCode slash commands for career-ops ([#67](https://github.com/benthorpe33/job-seeker/issues/67)) ([7cf695f](https://github.com/benthorpe33/job-seeker/commit/7cf695f84a9f4b0d54a6d17e72418d8b9f41b919))
* add scan.mjs — zero-token portal scanner ([41febbf](https://github.com/benthorpe33/job-seeker/commit/41febbfe2a9e68fc6cd346aa081081d6d1273143))
* **dashboard:** add Catppuccin Latte light theme with auto-detection ([76b5476](https://github.com/benthorpe33/job-seeker/commit/76b5476628e6eddfe8a6ac5d076f621ff828f4f9))
* **dashboard:** add manual refresh shortcut ([#246](https://github.com/benthorpe33/job-seeker/issues/246)) ([485c157](https://github.com/benthorpe33/job-seeker/commit/485c1570b0610d6d1936d65da11532cb0fc09078))
* **dashboard:** add progress analytics screen ([4225ca2](https://github.com/benthorpe33/job-seeker/commit/4225ca2088f191272d24c1db01921b659c295540))
* **dashboard:** add vim motions to pipeline screen ([#262](https://github.com/benthorpe33/job-seeker/issues/262)) ([f5aeb30](https://github.com/benthorpe33/job-seeker/commit/f5aeb30f8fefe0330d01f66481040080422f86fb))
* **dashboard:** aligned tables and markdown syntax rendering in viewer ([9f6576b](https://github.com/benthorpe33/job-seeker/commit/9f6576bd6b56dfb7bd4ab01f58bc4c897a0b23ad))
* expand portals.example.yml with 8 dev-tools companies + 23 search queries ([#140](https://github.com/benthorpe33/job-seeker/issues/140)) ([6150715](https://github.com/benthorpe33/job-seeker/commit/6150715d8962f91750e4fa34c0510f3340ab5460))
* **i18n:** add Japanese README + language modes for Japan market ([3ae9a2b](https://github.com/benthorpe33/job-seeker/commit/3ae9a2b1b254dc9a48fb2fbb3bde8e481e55f37e))
* **prefetch:** handle gh_jid company-careers URLs and iframe-embedded boards (js-f7g) ([8e2d26e](https://github.com/benthorpe33/job-seeker/commit/8e2d26e149f88c46283d3227ebbe55befc244864))
* **prefetch:** mark apply-only URLs as skipped, short-circuit before workers (js-9df) ([f5cfdd1](https://github.com/benthorpe33/job-seeker/commit/f5cfdd1bde74e06aced4d3e08025ca0885c56578))


### Bug Fixes

* 10 bug fixes — resource leaks, command injection, Unicode, navigation ([61cdc58](https://github.com/benthorpe33/job-seeker/commit/61cdc58d348b17ff24c48ca1d3f8aec449edb834))
* add data/ fallback to UpdateApplicationStatus ([#55](https://github.com/benthorpe33/job-seeker/issues/55)) ([e67026e](https://github.com/benthorpe33/job-seeker/commit/e67026e5a1467731f3d8285b7c012e06c64aa948))
* add stopword filtering and overlap ratio to roleMatch ([#248](https://github.com/benthorpe33/job-seeker/issues/248)) ([5116918](https://github.com/benthorpe33/job-seeker/commit/5116918fb110ed5454ba1d5f9a23ad12abc50af1))
* align portals.example.yml indentation for new companies ([c5b030e](https://github.com/benthorpe33/job-seeker/commit/c5b030e3a1054af29a18d28475ea7b04c6b47492))
* auto-prefetch Ashby/Greenhouse JDs before triage (js-0zl) ([8be250b](https://github.com/benthorpe33/job-seeker/commit/8be250bc5476b938c30bb5f1f05dec4d5a38df3d))
* auto-upgrade triage to FULL_MODEL on Haiku fragment-missing retry (js-tt0) ([aede3ac](https://github.com/benthorpe33/job-seeker/commit/aede3ac19390b39d8cb39038a32eee7e861b6598))
* **batch-runner:** sweep stale JDs before preemptive prefetch (js-cdv) ([ca9a0fc](https://github.com/benthorpe33/job-seeker/commit/ca9a0fcd4c44f7da74a352268135f58ca271cdb3))
* **batch-runner:** three bugs surfaced in 2026-05-06 79-offer run ([d8f0be6](https://github.com/benthorpe33/job-seeker/commit/d8f0be66edbff1996cce95d46393cbacf7c9e095))
* **batch:** harden report numbering and make prefetch path cwd-independent ([d8e06fe](https://github.com/benthorpe33/job-seeker/commit/d8e06febfee3e0cc5626d5a93784ee321085fec3))
* **batch:** move worker scratch dirs out of /tmp to fix Win path-mapping (js-7dn) ([fc554ec](https://github.com/benthorpe33/job-seeker/commit/fc554ec0450ac96b70fe40b7dde9b203bd62755b))
* **batch:** slug-guard normalization, lock hardening, report-path integrity ([7e8f2a1](https://github.com/benthorpe33/job-seeker/commit/7e8f2a136c5bd9afecaf8ff06aafb6c1b08f74cc))
* capture URL token only in loadEvaluatedUrls regex ([8c690b8](https://github.com/benthorpe33/job-seeker/commit/8c690b819a2e78a949010c18d564f3f24c047da9))
* **ci:** gracefully handle missing dependency graph in dependency-review ([#343](https://github.com/benthorpe33/job-seeker/issues/343)) ([6522568](https://github.com/benthorpe33/job-seeker/commit/65225680549083d42d7fd90e729fdfc857761d8c))
* **ci:** gracefully handle missing dependency graph in dependency-review workflow ([#352](https://github.com/benthorpe33/job-seeker/issues/352)) ([6522568](https://github.com/benthorpe33/job-seeker/commit/65225680549083d42d7fd90e729fdfc857761d8c))
* **ci:** use pull_request_target for labeler on fork PRs ([#260](https://github.com/benthorpe33/job-seeker/issues/260)) ([cb6f9fc](https://github.com/benthorpe33/job-seeker/commit/cb6f9fcdb7f81c93fd51f911316d055f7cc285e5))
* correct _shared.md → _profile.md reference in CUSTOMIZATION.md (closes [#137](https://github.com/benthorpe33/job-seeker/issues/137)) ([95a6632](https://github.com/benthorpe33/job-seeker/commit/95a6632dbc813e2340749202f5fa61688ace1e6d))
* correct dashboard launch path in docs ([#80](https://github.com/benthorpe33/job-seeker/issues/80)) ([9931982](https://github.com/benthorpe33/job-seeker/commit/993198261f70a5f7974aa5bcd0460b8f6ffbd80c))
* **dashboard:** show dates in pipeline list ([#298](https://github.com/benthorpe33/job-seeker/issues/298)) ([890fb39](https://github.com/benthorpe33/job-seeker/commit/890fb39e8ba7232a9f13301c725c505a8e9e8b10))
* **dedup:** strip Ashby /application suffix in normalizeUrl (js-x7v) ([4de6ee9](https://github.com/benthorpe33/job-seeker/commit/4de6ee91aa3dd3cea9d99af93eb1b8997a65d5c4))
* defensive expansion in batch-runner RETURN trap (js-pf1) ([89f14da](https://github.com/benthorpe33/job-seeker/commit/89f14daa07213aa5ecd2f6e5d86f798c87d1189d))
* detectBash skips WSL launcher + scans Git Bash install paths ([a8e9482](https://github.com/benthorpe33/job-seeker/commit/a8e9482bca1be85f8b18cfa59d41f2ab8d59b94e))
* ensure data/ and output/ dirs exist before writing in scripts ([#261](https://github.com/benthorpe33/job-seeker/issues/261)) ([737d87d](https://github.com/benthorpe33/job-seeker/commit/737d87d64a239c1dd228489880ba6a4ff4ea40a7))
* filter batch-input via prefetched ATS location, post-stage-6 (js-q4s) ([318c0ce](https://github.com/benthorpe33/job-seeker/commit/318c0ce94340d44336e95c2f25c72bdd24783eb4))
* filter expired WebSearch links before they reach the pipeline ([#57](https://github.com/benthorpe33/job-seeker/issues/57)) ([1a73221](https://github.com/benthorpe33/job-seeker/commit/1a73221d3ce60649dfea88e106da8b694d745e71))
* improve default PDF readability ([#85](https://github.com/benthorpe33/job-seeker/issues/85)) ([aab7789](https://github.com/benthorpe33/job-seeker/commit/aab77892abf282c0d8430a768429a58dc0ec79d3))
* **jobs:** put Git userland on PATH for bash-spawned jobs ([eb7c815](https://github.com/benthorpe33/job-seeker/commit/eb7c8158d20eaa93f235e09c3216d6b5a87c7efd))
* **linkedin:** recover saved jobs dropped by LinkedIn UI changes ([1243d9e](https://github.com/benthorpe33/job-seeker/commit/1243d9eecfa757cb402561de492288052a6f4879))
* liveness checks ignore nav/footer Apply text, expired signals win ([bba50f1](https://github.com/benthorpe33/job-seeker/commit/bba50f11883d7bd434ffe3da07655225ab73b52d))
* **merge-tracker:** stop fuzzy dedup collapsing distinct reqs; keep status fresh ([f2bb0a6](https://github.com/benthorpe33/job-seeker/commit/f2bb0a6ed9b0d3587379b9164faf46a6c02b8215))
* **pipeline:** unbreak resume past stage 6, make JD prefetch unconditional ([2ddaebe](https://github.com/benthorpe33/job-seeker/commit/2ddaebe7c27b234ec51c47fb2913987da6199d3a))
* plug .facts-pack-*.md worker leak in batch-runner.sh (js-dnp) ([e551428](https://github.com/benthorpe33/job-seeker/commit/e5514281c8c0245b2312038af541a6c0758c4c04))
* prefetch-jds tmpdir on Windows — use os.tmpdir() (js-6d4) ([bf5ff1e](https://github.com/benthorpe33/job-seeker/commit/bf5ff1e6be6bf9e2e0f395376092a1557c3a816b))
* **pt:** restore diacritical marks in PT-BR modes ([#358](https://github.com/benthorpe33/job-seeker/issues/358)) ([4b74f54](https://github.com/benthorpe33/job-seeker/commit/4b74f5451f6db00858fe23cf87f70b026a8d3126))
* **pt:** restore diacritical marks in PT-BR modes ([#359](https://github.com/benthorpe33/job-seeker/issues/359)) ([4b74f54](https://github.com/benthorpe33/job-seeker/commit/4b74f5451f6db00858fe23cf87f70b026a8d3126))
* remove wellfound, lever and remotefront from portals.example.yml ([#286](https://github.com/benthorpe33/job-seeker/issues/286)) ([64b4c9a](https://github.com/benthorpe33/job-seeker/commit/64b4c9aac2645571a01105804ecffaaa0f7c16f5))
* replace grep -P with POSIX-compatible grep in batch-runner.sh ([2a6eeac](https://github.com/benthorpe33/job-seeker/commit/2a6eeac996f56ce7d3a30a0419f23db477e4eebb))
* test-all.mjs scans only git-tracked files, avoids false positives ([c3b3293](https://github.com/benthorpe33/job-seeker/commit/c3b329317da996df6509c2a21633f222b9b229db))
* **tracker:** stop a literal "|" in a job title from shifting table columns ([6c8bd67](https://github.com/benthorpe33/job-seeker/commit/6c8bd6769757015ba5606be8f40c2b79687bc246))
* **triage-prompt:** require Read invocation + JD_FIRST_200 echo (js-7dn) ([a7f38a8](https://github.com/benthorpe33/job-seeker/commit/a7f38a81126c7c310ee7f7668ed32b456bc2d1d4))
* **triage:** add Step 3.5 self-verify + document Haiku Write-skip tradeoff (js-ivp) ([e952c17](https://github.com/benthorpe33/job-seeker/commit/e952c170960c7b0a2bfb2639be72469a3e9d4822))
* use candidate name from profile.yml in PDF filename ([071bb2a](https://github.com/benthorpe33/job-seeker/commit/071bb2adb84181d06c839ccfd3a41e0a8a0ef4cf))
* use execFileSync to prevent shell injection in test-all.mjs ([882771a](https://github.com/benthorpe33/job-seeker/commit/882771ae47e0843125b46e364ffd5d42fd280f70))
* use fileURLToPath for cross platform compatible paths in tracker scripts ([#32](https://github.com/benthorpe33/job-seeker/issues/32)) ([#58](https://github.com/benthorpe33/job-seeker/issues/58)) ([91f5d34](https://github.com/benthorpe33/job-seeker/commit/91f5d34e9791716da9e4c40f6f4dbc1772a18785))
* use hi@santifer.io in English README ([4555bd7](https://github.com/benthorpe33/job-seeker/commit/4555bd724327feeb3ea9ffbf6768e01b21e18b2f))


### Performance Improvements

* cache LinkedIn jobId→ATS resolutions across runs (js-9ss) ([0249bec](https://github.com/benthorpe33/job-seeker/commit/0249becd1635d41e4cc76920b9f10f671ff4a37d))
* compress hero banner from 5.7MB to 671KB ([5eb0066](https://github.com/benthorpe33/job-seeker/commit/5eb00667c8ec355d6f4dbbd94e45f1f3b0908751))
* hoist URL-vs-reports/ dedup into resolve-ats-urls.mjs (js-f8y) ([1e628cb](https://github.com/benthorpe33/job-seeker/commit/1e628cb613bb52b622c0dae908f27bcbe1bada88))

## [1.5.0](https://github.com/santifer/career-ops/compare/v1.4.0...v1.5.0) (2026-04-14)


### Features

* add --min-score flag to batch runner ([#249](https://github.com/santifer/career-ops/issues/249)) ([cb0c7f7](https://github.com/santifer/career-ops/commit/cb0c7f7d7d3b9f3f1c3dc75ccac0a08d2737c01e))
* add {{PHONE}} placeholder to CV template ([#287](https://github.com/santifer/career-ops/issues/287)) ([e71595f](https://github.com/santifer/career-ops/commit/e71595f8ba134971ecf1cc3c3420d9caf21eed43))
* **dashboard:** add manual refresh shortcut ([#246](https://github.com/santifer/career-ops/issues/246)) ([4b5093a](https://github.com/santifer/career-ops/commit/4b5093a8ef1733c449ec0821f722f996625fcb84))


### Bug Fixes

* add stopword filtering and overlap ratio to roleMatch ([#248](https://github.com/santifer/career-ops/issues/248)) ([4da772d](https://github.com/santifer/career-ops/commit/4da772d3a4996bc9ecbe2d384d1e9d2ed75b9819))
* **dashboard:** show dates in pipeline list ([#298](https://github.com/santifer/career-ops/issues/298)) ([e5e2a6c](https://github.com/santifer/career-ops/commit/e5e2a6cffe9a5b9f3cec862df25410d02ecc9aa4))
* ensure data/ and output/ dirs exist before writing in scripts ([#261](https://github.com/santifer/career-ops/issues/261)) ([4b834f6](https://github.com/santifer/career-ops/commit/4b834f6f7f8f1b647a6bf76e43b017dcbe9cd52f))
* remove wellfound, lever and remotefront from portals.example.yml ([#286](https://github.com/santifer/career-ops/issues/286)) ([ecd013c](https://github.com/santifer/career-ops/commit/ecd013cc6f59e3a1a8ef77d34e7abc15e8075ed3))

## [1.4.0](https://github.com/santifer/career-ops/compare/v1.3.0...v1.4.0) (2026-04-13)


### Features

* add GitHub Actions CI + auto-labeler + welcome bot + /run skill ([2ddf22a](https://github.com/santifer/career-ops/commit/2ddf22a6a2731b38bcaed5786c4855c4ab9fe722))
* **dashboard:** add Catppuccin Latte light theme with auto-detection ([ff686c8](https://github.com/santifer/career-ops/commit/ff686c8af97a7bf93565fe8eeac677f998cc9ece))
* **dashboard:** add progress analytics screen ([623c837](https://github.com/santifer/career-ops/commit/623c837bf3155fd5b7413554240071d40585dd7e))
* **dashboard:** add vim motions to pipeline screen ([#262](https://github.com/santifer/career-ops/issues/262)) ([d149e54](https://github.com/santifer/career-ops/commit/d149e541402db0c88161a71c73899cd1836a1b2d))
* **dashboard:** aligned tables and markdown syntax rendering in viewer ([dbd1d3f](https://github.com/santifer/career-ops/commit/dbd1d3f7177358d0384d6e661d1b0dfc1f60bd4e))


### Bug Fixes

* **ci:** use pull_request_target for labeler on fork PRs ([#260](https://github.com/santifer/career-ops/issues/260)) ([2ecf572](https://github.com/santifer/career-ops/commit/2ecf57206c2eb6e35e2a843d6b8365f7a04c53d6))
* correct _shared.md → _profile.md reference in CUSTOMIZATION.md (closes [#137](https://github.com/santifer/career-ops/issues/137)) ([a91e264](https://github.com/santifer/career-ops/commit/a91e264b6ea047a76d8c033aa564fe01b8f9c1d9))
* replace grep -P with POSIX-compatible grep in batch-runner.sh ([637b39e](https://github.com/santifer/career-ops/commit/637b39e383d1174c8287f42e9534e9e3cdfabb19))
* test-all.mjs scans only git-tracked files, avoids false positives ([47c9f98](https://github.com/santifer/career-ops/commit/47c9f984d8ddc70974f15c99b081667b73f1bb9a))
* use execFileSync to prevent shell injection in test-all.mjs ([c99d5a6](https://github.com/santifer/career-ops/commit/c99d5a6526f923b56c3790b79b0349f402fa00e2))
