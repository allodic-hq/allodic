# Deploying a creator instance

## Fastest path: docker compose

```bash
git clone https://github.com/allodic-hq/allodic && cd allodic
BASE_URL=https://yoursite.dev docker compose up -d --build
docker compose logs allodic | grep "admin key"   # save it
```

Runs as a non-root user, persists to the `allodic-data` volume, and exposes a
container healthcheck on `/catalog`. Set Stripe and SMTP vars (in your shell or
a `.env` file) before taking real payments — until then it runs free skills only; paid skills return 503 until you set
`STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET`. Setting the key without
the webhook secret refuses to boot — unsigned webhooks would let anyone forge
paid orders. To dry-run paid flows locally, set
`ALLODIC_INSECURE_DEV_PAYMENTS=1` — which grants paid skills WITHOUT charge
and is loudly flagged in logs and UI. Never set it in production.

Prebuilt images publish to `ghcr.io/allodic-hq/allodic` on every version tag
(prereleases as `:alpha` + exact version, never `:latest`; see docs/RELEASING.md),
multi-arch, with provenance attestation and SBOM — verify the image was built
from this repo before running it, the same way buyers verify skills.


One container per creator. Works on Fly.io, Railway, Render, or any VPS.

```bash
docker build -t allodic .
docker run -d -p 8787:8787 -v allodic-data:/data \
  -e STRIPE_SECRET_KEY=sk_live_... \
  -e STRIPE_WEBHOOK_SECRET=whsec_... \
  -e SMTP_URL=smtps://user:pass@smtp.example.com \
  -e SMTP_FROM=licenses@yoursite.dev \
  -e BASE_URL=https://yoursite.dev \
  allodic
```

First boot prints the creator admin key to logs — save it.
`BASE_URL` is the canonical public origin: when set, every generated
absolute link — storefront listing URLs, `npx allodic add` install hints,
Stripe success/cancel redirects — uses it, and request headers are never
trusted for link generation. Behind a TLS-terminating proxy this is the
setting that prevents `http://` links. If you deliberately run without
BASE_URL, set `TRUST_PROXY` (e.g. `TRUST_PROXY=1` for one proxy hop) so
Express honors `X-Forwarded-Proto`; the server warns at boot when Stripe
is configured with neither.

Point Stripe's webhook at `BASE_URL/api/webhook/stripe` (events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`charge.refunded`, and `refund.created` — the last carries per-refund
amounts, so partial refunds are booked exactly and the license is revoked
only when the captured amount is fully refunded). Payments settle against
the immutable checkout-time terms, never the current listing, so
repricing mid-checkout can't drop a buyer's money. Deliveries are
idempotent and transactional: retries, replays, out-of-order refunds, and
mid-write storage failures are handled server-side (a failed write
returns 500, nothing half-commits, Stripe redelivers). Without SMTP_URL the server refuses
activation (set `ALLODIC_DEV_CODES=1` only for local development).

## What CI proves before an image ships

Every tag runs, in order: version coherence + the full unit/route suites
(including Stripe webhook forgery/replay/duplicates, checkout-intent
settlement under repricing, partial-refund accounting, payment atomicity
under injected write failure, telemetry bounds, hostile external-scanner
handling, secret file permissions, and the benchmark
gate), the real-buyer e2e — packed `allodic`/`allodic-server` tarballs,
`allodic add` with credential storage, agent-dir install, key pinning,
licensed update, refused key rotation, refund → denial — then a container
smoke test of the exact image (API healthcheck + gate engines present).
Only after all three does the push to ghcr happen.

Builds are reproducible by construction: CI and the Docker image install
node dependencies with `npm ci` against the committed `package-lock.json`
(never `npm install`, which re-resolves ranges), the gate engines are
pinned in `scripts/gate-engines.txt` — one file consumed by both CI and
the Dockerfile, so they cannot drift apart — the base image is pinned by
digest rather than the mutable `node:22-slim` tag, and the test matrix
runs the claimed Node floor (22.13.0) alongside the current 22 line, so
the floor is tested, not assumed.

Not covered by automation (verify manually before going live): SMTP
delivery against your real provider, and reverse-proxy behaviour
(BASE_URL, forwarded headers, TLS) on your actual deployment.

## Data durability

**The data directory is ONE atomic backup unit.** It contains two things
that are useless without each other:

- `store.db` — skills, orders, licenses, tokens, telemetry. SQLite via
  Node's built-in `node:sqlite` (no npm dependency; Node >= 22.13
  required). WAL journaling makes a killed process recoverable; an
  exclusive lock makes a second server on the same data directory fail
  fast instead of corrupting writes; the schema is versioned
  (`PRAGMA user_version`) with a migration ladder; and every boot takes
  an online snapshot, rotating `store.db.bak.1..3` beside it.
