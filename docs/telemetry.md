# Telemetry — what the CLI reports, to whom, and how to turn it off

The Allodic CLI sends **disclosed, privacy-limited automatic usage events**
so we can see whether the product funnel actually works: do people who
`init` go on to `publish`, do publishers come back and `release`, do
listings get installed and updated, and where do those workflows fail.
This is directional product analytics — it is **never** payment
accounting, and no event here is proof of sales, buyers, revenue, GMV, or
completed Stripe transactions.

**Installed skills contain no Allodic telemetry and never phone home.**
Everything on this page is about the CLI tool itself.

## Two destinations, one switch

When automatic reporting is enabled, the CLI may send:

1. **Allodic product analytics** — coarse, allowlisted events to PostHog
   Cloud EU through `https://j.allodic.dev/capture/`, an Allodic-owned
   first-party proxy domain. PostHog Cloud EU processes these events.
2. **Publisher delivery events** — the existing install/update delivery
   events sent to the registry of the skill being installed or updated
   (event kind, version, agent list), so creators see their delivery
   counts.

Both destinations obey **one shared setting**. There is no separate
control for either; disabling automatic reporting disables both.

```bash
allodic telemetry status     # what would be sent, and why/why not
allodic telemetry show       # the full allowlist, IDs, and queue
allodic telemetry disable    # turn off both destinations, clear the queue
allodic telemetry enable     # turn both back on
```

Environment controls (highest precedence first):

| Variable | Effect |
|---|---|
| `DO_NOT_TRACK=1` | Disables both destinations. Cannot be overridden. |
| `ALLODIC_TELEMETRY=0` | Disables both for this process. |
| `ALLODIC_TELEMETRY=1` | Enables both for this process (even in CI / source checkout), unless `DO_NOT_TRACK=1`. |

Defaults: automatic reporting is **off in CI** (`CI`, `GITHUB_ACTIONS`,
`GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`,
`TEAMCITY_VERSION`, `TRAVIS`) and **off when running from the Allodic
source checkout**, so contributors and pipelines never pollute metrics.
Otherwise it is **enabled by default**, with a one-time notice printed to
stderr before anything is ever transmitted, and an immediate persistent
opt-out. Explicit user actions — like `allodic report`, which shows you a
counts-only usage report and submits it only on your explicit yes — are
not automatic reporting and remain available regardless of this setting.

## The installation identifier

Events carry a random installation UUID (`distinct_id`), generated once
with `crypto.randomUUID()` and stored in `~/.allodic/telemetry.json`
(mode 0600, atomic writes). It is **pseudonymous**: never derived from
hardware, hostname, username, MAC, machine ID, paths, Git identity, or
credentials. It survives disable/enable cycles; one person on three
machines is three IDs, and that's fine. Every event sets
`$process_person_profile: false`, so **no PostHog person profile is
created**, and IP-address storage is disabled in the PostHog project at
both organization and project level.

## Exactly what is sent

Common fields on every Allodic event:
`distinct_id`, `$process_person_profile` (always `false`),
`schema_version` (1), `event_id` (random UUID per event), `cli_version`,
`node_major`, `platform` (allowlisted), `arch` (allowlisted), `ci`
(boolean).

The complete event allowlist — nothing outside it can be queued, and the
telemetry module (not command code) enforces it:

| Event | Properties |
|---|---|
| `cli_init_succeeded` | `mode`: `new_directory` \| `in_place` |
| `cli_publish_succeeded` | `paid`, `first_publish`, `has_evals` (booleans); `eval_runner`: `claude` \| `mock` \| `custom` \| `other` |
| `cli_release_succeeded` | `paid`, `has_evals`, `eval_runner`; `active_entitlements_bucket`: `0` \| `1-5` \| `6-20` \| `21-100` \| `101+` \| `unknown` |
| `cli_add_succeeded` | `paid`; `license_flow`: `existing_token` \| `instant_checkout` \| `activation` \| `unknown`; `agents`: list from `claude-code`/`cursor`/`codex`/`windsurf`/`other`; `agent_count_bucket`: `0`\|`1`\|`2`\|`3+` |
| `cli_update_completed` | `installed_bucket`, `updated_bucket`, `current_bucket`, `failed_bucket` — each `0`\|`1-5`\|`6-20`\|`21-100`\|`101+` |
| `cli_command_failed` | `command`, `stage`, `reason` — allowlisted enums only, never error text |

