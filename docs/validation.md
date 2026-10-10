# Offline validation ledger


## Metadata-only OAuth setup follow-up — 2026-10-09 UTC

Final local evidence: **npm test 156/156 PASS, zero failed/skipped/cancelled** (130 socket-free + 26 literal127.0.0.1 mock loopback), typecheck PASS, JS/Swift build PASS, public setup checker offlineReady:true/liveReady:false, mock demo liveDiscordPosts:0/liveDotWake:false. Independent reviewer separately ran typecheck and JS/Swift build plus **130/130 socket-free PASS**; it did not rerun loopback/full156.

Six new tests cover strict setup-only configuration, disabled template and missing activation, production parser rejection, metadata aliases/401 and valid-JWT denial for every MCP/Events method, URL/host/header guards, CLI activation/stop/error non-disclosure, hostname-only non-trusting/no-persistence diagnostics, and a real child-process setup check that forbids production Discord/bootstrap/Keychain/JWKS/callback/MCP imports and SQLite construction. The new loopback case uses only literal127.0.0.1; it sends absent/generated JWTs to setup mode and gets 401 with no tools/Events execution.

The config reader was extracted unchanged to config-file.ts, with deployment reexports preserving the production API. CLI defers production parser/bootstrap imports. OAuth metadata generation is shared between normal authentication and setup, while normal production validation and callback allowlists remain strict. No new dependency, lockfile/native/license change, external setting, credential read, service installation, real Bot/IdP/Tunnel/plugin/subscription/post, or Git push was performed.

The side-effect probe rejects production imports and SQLite construction in setup-check. Setup prepares PRMD/401 only and does not establish OAuth completion, plugin registration, actual callback-host acquisition, or dot wake. Actual callback-host acquisition remains a deployment acceptance gate, documented in oauth-setup.md/morning.md; no dummy or wildcard fills it.

Earlier sections below retain their historical counts and earlier unchanged-source statements; this follow-up changes the specified production source and supersedes the current test count.

## 2026-10-10 JST / 2026-10-09 UTC — final local finish, current snapshot

This snapshot covers the offline test and distribution improvements only. It does not establish actual Discord/ChatGPT connectivity, existing service availability, account/resource authorization or exclusive Bot ownership. No actual deployment configuration, Keychain entry, login session or local service diagnostic record is included in this public validation ledger.

Final evidence: **npm test 150/150 PASS, zero failed/skipped/cancelled**, including JS/Swift compilation and 25 literal127.0.0.1 mock listener cases; typecheck PASS; setup checker `offlineReady:true, liveReady:false, sourceLicense:unselected`; demo `liveDiscordPosts:0, liveDotWake:false`. Full tests used authorized local-bind execution; no external test traffic or real native Keychain query. Independent reviewer separately ran typecheck, JS/Swift build, socket-free **125/125 PASS**, setup and demo; it did not rerun the full150.

Added five socket-free integration cases using the actual Gateway normalizer, SQLite file, OAuth verifier, SDK Events/tools, resource ACL and Discord sender with dummy clients/transports. They cover callback acceptance with lost receipt/retry and stable eventID, mock receiver deduplication, persisted subscription/restart and duplicate Gateway input, one same-thread reply with mention suppression, accepted-but-unacknowledged reply remaining uncertain across restart/SDK retry, origin-stop and guild-stop persistence with third-party stop denied, independent subscription/case/authorization expiry causes, and transient500 versus permanent403/404 resource errors and lost send permission. The authorization-expiry case keeps the case within its30-minute lifetime to isolate the failed grant.

The distribution checker reads only bounded canonical public-checkout files; it does not load private configuration, env, credentials or sessions. Its only child probe is `xcrun --find swiftc`, not helper execution. Independent review found an initial alias-boundary issue; the final code rejects parent/leaf symlinks and hardlinks, unexpected package names/path components, inode/dev change across no-follow open, JSON over64KiB and invalidUTF8. One additional setup regression probes root/parent aliases, oversized JSON and unexpected package paths using dummy temp files. Build-presence checks alone do not attest compiled identity or real ACL compatibility. The original source license remains unselected.

