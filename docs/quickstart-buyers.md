# Install what you bought

## First purchase from a seller

1. Buy on the listing page with your email.
2. On any machine:

```bash
npx allodic add https://their.site/s/the-skill
```

3. Enter the **email you paid with** → a one-time code arrives → enter it.
   The device stores a token for that seller; you won't be asked again.

The CLI verifies the release signature, pins the seller's key, installs to
your agents (Claude Code, Cursor, …), and prints where.

## Everything after that

```bash
npx allodic update          # pull entitled updates for everything installed
npx allodic verify <url> --evals   # re-run the seller's benchmarks yourself
npx allodic inspect <url>   # read the neutral preview before buying
```

## The rules, plainly

- **Licenses are per-skill.** A second skill from the same seller installs
  with zero friction *after you buy it* — but only after.
- **Per-device activation.** New laptop → same 30-second email+code dance.
- **Full refund = access ends.** Downloads and updates stop for that
  skill; your other purchases are untouched. A partial goodwill refund
  does *not* end access. What's already on disk stays — possession is
  DRM-free; *acquisition* is what's gated.
- **Key pinning.** If a seller's signing key ever changes, updates refuse
  loudly until you decide to trust it. That's a feature.
- **Use your payment email.** Activation matches your license by the email
  Stripe saw. Different email → "no license found."
