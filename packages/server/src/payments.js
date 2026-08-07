// allodic server — payment providers.
//
// `free`    : instant grant for $0 skills only. Always available.
// `stripe`  : real checkout sessions + webhook confirmation. Enabled the moment
//             STRIPE_SECRET_KEY is set. Lazily imported so `stripe` is an optional dep.
// `dev`     : instant grant for PAID skills — INSECURE, gated behind
//             ALLODIC_INSECURE_DEV_PAYMENTS=1, and surfaced in the UI. Never in prod.
//
// Fail-closed rule: a paid skill with no real provider returns 503, it is
// never given away for free by default.

export function makeProvider(env = process.env) {
  const devPaid = env.ALLODIC_INSECURE_DEV_PAYMENTS === '1';
  let stripe = null;
  if (env.STRIPE_SECRET_KEY) {
    if (!env.STRIPE_WEBHOOK_SECRET && !devPaid) {
      // Fail closed: without signature verification, anyone who can reach
      // /api/webhook/stripe can forge "payment completed" events and mint
      // licenses for free. Refuse to boot rather than run in that state.
      throw new Error(
        'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing. ' +
        'Refusing to start: unsigned webhooks would let anyone forge paid orders. ' +
        'Set STRIPE_WEBHOOK_SECRET (from the Stripe dashboard, or `stripe listen` locally). ' +
        'For local development without webhooks, set ALLODIC_INSECURE_DEV_PAYMENTS=1.'
      );
    }
    stripe = new StripeProvider(env);
  }
  return new Provider({ stripe, devPaid });
}

class Provider {
  constructor({ stripe, devPaid }) {
    this.stripe = stripe;
    this.devPaid = devPaid;
    this.name = stripe ? 'stripe' : devPaid ? 'dev-insecure' : 'free-only';
  }
  // True when this registry can actually take money for paid skills.
  get canChargePaid() { return !!this.stripe; }
  // True when paid skills are being granted for free (dev mode) — UI must show this.
  get isDevPaidMode() { return !this.stripe && this.devPaid; }
  // null = no Stripe; false = Stripe present but webhooks unverifiable (dev override only).
  get webhookVerification() { return this.stripe ? !!this.stripe.webhookSecret : null; }

  /** Returns {instant} | {instant:false,url} | {error, status}. */
  async createCheckout({ skill, email }) {
    if (skill.price === 0) return { instant: true, provider: 'free' };
    if (this.stripe) return this.stripe.createCheckout({ skill, email });
    if (this.devPaid) return { instant: true, provider: 'dev-insecure' };
    // fail closed: paid skill, no way to charge
    return { error: 'Payments are not configured for this registry', status: 503 };
  }
  parseWebhook(...a) { return this.stripe?.parseWebhook(...a) ?? null; }
}

class StripeProvider {
  name = 'stripe';
  constructor(env) {
    this.secretKey = env.STRIPE_SECRET_KEY;
    this.webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? null;
    this.baseUrl = env.BASE_URL ?? 'http://localhost:8787';
    this._stripe = null;
  }
  async stripe() {
    if (!this._stripe) {
      const { default: Stripe } = await import('stripe'); // optional dependency
      this._stripe = new Stripe(this.secretKey);
    }
    return this._stripe;
  }
  /** Returns { instant: false, url } — buyer completes payment on Stripe Checkout. */
  async createCheckout({ skill, email }) {
    const stripe = await this.stripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: skill.currency ?? 'usd',
          unit_amount: skill.price,
          product_data: { name: skill.name, description: skill.description },
        },
        quantity: 1,
      }],
      metadata: { slug: skill.slug, email },
      success_url: `${this.baseUrl}/thanks?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.baseUrl}/buy/${skill.slug}`,
    });
    return {
      instant: false, url: session.url, providerRef: session.id,
      sessionId: session.id,
      // Stripe sessions expire ≤24h after creation; expires_at is unix seconds.
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    };
  }
  /**
   * Verify a webhook and return a typed event:
   *   {kind:'paid', eventId, slug, email, providerRef, amountTotal, currency}
   * | {kind:'refunded', eventId, providerRef, paymentIntent}
   * | {kind:'ignored', eventId, reason}
   * Throws on missing/invalid signature — there is NO unsigned fallback.
   */
  async parseWebhook(rawBody, signature) {
    if (!this.webhookSecret) {
      // Only reachable under ALLODIC_INSECURE_DEV_PAYMENTS=1 (makeProvider
      // refuses to boot otherwise). Even then, never trust an unsigned body.
      const err = new Error('webhook rejected: STRIPE_WEBHOOK_SECRET is not configured');
      err.status = 400;
      throw err;
    }
    const stripe = await this.stripe();
    // Throws if the signature is missing, malformed, stale, or forged.
    const event = stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      // Async payment methods fire `completed` with payment_status 'unpaid';
      // money only actually moved when payment_status is 'paid'.
      if (s.payment_status !== 'paid') {
        return { kind: 'ignored', eventId: event.id, reason: `payment_status=${s.payment_status}` };
      }
      return {
        kind: 'paid',
        eventId: event.id,
        slug: s.metadata?.slug,
        email: s.metadata?.email ?? s.customer_email,
        // Prefer payment_intent as the canonical ref — refund events carry it too.
        providerRef: s.payment_intent ?? s.id,
        sessionId: s.id, // key into the persisted checkout intent
        amountTotal: s.amount_total,
        currency: s.currency,
      };
    }
    if (event.type === 'charge.refunded') {
      // Object is a Charge. amount_refunded is Stripe's CUMULATIVE refunded
      // total for the charge; Charge.refunded is true only when fully refunded.
      const c = event.data.object;
      return {
        kind: 'refunded', eventId: event.id,
        providerRef: c.payment_intent ?? c.charge ?? c.id,
        paymentIntent: c.payment_intent ?? null,
        cumulative: c.amount_refunded ?? null,
        full: c.refunded === true,
      };
    }
    if (event.type === 'refund.created') {
      // Object is a single Refund. Counted once by refund id; failed/canceled
      // refunds returned no money and must not revoke anything.
      const r = event.data.object;
      if (r.status === 'failed' || r.status === 'canceled') {
        return { kind: 'ignored', eventId: event.id, reason: `refund status=${r.status}` };
      }
      return {
        kind: 'refunded', eventId: event.id,
        providerRef: r.payment_intent ?? r.charge ?? r.id,
        paymentIntent: r.payment_intent ?? null,
        refundId: r.id,
        amount: r.amount ?? 0,
      };
    }
    return { kind: 'ignored', eventId: event.id, reason: `unhandled event type ${event.type}` };
  }
}