README now states local verification/unfinished real connection. [setup.md](setup.md) describes distribution checks; [morning.md](morning.md) separates existing-account test permission from new-access gates and distinguishes Bot→Discord evidence from Discord→actual dot→reply. Public initial commit `931885144d6f220ff2987513ab846124b0e2de8b` was verified read-only on GitHub. The follow-up is compared against that published commit. Public documentation omits personal approval history and local service diagnostics. Dependencies, lockfile, production `src/`, native source and LICENSE are unchanged in this follow-up.

Actual Discord posts, Bot login, actual dot subscription/wake, existing OAuth authorization, official Tunnel readiness/metadata mapping, Keychain ACL, ownership handoff and supervision remain untested here. The prior isolated tests and the additional local tests are not substituted for these results. Existing tokens or account login alone do not prove the new bridge's resource/audience/owner scope is already authorized.

## Previous 144-test explicit OAuth / optional Cloudflare snapshot

Owner approval covered removing the mandatory Cloudflare dependency and implementing explicit authentication separation. Version 2 requires `authentication.kind` (`oauth_resource_server` or `cloudflare_access`) and a separate `http.kind` (`tunnel_loopback` or `forwarded_https`). Disabled/null/old-v1/no-auth/incomplete settings refuse before credential/client/DNS/listener work. No new dependency or authentication service was adopted; exact versions and notices remain unchanged.

Evidence on macOS / Node v24.20.0: `npm run typecheck` PASS; `npm run test:unit` **119/119 PASS**, including JS and native compile; `npm test` **144/144 PASS, 0 failed/skipped/cancelled**, including all 25 literal127.0.0.1 loopback cases; `npm run demo:mock` PASS with `mockOnly:true`, `signedMockCallbacks:1`, `mockReplies:1`, `liveDiscordPosts:0`, `liveDotWake:false`. Unit tests are socket-free. Full tests required authorized local-bind execution because the restricted sandbox rejected loopback bind; no external socket was used. An intermediate test helper failed because Node disallowed an array-valued Host; raw header pairs with agent:false fixed the actual duplicate-Host test. The final full suite passed without weakening Host validation.

Added 27 OAuth cases, one fixed OAuth JWKS-path case, and three OAuth/ingress integration cases to the preceding 113 tests. All successful identities/credentials/logins are generated or mocked. Native compilation never queries Keychain; native tests reject before Security IO or use fake child pipes.

| Area | Current offline evidence |
|---|---|
| Explicit authentication | Strict mode factory; no no-auth/header/token/provider fallback; CF remains optional and its fixed origin rejects HTTP before side effects |
| Access-token profile | Generated RS256 `at+jwt`; fixed issuer/JWKS/resource/audience/subject, expiry/nbf/iat, client_id/jti/required scopes; ID/opaque/CF/alg/key-URL and malformed Bearer rejected |
| OAuth discovery | Resource-path canonical protected-resource metadata plus root alias; missing-token 401 discovery; invalid-token 401 includes error; query/body/Host/Origin/duplicate-header denials |
| Persistent authorization | Only policy fingerprint/subject/token digest/exp stored, never raw Bearer; matching restart recovers; expiry/digest revocation/policy change/legacy grant retires subscriptions and pending work, including idle worker |
| Refresh / data access | Same-identity authorized refresh replaces grant; valid replacement token cannot read or reply using a rejected old grant, including cached reply results |
| Late authorization | Expiry after actual PinnedHttps gated fake DNS prevents HTTPS request construction; expiry during challenge prevents activation; old-grant expiry during reply preparation prevents a post despite current request token |
| Isolated forwarding | Mock HTTP forwarding to127.0.0.1: OAuth → official MCP2 Events discover/list/subscribe → verified signed mock callback → bound read/provenance false → same mock thread reply, mention suppression, dedup and unsubscribe |
| Existing regressions | All prior CF, Keychain, queue, owner stop, resource ACL, destination, retry, callback SSRF, cancellation, limit and restart cases remain passing |