About two properties that are easy to over-read:

- **`paid` is not a payment.** It means the listing's configured price is
  greater than zero. `cli_add_succeeded` with `paid: true` proves a paid
  listing was successfully installed, not that money changed hands in
  that moment (the buyer may have paid earlier, or activated a second
  device).
- **`active_entitlements_bucket` is the existing entitled audience** — a
  coarse bucket of already-fulfilled, non-revoked orders entitled to
  receive the release at the moment the registry accepts it. It is not a
  forecast, not "buyers of this release," and not revenue. The exact
  count is never sent.

## What is never sent

To PostHog, under any circumstances: skill content · prompts · skill
names, slugs, or descriptions · filenames or local paths · registry,
listing, checkout, or repository URLs · emails, usernames, or publisher
names · credentials, license tokens, signing keys, admin keys · exact
prices or transaction amounts · raw error messages, stack traces, or
HTTP response bodies · wholesale command-line arguments · wholesale
environment variables.

Publisher delivery events target the publisher's own registry and carry
only their documented payload: event kind (`install`/`update`), version,
and the agent list — the same data the CLI announces in your terminal
when it sends one.

## Queue, retries, and reliability

Undelivered Allodic events wait in `~/.allodic/telemetry-queue.json`
(mode 0600, atomic writes, max 50 events, oldest dropped first,
quarantined and reset if malformed). **The queue is treated as untrusted
input**: at read time and again immediately before transmission, every
entry is re-validated against the allowlist and the outbound payload is
rebuilt from known fields — a hand-edited or corrupted queue cannot smuggle
extra events, extra properties, or overrides of `distinct_id` /
`$process_person_profile`; invalid entries are dropped and purged. Each
event also carries a stable top-level `uuid`, so a retry after a lost
acknowledgement cannot create a duplicate in PostHog.

Each tracked command appends its event and then makes **one** best-effort
flush: at most 5 events, concurrently, within a hard 500 ms budget. Only
an HTTP 2xx removes an event; timeouts, DNS/TLS failures, and non-2xx
responses leave it queued for a later invocation — no retry loop in the
same process, no background daemon, no timer left running. Telemetry
failure is swallowed silently and can never fail a command or change its
exit status. The honest timing contract: PostHog handling adds **at most
500 ms** before exit, and each publisher delivery event is bounded at
**2 s** for the whole exchange (a stalling registry cannot hang `add` or
`update`). Telemetry-management commands (`status`/`show`/`enable`/
`disable`), help, and version are network-inert — inspecting the queue
never transmits it. Disabling reporting clears the queue immediately.

`ALLODIC_TELEMETRY_ENDPOINT` exists for tests and local development
(HTTPS required; HTTP allowed only for loopback). Invalid values disable
transmission rather than break anything. It is not a user-facing feature.

## First-use notice

Before the first automatic event can be transmitted, the CLI prints a
one-time notice to stderr naming both destinations, what is never sent,
and how to inspect and disable. It is not shown when reporting is
disabled, in CI (unless explicitly enabled), or for `--version`, help,
or the `telemetry` commands.

## Public token

The PostHog value in the CLI is a **public project token** (`phc_…`)
meant for event ingestion — the same class of value every PostHog web
snippet ships. It cannot read data. No private PostHog credential
(`phx_…`, personal API keys, project secrets) exists anywhere in the
repository, and `scripts/check-telemetry-config.js` fails the release if
one appears — or if any event outside the allowlist above is added.

Full policy page: https://allodic.dev/telemetry
