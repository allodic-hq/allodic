# Roadmap

Directions under consideration — not commitments, not a schedule. Issues
and pull requests that move any of these forward are welcome.

## Install policy (the enterprise word)
A `allodic-policy.json` evaluated by `add` / `verify` before anything touches disk:
```json
{ "require": ["signature", "provenance", "scan:clean", "evals:passing"],
  "deny":    ["permissions:write", "requires-network"] }
```
Personal default: permissive. Team/fleet mode: policy ships from an admin URL.
This is `docker trust` + admission control for capabilities.

## Trust panel (Sigstore-style)
Listing + checkout render the six-line badge: signed / provenance / scan /
benchmarks reproduced / compatible / policy compliant. HTTPS-padlock legibility.

## Open scan corpus
Publish rule set + labeled samples as a benchmark. Turns the scanner's claims
into a community-auditable asset.

## Registry-attested trust
Self-hosted badges are publisher-attested. An independent registry can
execute and sign the scans and benchmark runs itself — a third party
standing behind the claim. Identity anchors (DNS /
GitHub proofs) upgrade "signed" toward "verified".

## Creation studio (phase 3, expert creators)
Five modes compiling to one governed capability: Build (code/tools), Teach
(docs/examples/walkthroughs), Shape (voice/taste/boundaries), Design
(interactive experiences), Connect (products/data). Exploratory.

## Discovery integrations
Free skills can be listed on skills.sh / SkillPack / gh skill for reach,
with the paid edition sold from the author's own registry. Worth smoothing
that dual-publish path (one command, both places).

## Metered capabilities
Server-side delivery per invocation with a credits wallet — for content
that should be consulted, not possessed (e.g. regulated-domain material
that must always be current).

## Agent buyers
Machine-readable checkout (402 flow) with owner-scoped budgets; fiat first,
x402 adapter slot honored.

## Royalty execution
Declared `payout_splits` are signed and accrued today (`allodic sales`
shows what's owed); settlement is manual. Automated routing needs a
platform account between the parties (Stripe Connect) — recipients onboard
once, refunds reverse proportionally — which is why v1 stops at verifiable
accounting.