The forwarding mock is not the official tunnel-client or OpenAI Control Plane. Actual Tunnel runtime authentication/readiness, OAuth metadata/resource rewriting, browser authorization, issuer TLS/identity/profile, subscription refresh by ChatGPT, and actual dot asynchronous wake are untested. Immediate IdP logout/unlink/revocation notification and opaque-token introspection are not implemented; supported controls are signed-token expiry, configured digest revocation applied on restart, policy changes, and bridge owner stop. Detailed configuration and limits: [oauth.md](oauth.md).

No real secret was read or sent; no Bot login/post, Tunnel installation/creation/authentication, cloud/DNS/IdP/account change, public listener, launchd registration, existing-runtime change or paid operation occurred in this implementation. Public repository creation was separately authorized to the Git task; this worker performed no git staging/repo creation/push. Publication allowlist/exclusions and unselected original source license: [publication-scope.md](publication-scope.md). Independent evidence is recorded separately in [independent-review.md](independent-review.md).

## Previous 113-test Keychain reference follow-up

The owner approved reference configuration for login Keychain service `DOTS_DISCORD_BOT`, account `discord`. `credential.kind` is required; the disabled template contains names only and keeps all activation/ownership confirmations false. The bootstrap selects only the configured source, with no fallback. Real Keychain contents, ACL, unlock/session state and credentials were not read. Existing Hermes shutdown remains unverified. No Bot login, launchd registration/start, existing-service change or external connection was performed.

Added `src/keychain.ts`, `native/keychain-reader.swift`, compile-only `scripts/build-keychain.mjs` and nine isolated tests. Native Security/LocalAuthentication disables authentication UI and scopes the query to the login Keychain. Node spawns only the fixed helper with shell:false, PATH-only env, standard streams ignored, and secret fd 3 pipe. Names only appear in argv. Bounded output/time, child failure, empty/invalid token, stop/cancel, no fallback and redacted errors are verified with fake children/pipes. Actual helper execution tests invalid arguments or a nonpipe fd 3 and exits before Keychain IO. It was never run with a real query pipe. Buffer clearing is best-effort; complete CF/JS/SDK memory zeroization is not claimed.

Final evidence: `npm run typecheck` PASS, JS build PASS, native Swift build PASS; **npm test 113/113 PASS, 0 FAIL, 0 skipped** (91 socket-free + 22 literal-loopback tests). The full suite rebuilds the helper without invoking Keychain. Independent review separately reran typecheck/JS build/native compile, socket-free 91/91 and the nine Keychain cases; no blocking code finding. Production Keychain ACL/no-UI/session/helper identity compatibility, Hermes ownership handoff and real dot wake remain untested. Dependency versions and licensing inventory are unchanged. The current setup and remaining user actions are recorded in [keychain.md](keychain.md) and [connect.md](connect.md).

## Previous 104-test provider/bootstrap snapshot

2026-10-09 bootstrap/provider final offline pass · macOS · Node v24.20.0 · TypeScript 7.0.2 · official MCP server SDK 2.3.1 · discord.js 14.27.0 · standardwebhooks 1.1.1. Dependencies unchanged.

Commands: `npm run typecheck` PASS; `npm run demo:mock` PASS (auth-free in-process, signedMockCallbacks=1, mockReplies=1, liveDiscordPosts=0, liveDotWake=false); `npm test` builds and runs Node tests: **104 tests, 104 PASS, 0 FAIL, 0 skipped** (previous snapshots: 31, 49, 81). Independently rerun with the same result. No Bot login, external listener, tunnel, plugin connection, actual Discord API call, actual dot turn or new model invocation was performed. 82 unit cases are socket-free; 22 integration cases explicitly start/close literal 127.0.0.1 ephemeral listeners with fake issuer/JWKS/Discord and signed mock callbacks. Restricted sandbox bind returned EPERM; the local-only integration command ran under separately approved execution. There was no external test traffic. External development reads were requested official documentation and public dependency/license metadata/text only. No real credential, existing private config or personal conversation was read. Token reader tests create and remove dummy-only temporary files; fake login never connects to Discord.

