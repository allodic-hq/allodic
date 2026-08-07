// allodic server — the self-hostable rails.
//
//   GET  /catalog                     public listing of skills
//   GET  /s/:slug                     public metadata for one skill (machine-readable)
//   GET  /buy/:slug                   human checkout page
//   POST /api/checkout/:slug          start purchase  { email } -> instant grant or Stripe URL
//   POST /api/webhook/stripe          Stripe confirmation -> creates paid order
//   POST /api/activate/start          { email } -> emails a 6-hex code (v1: returns it; wire SMTP later)
//   POST /api/activate/finish         { code } -> bearer token
//   GET  /api/bundle/:slug            Bearer token -> per-buyer fingerprinted, signed bundle
//   GET  /api/updates/:slug?version=  entitlement-checked update probe
//   POST /api/trace                   creator key -> { content } -> which order leaked
//
// Every response a buyer's CLI consumes is JSON; every page a human sees is HTML.
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateKeypair, deriveFingerprint, extractFingerprint,
  buildBuyerBundle, collectFiles, parseSkillMeta,
  renderCanaryCopy, renderNeutralCopy, traceCanary, signScorecard, skillContentHash, parseSlots,
  secureDir, writeSecretJson, hardenSecret,
  buildCapabilityManifest, scanSkill, scanSkillSpector, parseSkillMeta as parseMeta, signManifest, sha256, checkCompliance, buildDerivationCommitment, gtSemver, validSemver, parsePrice,
} from '@allodic/core';
import { Store } from './store.js';
import { makeLimiter, byIp } from './limiter.js';
import { makeProvider } from './payments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ALLODIC_DATA ?? join(process.cwd(), '.allodic-data');

