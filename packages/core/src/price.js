// Price parsing: humans write "$29" or "$29.50"; machines get integer cents.
// `price_cents: 2900` also accepted for the explicit crowd. Bare integers are
// rejected as ambiguous — the flagship screenshot must not need a footnote.
export function parsePrice(meta) {
  // Allodic commercial fields live under `metadata:` — the Agent Skills
  // spec's extension mechanism. Top-level price/price_cents fail spec
  // compliance, so refuse them here with a migration message.
  const ext = meta.metadata ?? {};
  for (const f of ['price', 'price_cents']) {
    if (meta[f] !== undefined && ext[f] === undefined) {
      throw new Error(`top-level \`${f}\` violates agent-skills/v1 — move it under \`metadata:\``);
    }
  }
  if (ext.price_cents !== undefined) {
    const c = Number(ext.price_cents);
    if (!Number.isInteger(c) || c < 0) throw new Error(`invalid metadata.price_cents: ${ext.price_cents}`);
    return c;
  }
  if (ext.price === undefined || ext.price === '') return 0;
  const m = String(ext.price).trim().match(/^\$(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`metadata.price must look like "$29" or "$29.50" (got: ${ext.price}) — or use metadata.price_cents`);
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
}

// payout_splits: "10% -> https://their.site/s/pg-auditor, 5% -> alice@x.com"
// Declared royalties to upstream skills or people, folded into the signed
// terms. v1 declares and signs the obligation; payout execution is the
// hosted tier's job (see ROADMAP).
export function parseSplits(meta) {
  const ext = meta.metadata ?? {};
  const raw = ext.payout_splits ?? ext.royalties;
  if (!raw) return [];
  const splits = String(raw).split(',').map((part) => {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*%\s*->\s*(.+)$/);
    if (!m) throw new Error(`payout_splits entry must look like "10% -> <url-or-email>" (got: ${part.trim()})`);
    return { pct: Number(m[1]), to: m[2].trim() };
  });
  const total = splits.reduce((n, s) => n + s.pct, 0);
  if (total >= 100) throw new Error(`payout_splits total ${total}% — must leave the author something (<100%)`);
  return splits;
}

/** The terms a release ships under — folded into the signed manifest. */
export function buildTerms(meta) {
  return {
    priceCents: parsePrice(meta),
    currency: 'usd',
    updates: 'entitled',
    refunds: 'revoke-access',
    payoutSplits: parseSplits(meta),
  };
}