| Area | Offline evidence |
|---|---|
| Guild-wide scope | Single configured guild; owner only, multiple regular channels and threads, no mention; guild outside/DM/third-party/Bot/webhook denied |
| Dynamic destinations | Original tuple persisted, no channel enumeration; same-named foreign guild, parent mismatch, channel/thread swap and tool destination injection denied; permissions loss denies read/send |
| Dynamic stop/restart | Per-origin stop leaves other origins active; stop-all survives reopen; dynamic origins/queue/subscriptions persist, maxOrigins enforced |
| Auth-free mock assembly | Actual MCP Events discover/subscribe/signature/read/reply in-process; no token loader, no socket, no LLM, explicit liveWake=false |
| Owner message without mention | Queued, normalized provenance preserved, authorization false |
| Exclusions | Self, webhook, unknown Bot, unmentioned allowlisted third party/Bot, wrong guild/channel/thread excluded |
| Provenance | Owner / third_party / allowed_bot distinct; arbitrary third-party approval text remains external data |
| Destination and auth | Wrong principal, unknown event, injected argument/thread, second callback binding rejected |
| Events lifecycle | Actual SDK v2 discover/events list/subscribe/read/reply/unsubscribe through Request/Response; capability preserved |
| Callback verification | Correct signed single-use challenge echoed; wrong echo fails with -32015; no application delivery before verified subscription |
| Signatures | Standard Webhooks verifier accepts exact mock body; body/ID tampering rejected; rotation accepted by both keys |
| Callback security | URL scheme/host/port/userinfo/fragment and private/reserved/mapped-IP checks; mixed public/private DNS rejected before HTTPS |
| Delivery retries | Stable eventID; exponential schedule; 413 terminal; 5-attempt cap including saved final-attempt recovery |
| Unsubscribe/stop | Repeated unsubscribe succeeds; challenge-vs-unsubscribe race rejected; owner stop persists and prevents pending delivery |
| Persistence | Durable subscription/secret/mock message/queue/reply state reopened; reserved reply becomes uncertain; no auto repost |
| Exclusive restart | Concurrent Store open rejected; abrupt process.exit and SIGKILL release OS lock and saved state reopens |
| Limits | Busy sender rejects concurrent reply; case time and reply count and queue record caps fail closed |
| Actual sender adapter | Fake Discord client exercises same DiscordJsSender implementation: destination tuple, permissions, nonce/enforceNonce, allowedMentions empty; stop during fetch yields zero second post |
| Delay/timeout | Guard-aware deferred sender cannot post after stop/timeout; timeout returns uncertain, concurrency gate held until underlying settle |
| Revoked configuration | Full destination tuple, authenticated principal and current owner identity changes prevent old queued data delivery/read/send |
| Live resource seam | Mandatory access hook denies revoked scope; ResourceUnavailable preserves pending and does not consume callback attempt |
| Callback preparation cancellation | Actual PinnedHttps with gated fake DNS and forbidden fake HTTPS constructor: guild stop-all, unsubscribe, TTL, case expiry, owner change and subscription refresh produce zero HTTP request creation |
| Challenge activation boundary | Unsubscribe during actual DNS preparation produces no request/subscription; ACL revoked during challenge is checked again before activation |
| Guild reply cancellation | Stop-all, unsubscribe, subscription TTL and case expiry during sender preparation yield uncertain with zero mock posts |
| Retry response classes | 408/429/503 transient; backoff exactly 1s then 2s; 401/410/413 terminal; 410 deactivates subscription |
| Signature lifetime and replay | Invalid/old/future timestamp rejected by Standard Webhooks; valid duplicate HMAC is accepted cryptographically but mock receiver deduplicates event ID; expired rotation signs only with new key |
| Accepted-before-save crash | Child process mock receiver replies then exits before delivery acceptance save; reopened queue retries identical body/event ID with fresh signature, saved sent reply returns same ID with zero new posts |
| Actual Gateway callback | attachGateway fake client denies unready/wrong bot identity; owner no-mention message queues; self/other Bots and bot-flagged owner feedback do not add records/events |
| Persistent capacity | Inactive subscription identities count toward maxSubscriptions; cap rejects before challenge/network, same identity refresh remains allowed |
| JWT authentication | Generated fake RS256 issuer/JWKS; fixed issuer/audience/owner/optional subject, bad algorithm/key URL/signature/claim/expiry rejected; bounded JWKS/cache/single-flight and late close verified |
| Actual loopback assembly | fake Access assertion → fixed host/path HTTP → official SDK → signed mock callback → read/reply → same mock thread; mention suppression and duplicate reply verified |
| Runtime lifecycle | Explicit start, ready-only single worker, reconnect pause/resume, detachment/auth close, startup cancellation, one-shot instances, safe Store drain |
| Request-local cancellation | Subscription ACL timeout produces zero challenge/subscription; reply ACL disconnect produces zero reservation/post; reserved reply timeout blocks late send and remains idempotent uncertain |
| Late-handler tracking | SDK fetch can settle before custom handler; canceled read ACL remains tracked, stop reports pending:true and retains Store until handler settles |
| Bounded canceled work | Eight canceled custom handlers retain their slots; ninth starts no ACL work, slots recover after settlement |
| Response limits | Giant, excessive-chunk and never-ending response streams hit byte/chunk/deadline bounds; untrusted cancel cannot hold active slot |
| Fixed-issuer JWKS GET | Actual provider with injected fake DNS/HTTPS: fixed /cdn-cgi/access/certs, all IPv4/A results checked and pinned, TLS/family explicit, no credentials/redirects/compression; raw64KiB/128chunks, fatal UTF8, status/abort/timeout/error/incomplete rejection |
| JWKS recovery | Network failure cooldown and recovery; HTTP200 unusable keys cooled by validator; key rotation after TTL and unknown-kid cache retention |
| Deployment fail-closed | disabled/null/unconfirmed/unsupported mode/issuer/principal and absent activate cause zero credential/client/lease/DNS/listener work; CLI check only parses settings |
| Private file boundary | Canonical owner700 dirs; explicit regular owner600/no-follow/no-hardlink bounded token/settings; aliased DB/lock/journal targets rejected without mutation |
| Bootstrap readiness | Fake token/login, expected Bot ID + bot flag + guild visible before listener; login rejection/no-ready/wrong identity never start worker/HTTP |
| Startup/cleanup cancellation | Late login, token preparation, runtime start and orphan destroy retain Store/Bot lease and return bounded pending; first SDK destroy runs after login settles |
| Shared Bot ownership | Same canonical Bot lease denies second bootstrap with a different state path before token/client/login; existing Hermes does not participate and remains untested |
| Bootstrap restart | Verified subscription/pending delivery persists; restart retries same event ID and duplicate Gateway input produces no added message/post |
| CLI / LaunchAgent | Repeated signals, nonsettling start and raw-error redaction; safe disabled/null CLI refusal; unregistered disabled plist lint PASS, no auto restart or credential env |
| HTTP input cancellation | Actual in-process Request with oversized body and never-settling cancel handler returns 413 promptly; cancel is best-effort and cannot indefinitely delay error responses |

