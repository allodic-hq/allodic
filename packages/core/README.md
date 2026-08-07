# @allodic/core

Core primitives for [allodic](https://github.com/allodic-hq/allodic), the
self-hosted registry for selling Agent Skills direct: Ed25519 signing and
key pinning, dual-layer buyer fingerprinting (zero-width + semantic canary
slots with derivation commitments), Agent Skills spec validation (exact
port of the official `skills-ref` validator, parity-tested), safety-scan
engines (NVIDIA SkillSpector integration + builtin ruleset), verified eval
scorecards, and price/royalty terms.

One runtime dependency (`yaml`). Node >= 22.13 (matches `engines`). Usually consumed via the
[`allodic`](https://www.npmjs.com/package/allodic) CLI or
[`@allodic/server`](https://www.npmjs.com/package/@allodic/server).

MIT — see LICENSE.
