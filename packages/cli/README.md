# allodic

Sell your agent skills direct. Own your buyers. Keep ~97%.

The buyer and creator CLI for [allodic](https://github.com/allodic-hq/allodic):

```bash
npx allodic init          # scaffold SKILL.md + evals
npx allodic publish .     # three gates: spec ✓ benchmarks ✓ scan ✓
npx allodic add <url>     # buy/license, verify signature, install, pin key
npx allodic verify <url>  # reproduce every claim locally
npx allodic update        # licensed updates, key-pinned
npx allodic trace <file>  # trace a leaked copy to its order (evidence, not accusation)
npx allodic sales <slug>  # gross / refunds / net / royalties, from real orders
```

The CLI sends disclosed, privacy-limited automatic usage events (coarse
command outcomes to Allodic, delivery events to publishers) unless
disabled — `allodic telemetry disable`, `ALLODIC_TELEMETRY=0`, or
`DO_NOT_TRACK=1`. Never skill content, names, paths, credentials, buyer
data, or exact prices. Installed skills never phone home. Details:
[docs/telemetry.md](https://github.com/allodic-hq/allodic/blob/main/docs/telemetry.md).

Prereleases live on the `alpha` dist-tag: `npx allodic@alpha`.
Server counterpart: `@allodic/server`. MIT — see LICENSE.