## Changes and environment

2026-10-09 adds `src/jwks.ts`, `deployment.ts`, `bootstrap.ts`, `cli.ts`, `main.ts`, `deployment.example.json` and an unregistered LaunchAgent template. Seven JWKS, eight deployment/CLI and eight bootstrap cases supplement the prior 81 cases. No dependency/version change. The SDK default environment-token fallback is refused before Client construction. Callback and JWKS explicitly request A records with family:4 and use family:4/rejectUnauthorized:true for HTTPS. Local SDK source review identified one-shot destroy versus delayed login preparation; the bootstrap tracks actual login settlement and retains ownership. Related local instructions were checked again; no AGENTS.md or checkout .agents/skills were found. Existing private/runtime files and sessions were not read.

The following paragraph records the prior 81-test implementation snapshot:

The previous pass changed callback/events/core/MCP and added recovery regressions. This pass adds `src/auth.ts`, `src/http.ts`, `src/runtime.ts`, fake-issuer fixtures, 18 authentication cases and 14 runtime/HTTP cases; no new dependency was added. SDK Request.signal is preserved and checked after asynchronous work and before side effects. A custom-handler tracker is capped at eight and included in runtime drain independently of HTTP response completion. Response reading applies bounds before accumulation and races abort. Existing fixtures retain the mandatory callback authorization guard. DNS deadline timers are cleared when lookup settles. The unsubscribe race uses one bounded in-flight cancellation flag rather than an unbounded map of arbitrary callback identities. All callback transport implementations invoke the supplied guard immediately before submission after asynchronous preparation. Request error/oversize responses do not await untrusted body cancellation.