- `identity.json` — the Ed25519 signing key, the buyer-fingerprint
  secret, and the admin key. **This file never rotates and cannot be
  regenerated.** Every published capability is signed with this key;
  every buyer's CLI pins its public half; every buyer fingerprint is
  derived from this secret. Lose it and every existing buyer's key pin
  refuses updates, every published capability fails verification, all
  fingerprint traceability is gone, and the admin key changes.

**Back up:** the whole directory — `rsync -a` / `cp -a` of the data dir.
The rotating `.bak` files are consistent database snapshots by
construction, but they are NOT a complete backup on their own: a `.bak`
without `identity.json` restores your ledger and none of your
cryptographic continuity. Treat any backup that doesn't include
`identity.json` (mode 0600 — preserve permissions) as incomplete.

**Restore:** stop the server, restore the whole directory (or copy a
`.bak` over `store.db` *in a directory that still has its
`identity.json`*), start.

**Fail-loud guarantee:** if the server boots against a store that
contains skills or orders but finds no `identity.json`, it refuses to
start rather than silently generating a new identity over existing
data. If the identity is truly unrecoverable, `ALLODIC_ACCEPT_NEW_IDENTITY=1`
overrides the refusal — read the boot warning first: it means
republishing every skill, every buyer re-pinning, and permanent loss of
prior fingerprint traceability.

A pre-existing `store.json` is imported once at boot and renamed
`store.json.migrated-<ts>` as a fallback.

## Abuse resistance

Unauthenticated and license-entitled write paths are rate-limited
per-process (activation: 10/15min per IP and 3/15min per email — the same
limiter brakes activation-code brute force; checkout: 20/15min per IP;
telemetry: 30/hour per license token). Set `TRUST_PROXY` so limits key on
real client IPs behind a proxy. `ALLODIC_RATE_LIMITS=off` disables them
for local development. Telemetry storage is bounded on BOTH layers: raw event/report buffers
rotate at fixed sizes, and the exact aggregates are bounded too — at
most 20 distinct client-named agent keys per skill (further novel keys
fold into a reserved `(other)` bucket, keeping totals exact in
aggregate), keys and version strings truncated to 64 bytes, and
counters accepted only as finite non-negative integers with a per-report
cap. So no token can grow the store without limit — not via the buffers,
and not via the aggregate maps either.

## Safety scan engines

The "is it safe" gate runs an engine chain, most authoritative first:

1. **SkillSpector** (NVIDIA, Apache-2.0) when installed — 64 vulnerability
   patterns across 16 categories (AST, taint tracking, YARA, MCP poisoning).
   Run static-only (`--no-llm`): the gate's promise is a *reproducible*
   scan, and the optional LLM stage is nondeterministic. The Docker image
   installs it pinned to a commit. A publish is blocked when SkillSpector
   recommends `DO_NOT_INSTALL`.
2. **Built-in ruleset** — zero-config fallback when SkillSpector is absent.
   Force it with `ALLODIC_SCANNER=builtin`.
3. **External webhook** (below) — always additive on top of either engine.

The engine and version that produced a listing's scan are recorded in the
signed capability manifest; `allodic verify` re-scans locally with the same
chain and reports if its engine differs from the published one.

## Optional: external malicious-content scanner

Set `EXTERNAL_SCAN_URL` (and optionally `EXTERNAL_SCAN_KEY`) and every publish
POSTs `{ name, version, files }` (files base64) to your endpoint. Respond:

```json
{ "findings": [ { "severity": "critical", "rule": "indirect-injection",
                  "path": "SKILL.md", "why": "…" } ] }
```

Critical findings block publish alongside the built-in scanner; errors and
timeouts never block — the hook is additive. The response is treated as
untrusted input: the timeout (`EXTERNAL_SCAN_TIMEOUT_MS`, default 10000)
covers the entire exchange including the body — a scanner that sends
headers and then stalls is cut off, not waited on — the body is capped
(`EXTERNAL_SCAN_MAX_BYTES`, default 1 MB), non-2xx status and non-JSON
content types are rejected, and at most 100 findings are merged with
length-capped fields (a truncation marker is appended past the cap).
The capability's scan summary records the outcome in `scan.external`
(`"ok"` or the error), so every release shows whether your scanner
actually saw it. The contract is
vendor-agnostic on purpose: this market consolidates fast (Lakera → Check
Point; Protect AI → Palo Alto, LLM Guard archived). Wrap whichever detector
you trust — a hosted injection-detection API, NeMo Guardrails, or Garak
probes behind a thin adapter.