export function createApp({ dataDir = DATA_DIR, env = process.env } = {}) {
  const store = new Store(join(dataDir, 'store.json'));
  const provider = makeProvider(env);

  // Server identity: keypair + fingerprint secret, generated on first boot.
  // Written 0600 in a 0700 data dir (atomic temp+rename); existing files
  // from before secure writing are repaired on every boot.
  const idPath = join(dataDir, 'identity.json');
  secureDir(dataDir); // also shields store.db (+ WAL, backups): tokens, buyer emails
  hardenSecret(idPath);
  let identity;
  if (existsSync(idPath)) {
    identity = JSON.parse(readFileSync(idPath, 'utf8'));
  } else {
    // A store with published skills or orders but no identity means the data
    // dir was partially restored (db backed up, identity.json lost). Silently
    // minting a fresh identity here would be a quiet catastrophe: every
    // published capability fails verification against the new public key,
    // every buyer's pinned publisher key refuses updates, every buyer
    // fingerprint becomes untraceable (the secret is gone), and the admin
    // key changes under the operator. Fail loudly instead.
    const existingState = store.listSkills().length + Object.keys(store.data.orders).length;
    if (existingState > 0 && env.ALLODIC_ACCEPT_NEW_IDENTITY !== '1') {
      store.close();
      throw new Error(
        `${idPath} is missing but the store already contains ${store.listSkills().length} skill(s) and ${Object.keys(store.data.orders).length} order(s). ` +
        'Refusing to generate a new identity over existing data: it would break signature verification of every published capability, ' +
        'break publisher key pinning for every existing buyer, destroy fingerprint traceability, and rotate the admin key. ' +
        'Restore identity.json from backup — the data directory is ONE atomic backup unit (see docs/DEPLOY.md). ' +
        'If the identity is truly unrecoverable, set ALLODIC_ACCEPT_NEW_IDENTITY=1 to proceed anyway, accepting those consequences.'
      );
    }
    identity = { ...generateKeypair(), fingerprintSecret: cryptoRandom(), adminKey: 'adm_' + cryptoRandom() };
    store.save(); // ensure dir exists
    writeSecretJson(idPath, identity);
    if (existingState > 0) {
      console.warn('  \u26a0 ALLODIC_ACCEPT_NEW_IDENTITY=1: generated a NEW identity over an existing store. All published capabilities must be re-signed (republish), existing buyers must re-pin the new key, prior buyer fingerprints are no longer traceable, and the admin key has changed.');
    }
    console.log(`\n  First boot. Creator admin key (keep secret): ${identity.adminKey}\n`);
  }

  // Payment-mode warnings — loud, because the failure mode is giving product away.
  if (provider.isDevPaidMode) {
    console.warn('  \u26a0 INSECURE DEV PAYMENTS ENABLED (ALLODIC_INSECURE_DEV_PAYMENTS=1): paid skills are granted WITHOUT charge. Never run this in production.');
  } else if (!provider.canChargePaid) {
    console.warn('  \u26a0 No payment provider: set STRIPE_SECRET_KEY to sell. Paid skills return 503 until then; free skills work.');
  }
  if (provider.canChargePaid && !env.BASE_URL) {
    console.warn('  \u26a0 BASE_URL not set: behind a TLS-terminating proxy, install links, listing URLs, and Stripe redirects can come out as http:// or point at the internal host. Set BASE_URL=https://yoursite (and TRUST_PROXY=1 if you keep request-derived links).');
  }
  if (provider.webhookVerification === false) {
    // Only reachable with ALLODIC_INSECURE_DEV_PAYMENTS=1 (fails at boot otherwise).
    console.warn('  \u26a0 STRIPE_WEBHOOK_SECRET missing: ALL Stripe webhooks will be rejected (400). Checkout redirects work; orders will never be confirmed. Dev only.');
  }

  const app = express();
  // Reverse proxies: BASE_URL is the canonical public origin — when set,
  // every generated absolute link uses it and request-derived origins are
  // never trusted for links. TRUST_PROXY controls Express's handling of
  // X-Forwarded-* for the no-BASE_URL fallback (e.g. TRUST_PROXY=1 for one
  // TLS-terminating hop). Without either, a proxied deployment would emit
  // http:// install and listing links.
  const baseUrl = (env.BASE_URL ?? '').replace(/\/+$/, '') || null;
  if (env.TRUST_PROXY !== undefined) {
    const tp = env.TRUST_PROXY;
    app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : /^\d+$/.test(tp) ? Number(tp) : tp);
  }
  const siteUrl = (req) => baseUrl ?? `${req.protocol}://${req.get('host')}`;

  // Abuse brakes on the unauthenticated/entitled write paths. Admin routes
  // (key-authed) and the Stripe webhook (signature-verified) are not limited.
  const limitActivateIp = makeLimiter({ name: 'activation per IP', windowMs: 15 * 60 * 1000, max: 10, key: byIp });
  const limitActivateEmail = makeLimiter({ name: 'activation per email', windowMs: 15 * 60 * 1000, max: 3, key: (req) => (req.body?.email ?? '').toLowerCase() || null });
  const limitCheckout = makeLimiter({ name: 'checkout per IP', windowMs: 15 * 60 * 1000, max: 20, key: byIp });
  // Telemetry limiting is layered (P0: never key a limiter on a raw client
  // header). Outer: per-IP, BEFORE authentication — bounds what an
  // unauthenticated flood can do. Inner: per-ORDER (a server-resolved
  // identity), AFTER the bearer token has been validated and mapped to a
  // license — invalid tokens are rejected by auth and never mint a limiter
  // identity at all.
  const limitTelemetryIp = makeLimiter({ name: 'telemetry per IP', windowMs: 15 * 60 * 1000, max: 120, key: byIp });
  const limitTelemetryOrder = makeLimiter({ name: 'telemetry per license', windowMs: 60 * 60 * 1000, max: 30, key: (req) => req.order?.id ?? null });
  app.use('/api/webhook/stripe', express.raw({ type: '*/*' }));
  app.use(express.json({ limit: '20mb' }));

  const requireAdmin = (req, res, next) => {
    if (req.headers['x-admin-key'] !== identity.adminKey) return res.status(401).json({ error: 'admin key required' });
    next();
  };

  // ---------- public ----------
  app.get('/assets/theme.css', (_req, res) =>
    res.type('text/css').send(readFileSync(join(__dirname, '..', 'public', 'theme.css'), 'utf8')));

  app.get('/api/stats', (_req, res) => {
    const orders = Object.values(store.data.orders).filter((o) => o.status === 'paid');
    res.json({
      skills: store.listSkills().length,
      licenses: orders.filter((o) => !o.revoked).length,
      transactions: orders.length,
      volumeCents: orders.reduce((n, o) => n + (o.amount ?? 0), 0),
    });
  });

  app.get('/catalog', (_req, res) => {
    res.json(store.listSkills().map(publicSkill));
  });

  const listingJson = (skill) => {
    const preview = renderNeutralCopy(Buffer.from(skill.files['SKILL.md'], 'base64').toString('utf8')).slice(0, 600);
    return { ...publicSkill(skill), publicKeyPem: identity.publicKeyPem, preview, evals: skill.evals ?? null };
  };

  app.get('/api/s/:slug', (req, res) => {
    const skill = store.getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: 'not found' });
    res.json(listingJson(skill));
  });

  app.get('/s/:slug', (req, res) => {
    const skill = store.getSkill(req.params.slug);
    if (!skill) return res.status(404).send('Not found');
    // Browsers get the storefront; every other client gets JSON (back-compat).
    if (!(req.headers.accept ?? '').includes('text/html')) return res.json(listingJson(skill));
    const c = skill.capability ?? {};
    const selfUrl = `${siteUrl(req)}/s/${skill.slug}`;
    const installEvents = store.data.eventTotals[skill.slug]?.installs ?? 0;
    const orders = Object.values(store.data.orders).filter((o) => o.slug === skill.slug && o.status === 'paid' && !o.revoked);
    const installs = Math.max(installEvents, orders.length);
    const updatedAgo = daysAgo(skill.updatedAt);
    const versions = [{ version: skill.version, at: skill.updatedAt }, ...(skill.history ?? []).slice().reverse()]
      .slice(0, 8).map((v) => `<div class="t">v${escapeHtml(v.version)} <span style="color:var(--soft)">· ${daysAgo(v.at)}</span></div>`).join('');
    const readmeHtml = renderMd(renderNeutralCopy(Buffer.from(skill.files['SKILL.md'], 'base64').toString('utf8')).replace(/^---\n[\s\S]*?\n---\n/, ''));
    const html = readFileSync(join(__dirname, '..', 'public', 'listing.html'), 'utf8')
      .replaceAll('{{name}}', escapeHtml(skill.name))
      .replaceAll('{{slug}}', escapeHtml(skill.slug))
      .replaceAll('{{description}}', escapeHtml(skill.description ?? ''))
      .replaceAll('{{version}}', escapeHtml(skill.version))
      .replaceAll('{{creator}}', escapeHtml(skill.creator))
      .replaceAll('{{price}}', skill.price === 0 ? 'Free' : `$${(skill.price / 100).toFixed(2)}`)
      .replaceAll('{{buyLabel}}', skill.price === 0 ? 'Get it' : `Buy — $${(skill.price / 100).toFixed(2)}`)
      .replaceAll('{{digest}}', escapeHtml((c.digest ?? '').slice(0, 12) || '—'))
      .replaceAll('{{scan}}', c.scan ? (c.scan.criticals ? 'findings' : 'clean') : 'unscanned')
      .replaceAll('{{scanEngine}}', c.scan?.engine ?? 'engine unrecorded')
      .replaceAll('{{evals}}', (c.evals ?? []).map((e) => `${e.agent} ${e.passed}/${e.total}`).join(' · ') || 'none published')
      .replaceAll('{{compat}}', (c.agentSupport ?? []).map((x) => x.agent + (x.evidence === 'evals-passing' ? ' ✓' : '')).join(' · ') || '—')
      .replaceAll('{{selfUrl}}', escapeHtml(selfUrl))
      .replaceAll('{{royalty}}', (c.terms?.payoutSplits ?? []).length
        ? `<div class="t dim">royalties: ${c.terms.payoutSplits.map((x) => escapeHtml(`${x.pct}% → ${x.to}`)).join(' · ')} (signed)</div>` : '')
      .replaceAll('{{standardShort}}', c.compliance?.status?.startsWith('compliant') ? 'agent-skills/v1 ✓' : 'not validated')
      .replaceAll('{{standard}}', c.compliance?.status?.startsWith('compliant')
        ? `spec: agent-skills/v1 ✓ — validated by ${c.compliance?.engine?.includes('official') ? 'the official reference validator (skills-ref)' : 'an exact port of the reference validator'}`
        : 'spec: not validated')
      .replaceAll('{{installs}}', String(installs))
      .replaceAll('{{updated}}', updatedAgo)
      .replaceAll('{{verified}}', skill.capabilitySig ? `✓ signed release · key ${sha256(identity.publicKeyPem).slice(0, 8)}` : '— unsigned')
      .replaceAll('{{versions}}', versions)
      .replaceAll('{{readme}}', readmeHtml);
    res.type('html').send(html);
  });

  app.get('/skills/:slug', (req, res) => res.redirect(301, `/s/${encodeURIComponent(req.params.slug)}`));

  app.get('/', (_req, res) => {
    const cards = store.listSkills().map((sk) => `
      <a class="card" href="/s/${escapeHtml(sk.slug)}">
        <div class="row"><b>${escapeHtml(sk.name)}</b><span>${sk.price === 0 ? 'Free' : '$' + (sk.price / 100).toFixed(2)}</span></div>
        <p>${escapeHtml(sk.description ?? '')}</p>
        <div class="meta">v${escapeHtml(sk.version)} · ${escapeHtml(sk.creator)}</div>
      </a>`).join('\n');
    const html = readFileSync(join(__dirname, '..', 'public', 'storefront.html'), 'utf8')
      .replaceAll('{{stats}}', (() => {
        const paid = Object.values(store.data.orders).filter((o) => o.status === 'paid');
        const n = store.listSkills().length;
        return `${n} skill${n === 1 ? '' : 's'} · ${paid.filter((o) => !o.revoked).length} active licenses · $${(paid.reduce((t, o) => t + (o.amount ?? 0), 0) / 100).toFixed(2)} transacted`;
      })())
      .replaceAll('{{cards}}', cards || '<p class="empty">Nothing published yet.</p>');
    res.type('html').send(html);
  });

  app.get('/buy/:slug', (req, res) => {
    const skill = store.getSkill(req.params.slug);
    if (!skill) return res.status(404).send('Not found');
    const html = readFileSync(join(__dirname, '..', 'public', 'checkout.html'), 'utf8')
      .replaceAll('{{name}}', escapeHtml(skill.name))
      .replaceAll('{{slug}}', escapeHtml(skill.slug))
      .replaceAll('{{description}}', escapeHtml(skill.description ?? ''))
      .replaceAll('{{price}}', skill.price === 0 ? 'Free' : `$${(skill.price / 100).toFixed(2)}`)
      .replaceAll('{{version}}', escapeHtml(skill.version))
            .replaceAll('{{creator}}', escapeHtml(skill.creator))
      .replaceAll('{{paymentBanner}}',
        skill.price === 0 ? ''
        : provider.isDevPaidMode ? '<div class="devbanner">⚠ Development checkout — no real payment is taken. This paid skill will be granted for free.</div>'
        : !provider.canChargePaid ? '<div class="devbanner err">Payments are not configured for this registry. This skill cannot be purchased yet.</div>'
        : '');
    res.type('html').send(html);
  });

  app.get('/thanks', (_req, res) => {
    res.type('html').send(readFileSync(join(__dirname, '..', 'public', 'thanks.html'), 'utf8'));
  });

  // ---------- purchase ----------
  app.post('/api/checkout/:slug', limitCheckout, async (req, res) => {
    const skill = store.getSkill(req.params.slug);
    const { email } = req.body ?? {};
    if (!skill) return res.status(404).json({ error: 'not found' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });

    const checkout = await provider.createCheckout({ skill, email });
    if (checkout.error) return res.status(checkout.status ?? 503).json({ error: checkout.error });
    if (!checkout.instant && checkout.sessionId) {
      // Freeze the terms of THIS session before the buyer leaves. The seller
      // may republish at a new price while the buyer sits on the Stripe page;
      // the webhook must settle against what the buyer actually agreed to.
      store.createCheckoutIntent({
        sessionId: checkout.sessionId,
        slug: skill.slug,
        version: skill.version ?? null,
        capabilityDigest: skill.capability?.digest ?? null,
        email,
        amount: skill.price,
        currency: skill.currency ?? 'usd',
        expiresAt: checkout.expiresAt ?? null,
      });
    }
    if (checkout.instant) {
      // Order + token are one fulfillment: commit both or neither (P1).
      let order, token;
      try {
        ({ order, token } = store.transaction(() => ({
          order: store.createOrder({ slug: skill.slug, email, amount: skill.price, provider: checkout.provider ?? provider.name, currency: skill.currency ?? 'usd' }),
          token: store.issueToken(email),
        })));
      } catch (e) {
        console.error(`  \u26a0 checkout: persistence failure for ${skill.slug} (${e.message}) — nothing committed`);
        return res.status(503).json({ error: 'temporary storage failure, please retry' });
      }
      return res.json({
        status: 'paid', order: order.id, token, install: installHint(siteUrl(req), skill.slug),
        ...(checkout.provider === 'dev-insecure' ? { devMode: true, warning: 'INSECURE dev payments: this paid skill was granted without charge' } : {}),
      });
    }
    res.json({ status: 'redirect', url: checkout.url });
  });

  app.post('/api/webhook/stripe', async (req, res) => {
    // 1. Verify the signature. Anything unverifiable is a hard 400 — the
    //    parser has no unsigned fallback, so a forged body never gets past here.
    let evt;
    try {
      evt = await provider.parseWebhook?.(req.body, req.headers['stripe-signature']);
    } catch {
      return res.status(400).json({ error: 'webhook signature verification failed' });
    }
    if (!evt) return res.json({ received: true });

    // 2. Idempotency: Stripe retries deliveries; each event id is handled once.
    if (store.hasProcessedEvent(evt.eventId)) {
      return res.json({ received: true, duplicate: true });
    }

    // 3–5 run as ONE SQLite transaction (P1: consistency under write failure).
    // Order creation, intent consumption, pending-refund consumption, refund
    // application, and processed-event marking either ALL commit or NONE do.
    // On failure the store resyncs memory from disk and we return 500 so
    // Stripe redelivers — a partially-persisted fulfillment (event consumed,
    // order lost at restart) can no longer exist.
    let body;
    try {
      body = store.transaction(() => {
        if (evt.kind === 'paid') {
          // 3. Settle against the IMMUTABLE checkout intent persisted when the
          //    session was created — never the current listing. Comparing to the
          //    live listing drops legitimate money whenever the seller reprices
          //    while a buyer sits on the Stripe page: buyer pays $29 for a $29
          //    session, listing is now $39, "mismatch", license never minted.
          const intent = store.getCheckoutIntent(evt.sessionId);
          let terms; // { slug, email, amount, currency, version, capabilityDigest }
          if (intent) {
            if (evt.amountTotal !== intent.amount || (evt.currency ?? '').toLowerCase() !== intent.currency) {
              // Stripe guarantees the session settles at its creation amount, so
              // this indicates tampering or corruption — not a price change.
              console.error(`  \u26a0 webhook: paid event ${evt.eventId} for session ${evt.sessionId} contradicts its checkout intent (got ${evt.amountTotal} ${evt.currency}, intent ${intent.amount} ${intent.currency}) — NOT minting, needs manual review`);
              store.markEventProcessed(evt.eventId);
              return { received: true, ignored: 'amount or currency contradicts checkout intent' };
            }
            terms = intent;
          } else {
            // Fallback (sessions created before intents existed, or restored
            // data): the old current-listing check, kept only as a last resort.
            const skill = store.getSkill(evt.slug);
            if (!skill || !evt.slug || !evt.email) {
              console.error(`  \u26a0 webhook: paid event ${evt.eventId} ignored — no checkout intent and unknown skill ${JSON.stringify(evt.slug ?? null)} or missing email`);
              store.markEventProcessed(evt.eventId);
              return { received: true, ignored: 'unknown skill or missing email' };
            }
            const expectedCurrency = (skill.currency ?? 'usd').toLowerCase();
            if (evt.amountTotal !== skill.price || (evt.currency ?? '').toLowerCase() !== expectedCurrency) {
              console.error(`  \u26a0 webhook: paid event ${evt.eventId} for ${skill.slug} ignored — NO CHECKOUT INTENT and amount/currency mismatch vs current listing (got ${evt.amountTotal} ${evt.currency}, listing ${skill.price} ${expectedCurrency}). If the price changed mid-checkout this buyer PAID and got nothing — reconcile manually in Stripe.`);
              store.markEventProcessed(evt.eventId);
              return { received: true, ignored: 'amount or currency mismatch (no checkout intent)' };
            }
            terms = { slug: skill.slug, email: evt.email, amount: skill.price, currency: expectedCurrency, version: skill.version ?? null, capabilityDigest: skill.capability?.digest ?? null };
          }
          // 4. providerRef is unique — a replayed session/payment_intent under a
          //    fresh event id still resolves to the one existing order.
          const order = store.createOrder({ slug: terms.slug, email: terms.email, amount: terms.amount, provider: 'stripe', providerRef: evt.providerRef, currency: terms.currency });
          // Record what was actually bought — survives later republishes.
          if (terms.version || terms.capabilityDigest) {
            order.purchasedVersion ??= terms.version;
            order.purchasedDigest ??= terms.capabilityDigest;
            store.saveOrder(order.id);
          }
          store.deleteCheckoutIntent(evt.sessionId); // settled; intent has served its purpose
          // 5. Out-of-order delivery: if refund webhooks beat this one, apply the
          //    refund state that accumulated while the order didn't exist yet.
          const pending = store.takePendingRefund(evt.providerRef);
          if (pending) {
            for (const [refundId, amount] of Object.entries(pending.refundIds ?? {})) store.applyRefund(order.id, { refundId, amount });
            store.applyRefund(order.id, { cumulative: pending.cumulative, full: !!pending.full });
          }
        } else if (evt.kind === 'refunded') {
          // Track refund money cumulatively; applyRefund revokes ONLY once the
          // captured amount is fully refunded. A partial goodwill refund keeps
          // the license and books only the actual refunded cents.
          const o = store.ordersByProviderRef(evt.providerRef) ?? (evt.paymentIntent ? store.ordersByProviderRef(evt.paymentIntent) : null);
          const refundInfo = { refundId: evt.refundId ?? null, amount: evt.amount ?? 0, cumulative: evt.cumulative ?? null, full: !!evt.full };
          if (o) store.applyRefund(o.id, refundInfo);
          else store.addPendingRefund(evt.paymentIntent ?? evt.providerRef, refundInfo); // refund arrived before its order
        }
        store.markEventProcessed(evt.eventId);
        return { received: true };
      });
    } catch (e) {
      console.error(`  \u26a0 webhook: persistence failure on ${evt.eventId} (${e.message}) — nothing committed, returning 500 so Stripe redelivers`);
      return res.status(500).json({ error: 'persistence failure, event not processed' });
    }
    res.json(body);
  });

  // ---------- activation (device-auth style) ----------
  app.post('/api/activate/start', limitActivateIp, limitActivateEmail, async (req, res) => {
    const { email } = req.body ?? {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const code = store.createActivation(email);
    if (env.SMTP_URL) {
      try {
        const { default: nodemailer } = await import('nodemailer'); // optional dep
        await nodemailer.createTransport(env.SMTP_URL).sendMail({
          from: env.SMTP_FROM ?? 'licenses@localhost',
          to: email,
          subject: 'Your activation code',
          text: `Your device activation code: ${code}\nIt expires in 15 minutes.`,
        });
        return res.json({ sent: true });
      } catch (e) {
        return res.status(500).json({ error: 'activation email failed: ' + e.message });
      }
    }
    if (env.ALLODIC_DEV_CODES === '1') return res.json({ sent: true, code }); // dev/test ONLY
    res.status(503).json({ error: 'activation requires SMTP_URL (or ALLODIC_DEV_CODES=1 for local dev)' });
  });

  app.post('/api/activate/finish', limitActivateIp, (req, res) => {
    // Consuming the one-shot code and minting the token must be atomic: a
    // write failure between them would burn the code without issuing a token.
    try {
      const token = store.transaction(() => {
        const a = store.consumeActivation(req.body?.code);
        if (!a) return null;
        return store.issueToken(a.email);
      });
      if (!token) return res.status(400).json({ error: 'invalid or expired code' });
      res.json({ token });
    } catch (e) {
      console.error(`  \u26a0 activation: persistence failure (${e.message}) — code not consumed`);
      res.status(503).json({ error: 'temporary storage failure, please retry' });
    }
  });

  // ---------- entitlement-gated delivery ----------
  const entitle = (req, res, slug) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const email = store.emailForToken(token);
    if (!email) { res.status(401).json({ error: 'activate first: POST /api/activate/start' }); return null; }
    const order = store.ordersByEmail(email).find((o) => o.slug === slug && o.status === 'paid' && !o.revoked);
    if (!order) { res.status(402).json({ error: 'no active license for this skill', buy: `/buy/${slug}` }); return null; }
    return order;
  };

  app.get('/api/bundle/:slug', (req, res) => {
    const skill = store.getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: 'not found' });
    const order = entitle(req, res, skill.slug);
    if (!order) return;

    const fingerprint = deriveFingerprint(order.id, identity.fingerprintSecret);
    const varied = {};
    const masterFiles = Object.fromEntries(
      Object.entries(skill.files).map(([p, b64]) => {
        let buf = Buffer.from(b64, 'base64');
        // Layer 1 (semantic): collapse canary slots per buyer BEFORE anything ships.
        if (p.endsWith('.md')) {
          const r = renderCanaryCopy(buf.toString('utf8'), fingerprint);
          if (r.choices.length) varied[p] = r.choices.map((c) => c.picked);
          buf = Buffer.from(r.content);
        }
        return [p, buf];
      }),
    );
    const bundle = buildBuyerBundle({
      masterFiles,
      varied: Object.keys(varied).length ? varied : null,
      skillName: skill.name,
      version: skill.version,
      orderId: order.id,
      fingerprintSecret: identity.fingerprintSecret,
      privateKeyPem: identity.privateKeyPem,
      creator: skill.creator,
      capabilityDigest: skill.capability?.digest ?? null,
    });
    res.json(bundle);
  });

  app.get('/api/updates/:slug', (req, res) => {
    const skill = store.getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: 'not found' });
    const order = entitle(req, res, skill.slug);
    if (!order) return;
    const current = Store.clampStr(req.query.version ?? '0.0.0');
    order.lastSeenVersion = current; // client-supplied: length-capped before it lands on the order row
    order.lastSeenAt = new Date().toISOString();
    store.saveOrder(order.id);
    // Semver ordering: an update exists only when the published version is
    // STRICTLY GREATER — a published downgrade is never offered to buyers.
    // Unparseable versions (pre-gate skills, garbage clients) fall back to
    // inequality so old installs aren't stranded.
    const updateAvailable = (validSemver(skill.version) && validSemver(current))
      ? gtSemver(skill.version, current)
      : skill.version !== current;
    res.json({ latest: skill.version, updateAvailable });
  });

  // Resolve skill + license before any per-license limiting: the limiter key
  // is the server-issued order id, which only exists after auth succeeds.
  const entitleTelemetry = (req, res, next) => {
    const skill = store.getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: 'not found' });
    const order = entitle(req, res, skill.slug);
    if (!order) return; // entitle already sent 401/402
    req.skill = skill;
    req.order = order;
    next();
  };

  app.post('/api/reports/:slug', limitTelemetryIp, entitleTelemetry, limitTelemetryOrder, (req, res) => {
    const { skill, order } = req;
    const r = req.body ?? {};
    if (r.format !== 'allodic-report/1') return res.status(400).json({ error: 'unknown report format' });
    // Structural allow-list AND numeric/length bounds: counts must be finite
    // non-negative integers (capped), strings are truncated, and at most
    // Store.MAX_AGENT_KEYS agent entries are read per report. The fold applies
    // the same bounds again for the cross-report aggregate (defense in depth —
    // it also runs on legacy data at migration time).
    const clean = {
      order: order.id, slug: skill.slug, version: Store.clampStr(r.version),
      sessions: Store.clampCount(r.sessions), agents: {},
      firstSeen: Store.clampStr(r.firstSeen) || null, lastSeen: Store.clampStr(r.lastSeen) || null,
      receivedAt: new Date().toISOString(),
    };
    for (const [a, n] of Object.entries(r.agents ?? {}).slice(0, Store.MAX_AGENT_KEYS)) {
      const count = Store.clampCount(n);
      if (count) clean.agents[Store.clampStr(a)] = count;
    }
    store.addReport(clean);
    res.json({ ok: true, stored: clean });
  });

  app.post('/api/events/:slug', limitTelemetryIp, entitleTelemetry, limitTelemetryOrder, (req, res) => {
    const { skill, order } = req;
    const { event, version, agents } = req.body ?? {};
    if (!['install', 'update'].includes(event)) return res.status(400).json({ error: 'unknown event' });
    store.addEvent({
      slug: skill.slug, order: order.id, event, version: Store.clampStr(version),
      agents: (Array.isArray(agents) ? agents : []).slice(0, 10).map((a) => Store.clampStr(a)),
      at: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  app.get('/api/insights/:slug', requireAdmin, (req, res) => {
    const slug = req.params.slug;
    const skill = store.getSkill(slug);
    const orders = Object.values(store.data.orders).filter((o) => o.slug === slug);
    const active = orders.filter((o) => o.status === 'paid' && !o.revoked);
    const versionDist = {};
    for (const o of active) {
      const v = o.lastSeenVersion ?? 'never-checked';
      versionDist[v] = (versionDist[v] ?? 0) + 1;
    }
    // Exact aggregates: totals are folded at append time, so they stay
    // correct after the bounded recent-list buffers rotate.
    const ut = store.data.usageTotals[slug];
    const usage = ut?.reports ? { reporters: Object.keys(ut.byOrder ?? {}).length, sessions: ut.sessions, byAgent: ut.byAgent } : null;
    const et = store.data.eventTotals[slug] ?? { installs: 0, updates: 0, installsByAgent: {} };
    const installsByAgent = et.installsByAgent;
    const updates = et.updates;
    // Money is aggregated from ACTUAL orders (each records amount + currency
    // at purchase time), never from count × current listing price — that
    // breaks under price changes, refunds, revocations, and free orders.
    const finance = {};
    for (const o of orders) {
      const cur = o.currency ?? skill?.currency ?? 'usd';
      const f = (finance[cur] ??= { currency: cur, grossCents: 0, refundedCents: 0, refundedCount: 0, manuallyRevoked: 0, activeLicenses: 0 });
      f.grossCents += o.amount ?? 0;
      // Refunded money = the cumulative amount actually returned, NOT the
      // whole order: a $1 goodwill refund on a $100 order books $1. Orders
      // revoked as refunds before per-refund tracking existed carry no
      // amountRefunded — treat those as fully refunded (legacy behavior).
      let refunded = o.amountRefunded ?? 0;
      if (o.revoked && (o.revokedReason ?? 'refund') === 'refund' && refunded === 0) refunded = o.amount ?? 0;
      refunded = Math.min(refunded, o.amount ?? 0);
      if (refunded > 0) { f.refundedCents += refunded; f.refundedCount++; }
      if (o.revoked) {
        if ((o.revokedReason ?? 'refund') !== 'refund') f.manuallyRevoked++; // license pulled, money kept — stays in net
      } else {
        f.activeLicenses++;
      }
    }
    const splits = skill?.capability?.terms?.payoutSplits ?? [];
    for (const f of Object.values(finance)) {
      f.netCents = f.grossCents - f.refundedCents;
      f.royaltyBasisCents = f.netCents;
      f.royalties = splits.map((sp) => ({ pct: sp.pct, to: sp.to, accruedCents: Math.floor((f.netCents * sp.pct) / 100) }));
    }
    res.json({
      slug,
      registry: {
        sales: orders.length, active: active.length,
        revoked: orders.filter((o) => o.revoked).length,
        finance: Object.values(finance),
        versionDistribution: versionDist,
        installsByAgent,
        updatesDelivered: updates,
      },
      optInUsage: usage,
    });
  });

  // ---------- creator surface ----------
  app.post('/api/skills', requireAdmin, async (req, res) => {
    const { slug, name, description, version, price, creator, files, scorecard } = req.body;
    if (!slug || !files?.['SKILL.md']) return res.status(400).json({ error: 'slug and files["SKILL.md"] required' });
    // v0.3: scan what buyers' agents will see (neutral canary render)
    const rawFiles = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, Buffer.from(b, 'base64')]));
    const neutralFiles = Object.fromEntries(Object.entries(rawFiles).map(([p, b]) =>
      [p, p.endsWith('.md') ? Buffer.from(renderNeutralCopy(b.toString('utf8'))) : b]));
    const compliance = checkCompliance(rawFiles, { dirName: slug });
    if (compliance.status === 'non-compliant') {
      return res.status(422).json({
        error: compliance.spec.ok ? 'allodic release requirements not met' : 'not compliant with agent-skills/v1',
        spec: compliance.spec, allodicRequirements: compliance.allodic.errors,
      });
    }
    // ---- SKILL.md is the single source of commercial truth (P0.3) ----
    // The signed capability terms come from SKILL.md; the listing, the
    // Stripe charge, the update comparison, and the benchmark gate must be
    // built from the SAME parse. Duplicated request fields remain accepted
    // for wire compatibility but any divergence is refused: a buggy or
    // modified client can never sell one thing while signing another.
    const meta = parseMeta(rawFiles['SKILL.md'].toString('utf8'));
    let derivedPrice;
    try { derivedPrice = parsePrice(meta); }
    catch (e) { return res.status(422).json({ error: e.message }); }
    const derived = {
      slug: meta.name,
      name: meta.name,
      description: meta.description ?? '',
      version: meta.metadata?.version,
      price: derivedPrice,
      creator: meta.metadata?.author ?? creator ?? 'creator',
    };
    const diverges = [];
    const differs = (label, reqVal, derVal) => { if (reqVal !== undefined && reqVal !== null && String(reqVal) !== String(derVal)) diverges.push(`${label}: request "${reqVal}" vs SKILL.md "${derVal}"`); };
    differs('slug', slug, derived.slug);
    differs('name', name, derived.name);
    differs('description', description, derived.description);
    differs('version', version, derived.version);
    if (price !== undefined && price !== null && Number(price) !== derived.price) diverges.push(`price: request ${price} vs SKILL.md ${derived.price} cents (the signed terms)`);
    if (meta.metadata?.author && creator && creator !== meta.metadata.author) diverges.push(`creator: request "${creator}" vs SKILL.md metadata.author "${meta.metadata.author}"`);
    if (diverges.length) {
      return res.status(422).json({
        error: 'request fields diverge from SKILL.md — the signed terms derive from SKILL.md and everything sold must match them',
        diverges,
      });
    }
    // Engine chain: SkillSpector (NVIDIA, static-only) when installed, else
    // the builtin ruleset. ALLODIC_SCANNER=builtin forces the fallback.
    const scan = (env.ALLODIC_SCANNER === 'builtin' ? null : scanSkillSpector(neutralFiles)) ?? scanSkill(neutralFiles);
    scan.engine ??= 'allodic-builtin';
    // Optional external scanner (vendor-agnostic webhook; see docs/DEPLOY.md).
    // The response is UNTRUSTED INPUT: the timeout covers the ENTIRE exchange
    // including the body (headers-then-stall used to hold publish forever),
    // the body is size-capped, status and content-type are validated, and
    // merged findings are capped in count and field length — they persist on
    // the skill, so an unbounded merge would be a store-growth vector.
    if (env.EXTERNAL_SCAN_URL) {
      try {
        const ext = await fetchJsonBounded(env.EXTERNAL_SCAN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(env.EXTERNAL_SCAN_KEY ? { authorization: `Bearer ${env.EXTERNAL_SCAN_KEY}` } : {}) },
          body: JSON.stringify({ name: derived.name, version: derived.version, files }),
        }, {
          timeoutMs: Number(env.EXTERNAL_SCAN_TIMEOUT_MS) || 10000,
          maxBytes: Number(env.EXTERNAL_SCAN_MAX_BYTES) || 1_000_000,
        });
        const raw = Array.isArray(ext.findings) ? ext.findings : [];
        for (const f of raw.slice(0, MAX_EXT_FINDINGS)) {
          scan.findings.push({
            rule: ('ext:' + String(f?.rule ?? 'finding')).slice(0, 80),
            severity: f?.severity === 'critical' ? 'critical' : 'warn',
            path: String(f?.path ?? 'SKILL.md').slice(0, 200),
            why: String(f?.why ?? '').slice(0, 200),
            excerpt: '',
          });
        }
        if (raw.length > MAX_EXT_FINDINGS) {
          scan.findings.push({ rule: 'ext:truncated', severity: 'warn', path: 'SKILL.md', why: `external scanner returned ${raw.length} findings; kept the first ${MAX_EXT_FINDINGS}`, excerpt: '' });
        }
        scan.criticals = scan.findings.filter((f) => f.severity === 'critical').length;
        scan.status = (scan.blocked || scan.criticals) ? 'blocked' : scan.findings.length ? 'warnings' : 'clean';
        scan.external = 'ok';
      } catch (e) {
        scan.external = 'error: ' + (e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : e.message);
      }
    }
    if (scan.status === 'blocked') {
      return res.status(422).json({ error: 'publish blocked by safety scan', findings: scan.findings });
    }
    let evalSummary = null;
    // Version monotonicity: buyers' update semantics depend on it. A version
    // that does not strictly increase is refused — except a byte-identical
    // republish of the current version, which is idempotent and harmless.
    // ALLODIC_ALLOW_VERSION_ROLLBACK=1 is the explicit local-dev escape.
    const existing = store.getSkill(slug);
    if (existing && env.ALLODIC_ALLOW_VERSION_ROLLBACK !== '1') {
      const bothValid = validSemver(derived.version) && validSemver(existing.version);
      const increases = bothValid ? gtSemver(derived.version, existing.version) : derived.version !== existing.version;
      if (!increases) {
        const sameContent = derived.version === existing.version
          && existing.capability?.digest === skillContentHashOf(files);
        if (!sameContent) {
          return res.status(422).json({
            error: `version must increase (semver): published is ${existing.version}, submitted ${derived.version}. Downgrades confuse buyers' update checks; bump the version instead.`,
          });
        }
      }
    }
    // Benchmark gate, enforced server-side (a modified client cannot skip it):
    // paid skills require a passing, candidate-explicit scorecard.
    if (derived.price > 0) {
      if (!scorecard) return res.status(422).json({ error: 'paid skills require a benchmark scorecard (evals/tasks.json + a runner) — benchmarks are a publish gate' });
      if (scorecard.passed !== scorecard.total) return res.status(422).json({ error: `benchmark gate failed: ${scorecard.passed}/${scorecard.total} tasks passing — all must pass to publish a paid skill` });
      if (!scorecard.runner?.candidateExplicit) return res.status(422).json({ error: 'scorecard does not attest explicit candidate execution — update the allodic CLI and re-run evals' });
    }
    if (scorecard && files['evals/tasks.json'] === undefined) {
      return res.status(422).json({ error: 'scorecard submitted without its evals/tasks.json — tasks must ship so any holder can reproduce' });
    }
    if (scorecard) {
      const raw = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, Buffer.from(b, 'base64')]));
      if (scorecard.skillContentHash !== skillContentHash(raw)) {
        return res.status(400).json({ error: 'eval scorecard does not match this skill content' });
      }
      const signed = signScorecard(scorecard, identity.privateKeyPem);
      evalSummary = { passed: scorecard.passed, total: scorecard.total, agent: scorecard.agent, ranAt: scorecard.ranAt, signed };
    }
    // Derivation commitments for canary-varied files: commit (public, signed)
    // binds the slot structure pre-sale; opening stays server-private.
    const derivationSecret = randomBytes(32).toString('hex');
    const derivationOpenings = {};
    let derivation = null;
    {
      const variedPaths = [];
      const arity = [];
      let commits = [];
      for (const [p, buf] of Object.entries(rawFiles)) {
        if (!p.endsWith('.md')) continue;
        const src = buf.toString('utf8');
        if (parseSlots(src).length === 0) continue;
        const d = buildDerivationCommitment(src, derivationSecret);
        variedPaths.push(p);
        arity.push(...d.arity);
        commits.push(`${p}:${d.commit}`);
        derivationOpenings[p] = { commit: d.commit, arity: d.arity, opening: d.opening };
      }
      if (variedPaths.length) {
        derivation = { commit: sha256(Buffer.from(commits.join('\n'))), varied: variedPaths, arity };
      }
    }
    const capability = buildCapabilityManifest({
      meta, files: rawFiles,
      scorecards: scorecard ? [scorecard] : [],
      scan, creator: derived.creator, derivation,
    });
    capability.compliance = { standard: compliance.standard, status: compliance.status, engine: compliance.spec.engine, passed: compliance.passed, total: compliance.total };
    const capabilitySig = signManifest(capability, identity.privateKeyPem);
    store.putSkill({ slug: derived.slug, name: derived.name, description: derived.description, version: derived.version, price: derived.price, creator: derived.creator, files,
      evals: evalSummary, capability, capabilitySig, derivationOpenings, scan: { status: scan.status, findings: scan.findings, engine: scan.engine, score: scan.score ?? null },
      updatedAt: new Date().toISOString() });
    const entitled = Object.values(store.data.orders)
      .filter((o) => o.slug === slug && o.status === 'paid' && !o.revoked).length;
    res.json({ ok: true, listing: `/s/${slug}`, buy: `/buy/${slug}`, entitled });
  });

  app.post('/api/trace', requireAdmin, (req, res) => {
    const { content } = req.body ?? {};
    const { frontmatter, covert } = extractFingerprint(content ?? '');
    const fp = covert ?? frontmatter;
    
    const order = fp ? store.orderByFingerprint(fp, (id) => deriveFingerprint(id, identity.fingerprintSecret)) : null;
    // Semantic layer: evidence, not a winner. Attribution is claimed only
    // when exactly one order is consistent with every surviving slot; ties
    // and partial matches are reported as inconclusive with all candidates.
    const VERDICT_RANK = { identified: 3, inconclusive: 2, 'insufficient-evidence': 1, 'no-match': 0 };
    let canary = null;
    let best = null;
    for (const skill of store.listSkills()) {
      const source = Buffer.from(skill.files['SKILL.md'], 'base64').toString('utf8');
      const cands = Object.values(store.data.orders).filter((o) => o.slug === skill.slug)
        .map((o) => ({ orderId: o.id, fingerprintHex: deriveFingerprint(o.id, identity.fingerprintSecret) }));
      if (!cands.length) continue;
      const t = traceCanary(content ?? '', source, cands);
      if (t.verdict === 'no-match') continue;
      const better = !canary
        || VERDICT_RANK[t.verdict] > VERDICT_RANK[canary.verdict]
        || (VERDICT_RANK[t.verdict] === VERDICT_RANK[canary.verdict] && t.stats.observedBits > canary.stats.observedBits);
      if (better) {
        canary = { skill: skill.slug, verdict: t.verdict, stats: t.stats,
                   match: t.match, consistent: t.consistent, topPartial: t.consistent.length ? null : t.ranked[0] ?? null };
        best = { source, observed: t.observedSlots,
                 fp: (t.match ?? t.consistent[0] ?? t.ranked[0]) ? deriveFingerprint((t.match ?? t.consistent[0] ?? t.ranked[0]).orderId, identity.fingerprintSecret) : null };
      }
    }
    // Enrich orders with email/date — the creator owns this data; the verdict
    // label, not omission, is what prevents false accusation.
    const enrich = (c) => {
      if (!c) return null;
      const o = store.getOrder(c.orderId);
      return { ...c, email: o?.email, purchasedAt: o?.createdAt, revoked: o?.revoked ?? false };
    };
    if (canary) {
      canary.match = enrich(canary.match);
      canary.consistent = canary.consistent.map(enrich);
      canary.topPartial = enrich(canary.topPartial);
    }
    let detail = null;
    if (req.body?.explain && best?.fp) {
      const slots = parseSlots(best.source);
      const { choices } = renderCanaryCopy(best.source, best.fp);
      detail = slots.map((sl, i) => ({
        slot: i, options: sl.options, expected: choices[i].picked, observed: best.observed[i],
      }));
    }
    res.json({
      canary,
      detail,
      fingerprint: fp,
      channels: { frontmatter: !!frontmatter, covert: !!covert },
      match: order ? { order: order.id, email: order.email, purchasedAt: order.createdAt, revoked: order.revoked } : null,
    });
  });

  // Dispute material: the derivation opening for a skill's varied files.
  // Admin-only — the creator hands this to an arbiter/buyer during a dispute;
  // publishing it would reveal slot positions and defeat tracing.
  app.get('/api/skills/:slug/derivation', requireAdmin, (req, res) => {
    const skill = store.getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: 'not found' });
    res.json({ slug: skill.slug, derivation: skill.capability?.derivation ?? null, openings: skill.derivationOpenings ?? {} });
  });

  app.post('/api/orders/:id/revoke', requireAdmin, (req, res) => {
    const o = store.revokeOrder(req.params.id, req.body?.reason === 'refund' ? 'refund' : 'manual');
    if (!o) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, order: o.id, revoked: true });
  });

  return { app, store, identity };
}

