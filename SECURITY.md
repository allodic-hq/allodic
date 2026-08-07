# Security Policy

allodic is a commerce and trust layer: signing keys, license entitlements,
payment webhooks, and buyer fingerprints are all security surface. Reports
are taken seriously and fast.

## Reporting a vulnerability

Please report privately via GitHub Security Advisories:
https://github.com/allodic-hq/allodic/security/advisories/new

Do not open public issues for vulnerabilities. You can expect an initial
response within 72 hours.

## Scope of interest (non-exhaustive)

- Signature or key-pinning bypass (capability, bundle, scorecard)
- Stripe webhook forgery, replay, or idempotency defects
- License/entitlement bypass (bundle or update access without a valid order)
- Path traversal or file-write escapes in bundle installation
- Buyer fingerprint or derivation-commitment weaknesses
- Credential leakage in packages, images, or archives
- Telemetry privacy violations: any forbidden data (skill content, names,
  paths, credentials, buyer data, exact prices) reaching the telemetry
  endpoint, or reporting that ignores the documented off switches

## Supported versions

Pre-1.0: only the latest published alpha receives fixes.
