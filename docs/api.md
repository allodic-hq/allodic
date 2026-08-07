# HTTP API reference

Everything the storefront does, you can do — same endpoints.

## Public (no auth)

| Route | Returns |
|---|---|
| `GET /` | Storefront index (HTML) or `{registry, catalog, stats}` (JSON) |
| `GET /catalog` | All listings, machine-readable |
| `GET /s/:slug` | Listing page (HTML for browsers, JSON otherwise) |
| `GET /api/s/:slug` | Listing JSON, explicit |
| `GET /api/stats` | `{skills, licenses, transactions, volumeCents}` aggregates |
| `GET /buy/:slug`, `/thanks` | Checkout and post-purchase pages |

## Purchase & activation

| Route | Body → Returns |
|---|---|
| `POST /api/checkout/:slug` | `{email}` → Stripe URL (free skills instant-grant; paid skills need Stripe, or the insecure dev flag) |
| `POST /api/webhook/stripe` | Stripe events: `checkout.session.completed` / `…async_payment_succeeded` (validated against the immutable checkout-time terms, never the current listing), `charge.refunded` and `refund.created` (refunds accumulate; the license is revoked only when the captured amount is fully refunded). Processing is one transaction — on a storage failure the server returns 500 so Stripe redelivers |
| `POST /api/activate/start` | `{email}` → one-time code via SMTP |
| `POST /api/activate/finish` | `{email, code}` → `{token}` (bearer, per-server) |

## Licensed (Bearer token)

| Route | Notes |
|---|---|
| `GET /api/bundle/:slug` | Per-buyer signed bundle; `402` + buy link without a paid, non-revoked order for *this* slug |
| `GET /api/updates/:slug?version=` | `{updateAvailable}` for entitled buyers |
| `POST /api/events/:slug` | Delivery events (announced client-side, opt-out) |
| `POST /api/reports/:slug` | Buyer's explicit usage report |

## Admin (`x-admin-key`)

| Route | Notes |
|---|---|
| `POST /api/skills` | Publish (gated: compliance 422, scan criticals blocked) |
| `POST /api/orders/:id/revoke` | Manual revoke |
| `POST /api/trace` | Server-side trace of a suspected leak |
| `GET /api/insights/:slug` | Aggregated delivery/report insights |

## External scanner webhook (you implement)

Set `EXTERNAL_SCAN_URL`; publish POSTs `{name, version, files}` (base64).
Respond HTTP 200 with `content-type: application/json` and
`{findings:[{severity:'critical'|'warn', rule, path?, why}]}`.
Criticals block publish; errors and timeouts never do — the hook is
advisory. Your response is treated as untrusted input: the timeout
(`EXTERNAL_SCAN_TIMEOUT_MS`, default 10 s) covers the whole exchange
including the body, the body is capped (`EXTERNAL_SCAN_MAX_BYTES`,
default 1 MB), non-2xx and non-JSON responses are rejected, and at most
100 findings are merged (length-capped fields, truncation marked). The
outcome lands in the capability as `scan.external` (`"ok"` or the error).