Workspace inspection found no Git repository, AGENTS.md or checkout `.agents/skills` under the task root. Existing source and docs were inspected directly; no claimed git diff/commit was created. Public source/fixtures use dummy IDs; real IDs remain outside the deliverable sources. `docs/operations.md` is a reviewable procedure, not an executed deployment. Runtime and explicit login bootstrap/provider/CLI are implemented, but approved live settings and external connection are absent. See `docs/release-candidate.md` for the exact code/settings boundary.

License follow-up: all three missing shipped MIT texts were recovered at the exact version's npm gitHead, with matching upstream name/version/license checked; source URL, commit and SHA-256 recorded. Supplementary Node.js and tslib copyright notices were copied from installed package texts. Original source license remains unselected; no public distribution occurred.

## Still untested/live gates

- Actual Hermes Bot identity/token reference, MessageContentIntent, Discord channel/thread membership/view/send rights, reconnect/rate limiting and live permissions revocation. permissionsFor also uses guild/member/role caches; an authoritative atomic ACL check is not proven.
- Actual ChatGPT/dot authentication discovery and dedicated principal/chat isolation. Static bearer factory is an offline seam. Access JWT validation is verified with generated fake keys only; actual issuer, audience, owner identity, managed OAuth discovery and ChatGPT compatibility are not established.
- Public HTTPS or Secure MCP Tunnel reachability; actual callback host/IPv4 availability, DNS pinning and TLS connection on a real callback.
- Real `server/discover`/subscription issued by **parent's actual dot「える」conversation**; event callback 2xx followed by actual asynchronous wake, read/reply, same-origin channel/thread Discord post.
- Already in-flight request at stop/unsubscribe boundary; batching, out-of-order events and burst limits in actual dot scheduling.
- Real Gateway outage/backfill is not implemented. Pending received records survive; messages never received during outage are not recovered.
- Bot/third-party prompt injection behavior in actual dot; source approval interpretation beyond code's provenance boundary.
- Private token reader, fixed-issuer network JWKS provider, explicit login bootstrap, CLI and disabled LaunchAgent template are implemented and fake-tested. Actual config/credential reference, supervisor registration/startup, persistent live deployment and rollback still require approval.
- Real HTTPS/TLS/DNS, actual Cloudflare assertions and key rotation remain untested. Mock GETs verify provider branches/options, not a live issuer exchange. Both transport failures and unusable HTTP200 keysets have bounded cooldown.
- Login preparation cannot always be aborted in discord.js. Library stop retains ownership until actual settlement; CLI can terminate only its own process after finite drain. Real Gateway cancellation behavior is not proven by fake login tests.
- Directory/SQLite alias guards prevent existing accidental symlink/hardlink targets. Same-UID concurrent path replacement and the protection of the OS account/backups remain external boundaries.

A mock 2xx and hand-driven tools call are not reported as actual wake success. The code contains no replacement LLM. No Claude generation was run because existing no-extra-cost execution entitlement was not established. No public repository/push/license grant was made.

## Manual Tunnel metadata preparation — 2026-10-10 UTC

The separate manual preparation targets official `openai/tools/tunnel-client` 0.0.16. The public native helper has unset Keychain service/account placeholders and refuses a production query until configured locally, rebuilt, and repinned. Private profiles and credentials are not shipped. Static plan checks establish file/hash/permission consistency only, not Keychain availability or service readiness.

Implementation evidence supplied with this change: typecheck, production Swift compilation and JS syntax checks PASS; existing **156/156 npm tests PASS** and a separate **6/6 Tunnel mock tests PASS**, zero failed/skipped/cancelled. The six compile a different TUNNEL_MOCK binary and use synthetic credentials, mock client/descendant processes and temporary Unix/literal127.0.0.1 sockets. They are not included in npm test.

