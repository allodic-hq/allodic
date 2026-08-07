# Trust model — what's proven, by whom, and what isn't

allodic's design rule: **every trust claim must name its attester and be
checkable by the person relying on it.** This page is the honest version.

## The three gates

| Gate | Question | Attested by | Checkable by |
|---|---|---|---|
| Standard | Will it run? | enforced at publish — official `skills-ref` validator (or exact port) | anyone: `inspect` shows compliance + engine |
| Benchmarks | Does it pass its published tasks? | the **publisher's** eval runs against the explicit candidate (mandatory gate for paid skills), hash-bound to the release | any buyer: `verify --evals` checks the signed scorecard, re-runs every task locally, and compares task by task |
| Scan | Is it safe? | the **publisher's** server (+ optional external detector) | any buyer: `verify` re-scans the delivered copy |

## Signing and key pinning

Every release is Ed25519-signed over a canonical manifest. Your first
install **pins the seller's key**; an update signed by a different key is
refused with a warning. This is trust-on-first-use with continuity — the
SSH model.

Updates are semver-ordered: a buyer is offered an update only when the
published version is strictly greater than theirs — a published downgrade
is never pushed to installed buyers, and the registry refuses
non-increasing versions at publish (byte-identical republish of the
current version excepted). Silent content swaps under an unchanged
version number are likewise refused.

Provenance is layered, and `verify` names each layer for what it proves:
**digest binding** (the capability digest is defined as a function of the
published per-file hash map and recomputed by the verifier, so digest ⇔
file map cannot drift — the framing is collision-proof: paths and
contents are hashed as canonical, domain-separated JSON entries, never
bare concatenation); **continuity** (the same signing authority claims
bundle and capability — necessary, not sufficient); **mechanical
provenance** for unvaried files
(your copy, after stripping allodic's own watermark, must hash-identical
to the published capability); and a **derivation commitment** for
watermark-varied files — a salted, hiding commitment to the full slot
structure, embedded in the signed capability pre-sale. Buyers can't
re-derive varied files mechanically (that would reveal slot positions and
defeat leak tracing); instead the seller is cryptographically bound: in a
dispute, `GET /api/skills/:slug/derivation` (admin) yields the opening,
and `verifyDerivationOpening` either reproduces the buyer's stripped copy
from the committed structure and recorded selection, or produces portable
evidence of seller fraud.

"Signed release" means *the publisher's own key* on a self-hosted server.
It proves integrity and continuity, not third-party identity. It is
publisher-attested, like any indie store.

## Why a dishonest seller still loses

Self-hosted claims are the seller's claims — they could fake a scorecard.
But claims are **signed and bound to exact content**, and buyers can
reproduce them. A signed claim that fails reproduction is portable proof
of fraud held by every buyer, full refunds revoke automatically, and the eval
tasks themselves are visible before purchase. Lying is possible once,
expensive forever. Registry-attested listings (scans and benchmarks run
and signed by an independent registry) are the natural next rung — anyone
can run such a registry; the manifest format already carries attestation.

## Signed terms — the title deed

The manifest signs not just the artifact but **the terms it shipped
under**: price, entitled updates, refund-revokes, and any declared
`payout_splits`. Every buyer's bundle links to that signed capability, so
"these were the terms at publish time" is a verifiable claim — useful in
any later dispute about price, rights, or royalties.

Derivative skills can declare royalties in frontmatter:

```yaml
payout_splits: "10% -> https://their.site/s/pg-auditor"
```

The split is validated (<100% total), folded into the signed terms, and
shown on the listing. v1 makes the obligation *verifiable* and the accounting effortless —
`allodic sales` shows accrued royalties per recipient; the seller settles
over any rail. Automated execution (Stripe Connect, recipients onboard
once, refunds reverse proportionally) needs a platform account between the
parties, so v1 deliberately stops at verifiable accounting.

Compatibility note: allodic's commercial fields (`price`, `version`,
`payout_splits`, …) live under `metadata:` — the Agent Skills spec's
documented extension mechanism. Unknown *top-level* keys are rejected by
the spec's own reference validator, so allodic never puts fields there;
skills published through allodic pass `skills-ref validate` unmodified.
If the open standard later defines commerce metadata, allodic will adopt
its field names.

## Per-buyer traceability

Distributed copies commit to buyer-specific choices among semantically
equivalent phrasings, plus conventional marks. `trace` reports evidence
with a verdict, never a fabricated single answer: a buyer is named only
when exactly one order is consistent with every surviving slot. Ties
(possible whenever orders outnumber the slot space — B bits distinguish at
most 2^B copies) are reported as "N buyer copies are consistent;
attribution is inconclusive", with the capacity math shown. Publish warns
paid skills below ~24 bits of canary capacity. Partial paraphrase degrades
to inconclusive rather than misattributing; a full from-scratch rewrite
defeats it — tracing raises the cost of laundering, it doesn't abolish it.

## What allodic does NOT protect against

- A buyer redistributing what they legally downloaded (trace identifies,
  it does not prevent — possession is DRM-free on purpose)
- A malicious *seller* on their own server lying pre-purchase (see above:
  detectable and costly, not impossible)
- Eval grading is deterministic transcript checking (required/prohibited
  content). That makes it reproducible bit-for-bit by any holder — and
  makes it a floor, not a general "does it work" judgment. A skill can
  pass its published tasks and still be mediocre; write tasks that would
  catch the failure you fear
- Prompt-injection techniques invented after the scan engines' rules —
  SkillSpector's 64 patterns (preferred engine) or the builtin ruleset
  (fallback). The scan raises the bar, it is not an oracle; the engine
  and version used are recorded in the signed manifest, and
  `EXTERNAL_SCAN_URL` adds any further detector
- Compromise of the seller's server or signing key

## Telemetry, in one paragraph

Installed skills never phone home — there is nothing in a delivered skill
that transmits, and registries report nothing to Allodic. The CLI sends
disclosed, privacy-limited automatic usage events unless disabled: coarse
allowlisted product events to Allodic through the first-party proxy
`j.allodic.dev`, and install/update delivery events (kind, version, agent
list — announced in-terminal as they're sent) to the relevant publisher.
Never skill content, names, paths, credentials, buyer data, or exact
prices; the full allowlist is in [telemetry.md](telemetry.md) and
`allodic telemetry show`. One shared switch disables both destinations:
`allodic telemetry disable`, `ALLODIC_TELEMETRY=0`, or `DO_NOT_TRACK=1`.
Local usage stats are computed from your own agents' logs on your machine
and shared only via an explicit `report`. Registries publish only
aggregate `/api/stats`.

## Install-path safety

The bundle installer treats the delivered archive as hostile until proven
otherwise. `verifyBundle` requires the delivered file set to exactly equal
the signed manifest (no unsigned extras, none missing), rejects every
unsafe path (absolute, `..` traversal, Windows drive/UNC/backslash, dot,
empty), verifies each file's hash, and returns a normalized verified map.
`installBundle` consumes only that map — never the raw response — writes
into a staging directory, confirms each destination resolves inside the
target, refuses symlink overwrites, and atomically swaps into place only
after every write succeeds. Adversarial tests cover each case.
