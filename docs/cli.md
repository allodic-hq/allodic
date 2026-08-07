# CLI reference

Run via `npx allodic <command>` or install globally.

## Creator commands

| Command | Does |
|---|---|
| `init [name]` | `init my-skill` creates `./my-skill/` (name validated against agent-skills/v1 first); bare `init` scaffolds in-place only when the cwd name is already valid — invalid names are refused with a suggested fix before anything is written |
| `publish <dir>` | Gate (standard → evals → scan) → sign → put live |
| `release <dir>` | Publish a new version to existing buyers |
| `inspect <url>` | Show a listing's public metadata + preview |
| `sales` | Orders, revenue, active licenses (needs admin key) |
| `trace <file> [--explain]` | Identify which buyer's copy a leak is |

## Buyer commands

| Command | Does |
|---|---|
| `add <listing-url>` | Buy-activate-verify-install (prompts on first use per seller) |
| `update` | Pull entitled updates for every installed skill |
| `verify <url> [--evals]` | Re-check signature, scan, provenance; re-run benchmarks locally |
| `stats` | Local usage derived from your agents' logs — never transmitted |
| `report <url>` | Explicitly share a usage report with the creator (opt-in) |
| `--version` / `version` | Print the CLI version |
| `telemetry status\|enable\|disable\|show` | One switch for all automatic reporting — Allodic product analytics and publisher install/update delivery events share it ([telemetry.md](telemetry.md)) |

## Environment

| Variable | Used by | Purpose |
|---|---|---|
| `ALLODIC_SERVER` | creator cmds | Your registry URL |
| `ALLODIC_ADMIN_KEY` | creator cmds | Printed at first server boot |
| `ALLODIC_TELEMETRY=0` / `=1` | all cmds | Disable / force-enable ALL automatic reporting (product analytics + publisher delivery events) for this process |
| `DO_NOT_TRACK=1` | all cmds | Disable all automatic reporting; overrides everything |
| `NO_COLOR` | all cmds | Disable colored output ([no-color.org](https://no-color.org)); piped output is always color-free |
| `ALLODIC_COLOR=1` / `=0` | all cmds | Force colored output on/off (`NO_COLOR` still wins) |
| `ALLODIC_EVAL_RUNNER` | publish/verify | `claude`, `mock`, or a runner cmd |
| `ALLODIC_LOG_DIR` | stats | Where your agent transcripts live |
| `ALLODIC_SCANNER=builtin` | publish/verify/add | Force the builtin scan ruleset (skip SkillSpector even if installed) |

Credentials live in `~/.allodic/credentials.json`, keyed by server —
one token per seller, entitlement checked per skill. The file is written
`0600` inside a `0700` `~/.allodic` (atomic replace; pre-existing looser
modes are repaired on use).