function skillContentHashOf(filesB64) {
  const raw = Object.fromEntries(Object.entries(filesB64 ?? {}).map(([p, b64]) => [p, Buffer.from(b64, 'base64')]));
  return skillContentHash(raw);
}

function publicSkill(s) {
  const { files, derivationOpenings, ...rest } = s; // openings are dispute-time material, never public
  return rest;
}
function installHint(origin, slug) {
  return `npx allodic add ${origin}/s/${slug}`;
}
function daysAgo(iso) {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
function renderMd(md) {
  const inline = (t) => t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = escapeHtml(md).replace(/^\s+/, '').split('\n');
  const out = [];
  let list = null; let para = []; let fence = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (fence !== null) {
      if (/^```/.test(line)) { out.push(`<pre>${fence.join('\n')}</pre>`); fence = null; }
      else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${Math.min(h[1].length + 1, 5)}>${inline(h[2])}</h${Math.min(h[1].length + 1, 5)}>`); continue; }
    const li = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) { flushPara(); (list ??= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    flushList(); para.push(line.trim());
  }
  flushPara(); flushList();
  if (fence) out.push(`<pre>${fence.join('\n')}</pre>`);
  return out.join('\n');
}
const MAX_EXT_FINDINGS = 100;
/**
 * fetch + parse JSON with the timeout covering the WHOLE exchange. A plain
 * `clearTimeout(timer); await r.json()` disarms the abort as soon as headers
 * arrive — a scanner that sends headers then stalls holds the publish route
 * open indefinitely. Here the same AbortController stays armed while the body
 * streams, the body is capped at maxBytes, and status + content-type are
 * validated before a byte is trusted.
 */
async function fetchJsonBounded(url, opts, { timeoutMs = 10000, maxBytes = 1_000_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const ctype = r.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(ctype)) throw new Error(`unexpected content-type "${ctype.slice(0, 60)}"`);
    if (!r.body) throw new Error('empty response body');
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); // still under the timer
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        ctl.abort();
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// ---- boot lives in bin/allodic-server.js (the published `allodic-server` executable) ----
