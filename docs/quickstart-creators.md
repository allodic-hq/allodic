# Sell your first skill in ten minutes

You have a SKILL.md that does something valuable. This turns it into a
product with checkout, licensed delivery, and updates — on your own domain.

## 1. Deploy your registry (~5 min)

```bash
git clone https://github.com/allodic-hq/allodic && cd allodic
BASE_URL=https://skills.yoursite.dev docker compose up -d --build
docker compose logs allodic | grep "admin key"   # SAVE THIS
```

Point DNS at the box. Done — `https://skills.yoursite.dev` is your
storefront. (Full options, Stripe, SMTP: [DEPLOY.md](DEPLOY.md).)

## 2. Price and publish (~2 min)

```bash
export ALLODIC_SERVER=https://skills.yoursite.dev
export ALLODIC_ADMIN_KEY=adm_...        # from first boot
```

Add one field to your SKILL.md frontmatter:

```yaml
metadata:
  version: "1.0.0"  # allodic requirement — entitled updates need it
  price: "$29"      # or omit — free skills get everything except checkout
```

```bash
npx allodic publish ./my-skill
```

Publish runs three gates — agent-skills/v1 compliance (will it run?),
your evals if present (does it work?), and a safety scan (is it safe?) —
then signs the release and puts it live:

```
── gates ─────────────────────────────────────
  ✓ spec       agent-skills/v1  skills-ref (official reference validator)
  ✓ allodic :  release requirements 7/7  extensions via metadata, not part of the standard
  ✓ evals      7/7 passing  claude

✓ Published my-skill@1.0.0
  $29.00 product created

  Listing    https://skills.yoursite.dev/s/my-skill
```

## 3. Share the listing link

That `/s/` URL is your product page: README, trust panel, install count,
version history, Buy button. Buyers pay by card (Stripe) and install with
one command. You're selling.

## Ship an update

```bash
# bump `version:` in SKILL.md, then:
npx allodic release ./my-skill
```

Every licensed buyer gets it with `npx allodic update`. Full refunds
revoke access automatically via the Stripe webhook; partial goodwill
refunds keep the license and book only the cents returned — `allodic
sales` shows both accurately (see DEPLOY.md).

## See how it's going

```bash
npx allodic sales      # orders, revenue, active licenses
```

Your registry also publishes public aggregates at `/api/stats`.

## Add evals (worth it)

Ship `evals/tasks.json` next to your SKILL.md — prompts plus grading
criteria. Publish runs them, binds the scorecard to the exact release, and
buyers can re-run them before trusting you: that's your "Does it work?"
gate. See [trust-model.md](trust-model.md) for who-attests-what.
