# allodic

**Turn any Agent Skill into a product.**
Run `allodic-server`, add a price to the SKILL.md you already have, and you
get a storefront, checkout, licensed delivery, and entitlement-controlled
updates — from your own domain. Every release is signed; every buyer's copy
is traceable; every claim is reproducible. No website to build.

> *Allodial* land is land you hold outright — no landlord, no overlord, no
> platform taking its cut. That's the idea: what you make with AI is yours to
> sell, on your own terms.

Website + rendered docs: **https://allodic.dev** — built from this repo's
`docs/` at deploy time, so this repo stays the single source of truth.

![90-second demo: publish through the gates, install with proof](https://github.com/allodic-hq/allodic-demo/raw/main/demo.gif)

*Real output, reproducibly rendered — the recording lives in
[allodic-demo](https://github.com/allodic-hq/allodic-demo) and is re-rendered
whenever CLI output changes.*

## Make a skill sellable with one field

```diff
   ---
   name: pg-auditor
   description: Audits Postgres migrations…
 + metadata:
 +   price: "$29"
   ---

  $ allodic publish .
  ── gates ─────────────────────────────────────
    ✓ spec       agent-skills/v1  skills-ref (official reference validator)
    ✓ allodic :  release requirements 7/7  extensions via metadata, not part of the standard
    ✓ evals      7/7 passing  claude

  ✓ Published pg-auditor@1.4.0
    $29.00 product created
    Delivery   licensed, per-buyer fingerprinted
    Updates    entitlement-controlled
    Refunds    full refund revokes access

    Listing    https://your.site/s/pg-auditor
    Checkout   https://your.site/buy/pg-auditor
    Buyers     npx allodic add https://your.site/s/pg-auditor
```

One field on a running allodic server (self-hosted; Stripe for real money —
`docs/DEPLOY.md`, ~10 minutes, Dockerfile included). Omit the price and
everything here works for free skills: signed releases, verification, and
controlled distribution to clients, cohorts, or beta lists.

## Three gates, every release

Every publish must pass the triad before it can ship — and two of the three
are reproducible by the buyer:

| Gate | The buyer's question | Who can check |
|---|---|---|
| **Standard** — agent-skills/v1 validation | *Will it run?* | official reference validator, at publish |
| **Benchmarks** — signed eval runs on the explicit candidate, hash-bound; mandatory for paid skills | *Does it do what the tasks check?* | buyer re-runs: `verify --evals` |
| **Scan** — instruction-level threat analysis | *Is it safe?* | buyer re-runs: `verify` |

## The server is the storefront

`allodic-server` ships a complete registry UI — no frontend work:

- `/` — your registry index
- `/s/<skill>` — the listing page people share: README, trust panel,
  install count, version history, install snippet, Buy button
- `/buy/<skill>` — checkout with one job
- Everything renders from the same `/api/*` the CLI uses — replace any
  page later; the HTML is convenience, the API is the product

## Trace — the part people don't believe

Every distributed copy commits to buyer-specific choices among
*semantically equivalent* phrasings (`{{~ hot tables | high-traffic
tables }}`). Meaning-level choices survive formatting changes and partial
paraphrasing — the things that kill conventional watermarks:

```bash
# leak found online: frontmatter stripped, zero-width chars removed,
# whitespace reflowed, case changed
$ allodic trace ./leaked.md --explain
zero-width channel: DESTROYED · frontmatter: stripped
→ canary: order ord_0e27f6 · acme-consulting@example.com · uniquely consistent with all surviving slots
  14/15 slots survived · 28 of 30 bits observed · 214 orders on record
  chance a random rewrite matches this well: <1% — semantic evidence, corroborate before acting
```

Trace reports **evidence, never a fabricated single answer**. Attribution
is claimed only when exactly one order is consistent with every surviving
slot; when several buyers' copies collide in the slot space, you get the
truth instead:

```
→ canary: 2 buyer copies are consistent with the surviving 7 slots. Attribution is inconclusive.
```

Capacity is physics, not policy: B bits of canary slots distinguish at
most 2^B copies, so publish warns paid skills below ~24 bits (the example
skill ships 30). Partial rewrites degrade to *inconclusive* rather than
breaking silently; a full from-scratch rewrite defeats tracing entirely —
this raises the cost of clean laundering, it doesn't abolish it.

## Verify — reproducibly

```bash
$ allodic verify https://your.site/s/pg-auditor --evals
✓ capability signature valid
✓ digest binds the published per-file hash map
✓ bundle signature + file hashes
✓ continuity: bundle signed against the published capability digest
✓ provenance: 3/3 unvaried files hash-identical to published capability
✓ derivation commitment: selection within the committed slot structure
✓ local safety scan of the delivered files  clean via skillspector@2.5.1 (static)
✓ published scorecard: signature valid + bound to this exact published content
✓ evals reproduce locally (claude, candidate materialized: ephemeral workspace)  7/7 vs published 7/7
✓ per-task agreement with the signed scorecard
verification complete — all checks passed
```

Verify says exactly what each line proves. Unvaried files are
*mechanically* proven: your copy hashes identically to the published
capability. Watermark-varied files can't be re-derived buyer-side without
revealing the slot map (which would gut leak tracing), so they carry the
strongest compatible property: a salted commitment to the full slot
structure, published inside the signed capability *before* any sale. A
seller cannot retroactively invent a published→delivered mapping; in a
dispute the commitment is opened and either reproduces your stripped copy
exactly, or convicts the seller. Continuity (same signing authority) is
labelled as continuity — not passed off as derivation.

## Mechanisms

- Ed25519 signatures over deterministic canonical-JSON manifests
- Content-addressed digests with collision-proof framing, derivable from
  the published per-file hash map — `verify` recomputes the digest from
  the map, binding digest ⇔ file map ⇔ delivered bytes; per-buyer
  bundles carry a provenance link
- Benchmark scorecards hash-bound to exact content — recycled scorecards
  on modified skills are rejected
- Dual fingerprinting: steganographic + semantic canary slots
- **Standards gate**: every publish is validated against the open
  agent-skills/v1 spec by the spec authors' own reference validator
  (`skills-ref`) when installed, or an exact, parity-tested port of it —
  non-compliant skills are blocked. Allodic's own requirements
  (`metadata.version`, `metadata.price`) are enforced separately and
  labelled as extensions, never as part of the standard
- Publish-time safety scan — NVIDIA's SkillSpector (64 patterns, static
  mode, pinned) when installed, builtin instruction-level ruleset
  otherwise; blocking verdicts stop publish, and the engine + version
  land in the signed manifest. An optional vendor-agnostic webhook
  (`EXTERNAL_SCAN_URL`) adds any external detector to the same gate
  (contract in `docs/DEPLOY.md`)
- **Publisher key pinning**: first install records the signing key; an
  update signed by a different key is refused with a warning
- Installed skills never phone home — no telemetry ships inside anything
  a buyer runs. The Allodic *CLI* sends disclosed, privacy-limited
  automatic usage events unless disabled: coarse product events to
  Allodic via `j.allodic.dev`, and install/update delivery events to the
  relevant publisher — never skill content, names, paths, credentials,
  buyer data, or exact prices. One switch kills both: `allodic telemetry
  disable`, `ALLODIC_TELEMETRY=0`, or `DO_NOT_TRACK=1`
  ([docs/telemetry.md](docs/telemetry.md)). Local agent-usage reports
  stay on-device unless you explicitly submit one
- Zero-dependency crypto core (`node:crypto`); conforms to the open
  Agent Skills format; installs alongside `npx skills`

## Documentation

[Sell your first skill](docs/quickstart-creators.md) ·
[Install what you bought](docs/quickstart-buyers.md) ·
[CLI](docs/cli.md) ·
[Trust model](docs/trust-model.md) ·
[HTTP API](docs/api.md) ·
[Deploy](docs/DEPLOY.md) ·
[FAQ](docs/faq.md)

## Run it

```bash
npm ci && npm test             # lockfile-exact install; crypto, canary, evals, scan, manifest, price
npm run server                 # registry + storefront; admin key on first boot
# self-host:  docker compose up -d --build      (see docs/DEPLOY.md)
bash scripts/e2e.sh            # publish → buy → install → leak → trace → revoke
```

```
packages/core     manifests, signing, fingerprinting, evals, scanner, spec validation (one dep: yaml)
packages/cli      publish / inspect / verify / add / update / release / stats / trace / sales
packages/server   registry + storefront: listings, checkout, per-buyer builds,
                  entitled updates, revocation, insights
```

MIT. PRs welcome: agent install targets, eval runners, scan rules.
