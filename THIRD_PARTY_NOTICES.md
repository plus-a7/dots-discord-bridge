# Dependency licenses (installed lockfile snapshot)

Checked exact installed package metadata, including nested dependencies, and copied shipped license/notice texts into `docs/licenses/`. This lists production and development dependencies; it is not a claim that a future public distribution has completed legal review. Before distributing bundled dependencies, preserve applicable notices and recheck the exact release lockfile. No third-party source was copied into bridge source.

33 physical package installations, 32 unique name/version pairs. 19 optional lockfile packages are not installed on this Mac and not included in this adopted-runtime notice inventory.

| Package | Version | Declared license | Shipped license/notice files copied |
|---|---|---|---|
| `@discordjs/builders` | 1.14.1 | Apache-2.0 | 1 |
| `@discordjs/collection` | 1.5.3 | Apache-2.0 | 1 |
| `@discordjs/collection` | 2.1.1 | Apache-2.0 | 1 |
| `@discordjs/formatters` | 0.6.2 | Apache-2.0 | 1 |
| `@discordjs/rest` | 2.6.3 | Apache-2.0 | 1 |
| `@discordjs/util` | 1.2.0 | Apache-2.0 | 1 |
| `@discordjs/ws` | 1.2.3 | Apache-2.0 | 1 |
| `@modelcontextprotocol/core` | 2.3.1 | Apache-2.0 | 1 |
| `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 | 1 |
| `@sapphire/async-queue` | 1.5.5 | MIT | 0 shipped; 1 upstream |
| `@sapphire/shapeshift` | 4.0.0 | MIT | 1 |
| `@sapphire/snowflake` | 3.5.5 | MIT | 0 shipped; 1 upstream |
| `@stablelib/base64` | 1.0.1 | MIT | 1 |
| `@types/node` | 26.6.4 | MIT | 1 |
| `@types/ws` | 8.18.2 | MIT | 1 |
| `@typescript/typescript-darwin-arm64` | 7.0.2 | Apache-2.0 | 2 |
| `@vladfrangu/async_event_emitter` | 2.4.7 | MIT | 2 |
| `discord-api-types` | 0.38.56 | MIT | 1 |
| `discord.js` | 14.27.0 | Apache-2.0 | 1 |
| `fast-deep-equal` | 3.1.3 | MIT | 1 |
| `fast-sha256` | 1.3.0 | Unlicense | 1 |
| `lodash` | 4.18.1 | MIT | 1 |
| `lodash.snakecase` | 4.1.1 | MIT | 1 |
| `magic-bytes.js` | 1.13.1 | MIT | 1 |
| `standardwebhooks` | 1.1.1 | MIT | 0 shipped; 1 upstream |
| `ts-mixer` | 6.0.4 | MIT | 1 |
| `tslib` | 2.8.1 | 0BSD | 2 |
| `typescript` | 7.0.2 | Apache-2.0 | 2 |
| `undici` | 6.29.0 | MIT | 1 |
| `undici-types` | 8.9.0 | MIT | 1 |
| `ws` | 8.22.0 | MIT | 1 |
| `zod` | 4.6.5 | MIT | 1 |

## Missing shipped MIT texts verified on 2026-10-08

The public npm registry metadata for each exact version supplied its `gitHead`. At that immutable upstream commit, the package's `package.json` was checked for matching name, version and MIT declaration. The repository license was copied verbatim, including copyright and permission notices. This verifies release provenance rather than assuming today's default branch applies to an older package. Source URLs, commits and SHA-256 hashes are saved in [upstream-mit-provenance.json](docs/licenses/upstream-mit-provenance.json).

| Package | Immutable primary source | Copyright |
|---|---|---|
| `@sapphire/async-queue@1.5.5` | [LICENSE.md at npm gitHead](https://github.com/sapphiredev/utilities/blob/36268acb83cc613e06836f6ebbdafeeba99c2365/LICENSE.md) | The Sapphire Community and its contributors, 2020 |
| `@sapphire/snowflake@3.5.5` | [LICENSE.md at npm gitHead](https://github.com/sapphiredev/utilities/blob/dd52b66fc63099b2f95163eebd4df23c26b1cd16/LICENSE.md) | The Sapphire Community and its contributors, 2020 |
| `standardwebhooks@1.1.1` | [libraries/LICENSE at npm gitHead](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE) | Svix, 2023 |

The missing-text task is complete for this installed Mac dependency snapshot. The original source license is still unselected. A future source-only release must exclude private config, conversation data, state, credentials and generated bundles. A bundled or cross-platform release must re-inventory the actual shipped optional dependencies, preserve required notices, and obtain publication and source-license approval. No license selection, public repository or push occurred.

The second pass also copied two shipped supplementary texts omitted from the initial inventory: `@vladfrangu/async_event_emitter/THIRD_PARTY_LICENSE.md` (Node.js contributor copyright and permission text) and `tslib/CopyrightNotice.txt`. These accompany the package's ordinary LICENSE rather than replacing it.