Mock cases cover inherited FD4 delivery without credential values in argv/environment/diagnostics, FD3 parent control closure, explicit stop and timeout, startup/client failures, exclusive session ownership, hard parent death and stale-lock denial, Terminal SIGHUP cleanup, fragmented stop acknowledgement, metadata GET and MCP/Events 401, and CLI non-TTY/activation/override refusal. LICENSE/NOTICE and the Homebrew-generated SBOM are preserved for the referenced release. No binary redistribution audit or source-license selection is claimed.

Actual Keychain read/ACL, installed-client FD4 read/runtime authentication/readiness, Tunnel metadata rewriting/ChatGPT resource display, Auth0 compatibility, dot subscription/async wake and Discord reply are unverified by these mocks. Guardian SIGKILL/OS failure is outside cleanup guarantees. A pending stop or stale lock requires operator review before restart or lock removal. See [manual procedure](tunnel-metadata.md).

## Single-read FD4 and bounded startup diagnostics — 2026-10-10 UTC

The generated YAML no longer contains APIKey. Official 0.0.16 resolves YAML file references before resolving the CLI override, so the old duplicate consumable pipe reached EOF on its second read. The native CLI is now the sole reference. Schema-only validation is explicitly distinguished from runtime/key/authentication validation.

Supplied final evidence: typecheck and existing **156/156 PASS**, separate **13/13 mock startup cases PASS**, and **1/1 official-binary configuration regression PASS**, zero failed/skipped/cancelled. The public integration reruns these checks separately. The official regression uses synthetic bytes, deny-all-network sandbox, an intentional MCP max0 configuration sentinel before runtime construction, and bounded exact fixed stderr classifications; it reads no private config or Keychain and performs no real connection.

The diagnostics tests cover synthetic Keychain classifications, client/guardian exit and signal distinction, bounded non-reflecting FD3 frames, stage failures, PID-bound fixed-port health status, redirect/abort/timeout, deadline race and late/nonsettling probes, and cleanup. The public production helper also rejects unset Keychain placeholders with a fixed diagnostic. Mock fixtures use SIGTERM to exercise signal reporting without generating intentional crash reports.

Actual saved-key validity, official Control Plane authentication/readiness, resource mapping/display, OAuth compatibility and dot/Discord acceptance remain unverified. Local readiness and credential handoff diagnostics do not establish those outcomes. Source/license/dependency snapshots remain separate from private settings and binaries.

Public checkout verification of this correction: typecheck, JS/Python syntax, production Swift compilation, existing156, mock13 and official configuration1 all PASS, zero failed/skipped/cancelled. Public setup remains offlineReady:true/liveReady:false and demo remains liveDiscordPosts:0/liveDotWake:false. This run used no real key, private profile or live service.

## Operator launcher UX — 2026-10-10 UTC

The generic generator, keyless preflight and thin operator launcher add a double-click/Enter path through the existing metadata-only command. Preparation creates owner700 private wrappers without starting them. TTY/Enter are interaction guards, not proof of human identity. The launcher explains saved-key use and destination before confirmation, preserves the FD4/TTY/15-minute controls, uses existing socket stop, and retains fixed results on failure/cancel/end. No retry, supervisor, new grant or persistent permission is added.

The separate UX suite contains7 cases covering preflight/confirmation order, cancel/EOF/signals/bounds, secret non-reflection, socket stop, lock/schema/port refusal, absolute shell quoting, and mock Mac PTY start/stop/duplicate/cancel/helper failure/missing script/import failure. These tests use synthetic fixtures; no actual Terminal app, Keychain, generated production wrapper or live service is operated. Finder association/launch and actual saved-key authentication/readiness/OAuth/dot wake/Discord reply require separate acceptance evidence.

Public checkout verification: typecheck, JS syntax, production Swift compilation, existing **156/156**, separate mock **13/13**, UX **7/7**, and official offline configuration **1/1** all PASS, zero failed/skipped/cancelled. Setup reports offlineReady:true/liveReady:false; demo reports liveDiscordPosts:0/liveDotWake:false. No actual key, private profile or live service was used.
