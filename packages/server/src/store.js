// allodic server — node:sqlite store (no npm dependency: SQLite ships in Node).
//
// Memory-first, write-through: `store.data` remains the authoritative
// in-memory shape (routes and tests read it directly, unchanged), every
// mutation method writes through to SQLite rows, and `save()` performs a
// full transactional resync for legacy call sites that poke `data` directly.
//
// What SQLite buys over the previous flat JSON file:
//   - WAL crash recovery (a killed process never leaves a torn store)
//   - a real single-writer guarantee (EXCLUSIVE locking: a second server on
//     the same data dir fails fast instead of silently clobbering writes)
//   - schema versioning via PRAGMA user_version, with a migration ladder
//   - online boot backups via the sqlite backup API, rotated
// One-time migration imports an existing store.json and renames it.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 2;
const KV_TABLES = {
  skills: 'skills',
  orders: 'orders',
  tokens: 'tokens',
  activations: 'activations',
  webhook_events: 'webhookEvents',
  pending_refunds: 'pendingRefunds',
  checkout_intents: 'checkoutIntents',
  usage_totals: 'usageTotals',
  event_totals: 'eventTotals',
};
const ARRAY_TABLES = { events: 'events', reports: 'reports' };
const BACKUPS_KEPT = 3;

export class Store {
  constructor(path) {
    // Accepts the historical store.json path; the database lives beside it.
    this.jsonPath = path.endsWith('.json') ? path : join(path, 'store.json');
    this.dbPath = this.jsonPath.replace(/\.json$/, '.db');
    // 0700: the db (and its WAL/backups) holds bearer tokens and buyer PII.
    // mkdir's mode only applies to newly created dirs; chmod repairs old ones.
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.dbPath), 0o700); } catch { /* non-POSIX fs */ }
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=NORMAL');
      this.#initSchema();
      // Single writer: take and hold SQLite's exclusive lock for the process
      // lifetime. A second server on the same data dir fails at boot, loudly.
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE');
      this.#upsert('meta', 'boot_at', new Date().toISOString());
    } catch (e) {
      this.db.close();
      if (/locked|busy/i.test(e.message)) {
        throw new Error(`another allodic-server appears to be running on this data directory (${this.dbPath}). Refusing to start a second writer.`);
      }
      throw e;
    }

    const imported = this.#migrateFromJson();
    if (!imported) this.#load();
    this.#shapeDefaults();
    this.#backupRotate();
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  // ---- schema / migration ladder -----------------------------------------
  #initSchema() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v === 0) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`);
        for (const t of Object.keys(KV_TABLES)) {
          this.db.exec(`CREATE TABLE IF NOT EXISTS ${t}(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
        }
        for (const t of Object.keys(ARRAY_TABLES)) {
          this.db.exec(`CREATE TABLE IF NOT EXISTS ${t}(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)`);
        }
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    } else if (v > SCHEMA_VERSION) {
      throw new Error(`store schema is v${v}, this server understands v${SCHEMA_VERSION} — upgrade allodic-server`);
    }
    if (v === 1) {
      // v2: checkout intents — the immutable record of what a Stripe session
      // was created FOR (slug, version, digest, amount), so webhooks validate
      // against the terms at checkout time, never the mutable current listing.
      this.db.exec('BEGIN');
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS checkout_intents(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
        this.db.exec('PRAGMA user_version = 2');
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }

  #migrateFromJson() {
    const empty = this.db.prepare('SELECT (SELECT COUNT(*) FROM skills) + (SELECT COUNT(*) FROM orders) AS n').get().n === 0;
    if (!empty || !existsSync(this.jsonPath)) return false;
    this.data = JSON.parse(readFileSync(this.jsonPath, 'utf8'));
    this.#shapeDefaults();
    // Legacy JSON stores may predate write-time totals: fold once at import.
    if ((this.data.reports ?? []).length && !this.data._reportsFolded) {
      for (const r of this.data.reports) this.foldReport(r);
      this.data._reportsFolded = true;
    }
    if ((this.data.events ?? []).length && !this.data._eventsFolded) {
      for (const e of this.data.events) this.foldEvent(e);
      this.data._eventsFolded = true;
    }
    this.save(); // full resync imports everything transactionally
    renameSync(this.jsonPath, `${this.jsonPath}.migrated-${Date.now()}`);
    console.log(`  store: imported ${this.jsonPath} into ${this.dbPath} (json renamed, kept as a fallback)`);
    return true;
  }

  #load() {
    this.data = {};
    for (const [table, key] of Object.entries(KV_TABLES)) {
      const obj = {};
      for (const row of this.db.prepare(`SELECT k, v FROM ${table}`).all()) obj[row.k] = JSON.parse(row.v);
      this.data[key] = obj;
    }
    for (const [table, key] of Object.entries(ARRAY_TABLES)) {
      this.data[key] = this.db.prepare(`SELECT v FROM ${table} ORDER BY id`).all().map((r) => JSON.parse(r.v));
    }
    for (const row of this.db.prepare(`SELECT k, v FROM meta`).all()) {
      if (row.k.startsWith('_')) this.data[row.k] = JSON.parse(row.v); // fold flags
    }
  }

  #shapeDefaults() {
    this.data.skills ??= {}; this.data.orders ??= {}; this.data.tokens ??= {}; this.data.activations ??= {};
    this.data.webhookEvents ??= {}; this.data.pendingRefunds ??= {};
    this.data.checkoutIntents ??= {};
    this.data.usageTotals ??= {}; this.data.eventTotals ??= {};
    this.data.reports ??= []; this.data.events ??= [];
  }

  #backupRotate() {
    try {
      for (let i = BACKUPS_KEPT - 1; i >= 1; i--) {
        const from = `${this.dbPath}.bak.${i}`;
        if (existsSync(from)) renameSync(from, `${this.dbPath}.bak.${i + 1}`);
      }
      const bak = `${this.dbPath}.bak.1`;
      rmSync(bak, { force: true }); // VACUUM INTO refuses existing destinations
      // Synchronous online backup: consistent snapshot in one statement,
      // no async handle to race close(). Restore = copy a .bak over store.db.
      this.db.exec(`VACUUM INTO '${bak.replaceAll("'", "''")}'`);
    } catch (e) {
      console.warn(`  ~ store backup failed (server continues): ${e.message}`);
    }
  }

  // ---- write-through plumbing --------------------------------------------
  // Failure discipline (P1: memory must never outrun disk): every mutator
  // updates `this.data` then writes through. If ANY write fails (disk full,
  // I/O error), memory would be left serving state that was never persisted —
  // e.g. an order that exists until restart while its Stripe event stays
  // consumed. So: on write failure OUTSIDE a transaction, memory is resynced
  // from SQLite (the durable truth) before the error propagates; INSIDE a
  // transaction, the outermost handler rolls back SQLite first, then resyncs.
  // Either way the invariant on error-return is: memory === committed disk.
  #txDepth = 0;

  /** Resync in-memory state from SQLite. Only safe with no open transaction
   *  (an open tx would leak uncommitted rows into memory via this connection). */
  #resync() {
    try { this.#load(); this.#shapeDefaults(); }
    catch (e) { console.error(`  store: CRITICAL — memory resync after failed write also failed (${e.message}); state may be inconsistent until restart`); }
  }

  #write(run) {
    try { return run(); }
    catch (e) {
      if (this.#txDepth === 0) this.#resync(); // inside a tx: outer #tx rolls back, then resyncs
      throw e;
    }
  }

  #upsert(table, k, v) {
    return this.#write(() => this.db.prepare(`INSERT INTO ${table}(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(k, typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)));
  }
  #delete(table, k) { return this.#write(() => this.db.prepare(`DELETE FROM ${table} WHERE k = ?`).run(k)); }
  #append(table, v) { return this.#write(() => this.db.prepare(`INSERT INTO ${table}(v) VALUES(?)`).run(JSON.stringify(v))); }
  #trim(table, max) {
    return this.#write(() => this.db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`).run(max));
  }
  /** Reentrant: nested calls join the outermost transaction, so store methods
   *  that transact internally compose under a caller's transaction(). */
  #tx(fn) {
    if (this.#txDepth > 0) {
      this.#txDepth++;
      try { return fn(); } finally { this.#txDepth--; }
    }
    this.db.exec('BEGIN');
    this.#txDepth = 1;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      this.#txDepth = 0;
      return r;
    } catch (e) {
      this.#txDepth = 0;
      try { this.db.exec('ROLLBACK'); } catch { /* connection-level failure; resync below still applies */ }
      this.#resync();
      throw e;
    }
  }

  /**
   * Run several store mutations as ONE SQLite transaction: all-or-nothing on
   * disk, and on failure memory is restored to the committed state. Used by
   * payment fulfillment so order creation, refund consumption/application,
   * and processed-event marking can never partially persist.
   */
  transaction(fn) { return this.#tx(fn); }

  /** Full resync of the in-memory shape into SQLite, one transaction.
   *  Kept for call sites (tests, tooling) that mutate `data` directly. */
  save() {
    this.#tx(() => {
      for (const [table, key] of Object.entries(KV_TABLES)) {
        this.db.exec(`DELETE FROM ${table}`);
        const ins = this.db.prepare(`INSERT INTO ${table}(k, v) VALUES(?, ?)`);
        for (const [k, v] of Object.entries(this.data[key] ?? {})) ins.run(k, JSON.stringify(v));
      }
      for (const [table, key] of Object.entries(ARRAY_TABLES)) {
        this.db.exec(`DELETE FROM ${table}`);
        const ins = this.db.prepare(`INSERT INTO ${table}(v) VALUES(?)`);
        for (const v of this.data[key] ?? []) ins.run(JSON.stringify(v));
      }
      for (const flag of ['_reportsFolded', '_eventsFolded']) {
        if (this.data[flag] !== undefined) {
          this.db.prepare(`INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(flag, JSON.stringify(this.data[flag]));
        }
      }
    });
  }

  // ---- skills ----
  putSkill(skill) {
    const prev = this.data.skills[skill.slug];
    if (prev && prev.version !== skill.version) {
      skill.history = [...(prev.history ?? []), { version: prev.version, at: prev.updatedAt }];
    } else if (prev) {
      skill.history = prev.history ?? [];
    } else {
      skill.history = [];
    }
    this.data.skills[skill.slug] = skill;
    this.#upsert('skills', skill.slug, skill);
  }
  getSkill(slug) { return this.data.skills[slug] ?? null; }
  listSkills() { return Object.values(this.data.skills); }

  // ---- orders ----
  createOrder({ slug, email, amount, provider, providerRef = null, currency = 'usd' }) {
    if (providerRef) {
      const existing = this.ordersByProviderRef(providerRef);
      if (existing) return existing;
    }
    const id = 'ord_' + randomBytes(6).toString('hex');
    const order = {
      id, slug, email: email.toLowerCase(), amount, currency, provider, providerRef,
      status: 'paid',
      createdAt: new Date().toISOString(),
      revoked: false,
    };
    this.data.orders[id] = order;
    this.#upsert('orders', id, order);
    return order;
  }
  getOrder(id) { return this.data.orders[id] ?? null; }
  ordersByEmail(email) {
    return Object.values(this.data.orders).filter((o) => o.email === email.toLowerCase());
  }
  ordersByProviderRef(ref) {
    if (!ref) return null;
    return Object.values(this.data.orders).find((o) => o.providerRef === ref) ?? null;
  }
  orderByFingerprint(fp, deriveFn) {
    return Object.values(this.data.orders).find((o) => deriveFn(o.id) === fp) ?? null;
  }
  /** Persist a single (possibly directly-mutated) order row. */
  saveOrder(id) {
    const o = this.data.orders[id];
    if (o) this.#upsert('orders', id, o);
  }

  revokeOrder(id, reason = 'manual') {
    const o = this.data.orders[id];
    if (o) {
      o.revoked = true;
      o.revokedReason = reason;
      o.revokedAt = new Date().toISOString();
      this.#upsert('orders', id, o);
    }
    return o;
  }

  /**
   * Record refund money against an order. Revokes the license ONLY when the
   * captured amount has been fully refunded — a $1 goodwill refund on a $100
   * order must neither kill the license nor book $100 as refunded.
   *
   *   refundId + amount : one specific refund (re_...), applied once (deduped)
   *   cumulative        : Stripe's authoritative charge.amount_refunded —
   *                       amountRefunded is raised to it, never double-added
   *   full              : the charge is fully refunded (Charge.refunded === true)
   */
  applyRefund(id, { refundId = null, amount = 0, cumulative = null, full = false } = {}) {
    const o = this.data.orders[id];
    if (!o) return null;
    o.amountRefunded ??= 0;
    o.refundIds ??= {};
    if (refundId && !(refundId in o.refundIds)) {
      o.refundIds[refundId] = amount;
      o.amountRefunded += amount;
    }
    if (cumulative != null) o.amountRefunded = Math.max(o.amountRefunded, cumulative);
    if (full) o.amountRefunded = Math.max(o.amountRefunded, o.amount ?? 0);
    o.amountRefunded = Math.min(o.amountRefunded, o.amount ?? o.amountRefunded); // Stripe caps refunds at the charge; clamp defensively
    if ((o.amount ?? 0) > 0 && o.amountRefunded >= o.amount && !o.revoked) {
      o.revoked = true;
      o.revokedReason = 'refund';
      o.revokedAt = new Date().toISOString();
    }
    this.#upsert('orders', id, o);
    return o;
  }

  // ---- webhook idempotency ----
  hasProcessedEvent(eventId) { return !!eventId && !!this.data.webhookEvents[eventId]; }
  markEventProcessed(eventId) {
    if (!eventId) return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const pruned = [];
    for (const [id, at] of Object.entries(this.data.webhookEvents)) {
      if (at < cutoff) { delete this.data.webhookEvents[id]; pruned.push(id); }
    }
    this.data.webhookEvents[eventId] = Date.now();
    this.#tx(() => {
      for (const id of pruned) this.#delete('webhook_events', id);
      this.#upsert('webhook_events', eventId, this.data.webhookEvents[eventId]);
    });
  }

  // ---- pending refunds (refund webhook arrived before its paid event) ----
  // Each entry accumulates the same shape applyRefund consumes, so a late
  // order inherits exactly the refund state that arrived early.
  addPendingRefund(providerRef, { refundId = null, amount = 0, cumulative = null, full = false } = {}) {
    if (!providerRef) return;
    const prev = this.data.pendingRefunds[providerRef];
    // Legacy rows were bare timestamps; their old semantics were "revoke fully".
    const p = (prev && typeof prev === 'object') ? prev : { at: Date.now(), refundIds: {}, cumulative: null, full: typeof prev === 'number' };
    p.refundIds ??= {};
    if (refundId && !(refundId in p.refundIds)) p.refundIds[refundId] = amount;
    if (cumulative != null) p.cumulative = Math.max(p.cumulative ?? 0, cumulative);
    if (full) p.full = true;
    this.data.pendingRefunds[providerRef] = p;
    this.#upsert('pending_refunds', providerRef, p);
  }
  /** Returns the accumulated pending-refund record, or null. */
  takePendingRefund(providerRef) {
    const p = providerRef ? this.data.pendingRefunds[providerRef] : null;
    if (!p) return null;
    delete this.data.pendingRefunds[providerRef];
    this.#delete('pending_refunds', providerRef);
    if (typeof p !== 'object') return { refundIds: {}, cumulative: null, full: true }; // legacy timestamp row
    return p;
  }

  // ---- checkout intents ----
  // The immutable terms of a Stripe Checkout session, persisted BEFORE the
  // buyer is redirected. The payment webhook validates against this record —
  // never the current listing, which the seller may have repriced mid-checkout.
  static INTENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // keep 7d past expiry: webhook retries span days

  createCheckoutIntent({ sessionId, slug, version = null, capabilityDigest = null, email, amount, currency = 'usd', expiresAt = null }) {
    if (!sessionId) return null;
    const now = Date.now();
    const intent = {
      sessionId, slug, version, capabilityDigest,
      email: email.toLowerCase(), amount, currency: currency.toLowerCase(),
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt ?? new Date(now + 24 * 60 * 60 * 1000).toISOString(), // Stripe sessions live ≤24h
    };
    // Prune long-dead intents (abandoned checkouts) on the write path.
    const cutoff = now - Store.INTENT_GRACE_MS;
    const pruned = [];
    for (const [id, it] of Object.entries(this.data.checkoutIntents)) {
      if (Date.parse(it.expiresAt ?? 0) < cutoff) { delete this.data.checkoutIntents[id]; pruned.push(id); }
    }
    this.data.checkoutIntents[sessionId] = intent;
    this.#tx(() => {
      for (const id of pruned) this.#delete('checkout_intents', id);
      this.#upsert('checkout_intents', sessionId, intent);
    });
    return intent;
  }
  getCheckoutIntent(sessionId) { return sessionId ? (this.data.checkoutIntents[sessionId] ?? null) : null; }
  deleteCheckoutIntent(sessionId) {
    if (!sessionId || !this.data.checkoutIntents[sessionId]) return;
    delete this.data.checkoutIntents[sessionId];
    this.#delete('checkout_intents', sessionId);
  }

  // ---- telemetry: exact totals + bounded buffers ----
  static MAX_REPORTS = 1000;
  static MAX_EVENTS = 5000;
  // Aggregate maps accept client-supplied keys, so they get hard bounds the
  // raw buffers already have (P1: "no token can grow the store without
  // limit" must hold for the folds too, not just the rotating buffers):
  //   - at most MAX_AGENT_KEYS distinct client-named keys per skill; further
  //     novel keys fold into the reserved '(other)' bucket, so totals stay
  //     exact in aggregate while the key set stays fixed
  //   - keys truncated to MAX_TELEMETRY_STR bytes
  //   - counters must be finite, non-negative integers, capped per increment
  static MAX_AGENT_KEYS = 20;
  static MAX_TELEMETRY_STR = 64;
  static MAX_COUNT = 1_000_000_000;
  static OTHER_KEY = '(other)';

  static clampCount(n) {
    n = Number(n);
    if (!Number.isFinite(n) || n <= 0) return 0; // negatives, NaN, ±Infinity → 0
    return Math.min(Math.floor(n), Store.MAX_COUNT);
  }
  static clampStr(s, max = Store.MAX_TELEMETRY_STR) { return String(s ?? '').slice(0, max); }
  /** Resolve a client-supplied key against a bounded aggregate map. */
  static #foldKey(map, key) {
    key = Store.clampStr(key);
    if (key in map) return key;
    // Cap counts client-named keys; '(other)' rides above it as the overflow bucket.
    const named = Object.keys(map).filter((k) => k !== Store.OTHER_KEY).length;
    return named < Store.MAX_AGENT_KEYS ? key : Store.OTHER_KEY;
  }

  foldReport(r) {
    const t = (this.data.usageTotals[r.slug] ??= { reports: 0, sessions: 0, byAgent: {}, byOrder: {}, lastSeen: null });
    t.byOrder ??= {};
    if (r.order) t.byOrder[r.order] = true; // server-issued order ids only (see intake route)
    t.reports += 1;
    t.sessions += Store.clampCount(r.sessions); // NaN/-∞ can no longer poison the running total
    for (const [a, n] of Object.entries(r.agents ?? {})) {
      const add = Store.clampCount(n);
      if (!add) continue;
      const k = Store.#foldKey(t.byAgent, a);
      t.byAgent[k] = Math.min((t.byAgent[k] ?? 0) + add, Number.MAX_SAFE_INTEGER);
    }
    const seen = Store.clampStr(r.lastSeen ?? '');
    if (seen && (!t.lastSeen || seen > t.lastSeen)) t.lastSeen = seen;
  }

  foldEvent(e) {
    const t = (this.data.eventTotals[e.slug] ??= { installs: 0, updates: 0, installsByAgent: {} });
    if (e.event === 'install') {
      t.installs += 1;
      for (const a of e.agents ?? []) {
        const k = Store.#foldKey(t.installsByAgent, a);
        t.installsByAgent[k] = (t.installsByAgent[k] ?? 0) + 1;
      }
    }
    if (e.event === 'update') t.updates += 1;
  }

  addReport(r) {
    this.foldReport(r);
    (this.data.reports ??= []).push(r);
    if (this.data.reports.length > Store.MAX_REPORTS) this.data.reports.splice(0, this.data.reports.length - Store.MAX_REPORTS);
    this.#tx(() => {
      this.#upsert('usage_totals', r.slug, this.data.usageTotals[r.slug]);
      this.#append('reports', r);
      this.#trim('reports', Store.MAX_REPORTS);
    });
  }

  addEvent(e) {
    this.foldEvent(e);
    (this.data.events ??= []).push(e);
    if (this.data.events.length > Store.MAX_EVENTS) this.data.events.splice(0, this.data.events.length - Store.MAX_EVENTS);
    this.#tx(() => {
      this.#upsert('event_totals', e.slug, this.data.eventTotals[e.slug]);
      this.#append('events', e);
      this.#trim('events', Store.MAX_EVENTS);
    });
  }

  // ---- activation codes ----
  createActivation(email) {
    const code = randomBytes(3).toString('hex').toUpperCase();
    const cutoff = Date.now() - 15 * 60 * 1000;
    const swept = [];
    for (const [c, a] of Object.entries(this.data.activations)) {
      if (a.createdAt < cutoff) { delete this.data.activations[c]; swept.push(c); }
    }
    this.data.activations[code] = { email: email.toLowerCase(), createdAt: Date.now() };
    this.#tx(() => {
      for (const c of swept) this.#delete('activations', c);
      this.#upsert('activations', code, this.data.activations[code]);
    });
    return code;
  }
  consumeActivation(code) {
    const a = this.data.activations[code?.toUpperCase()];
    if (!a || Date.now() - a.createdAt > 15 * 60 * 1000) return null;
    delete this.data.activations[code.toUpperCase()];
    this.#delete('activations', code.toUpperCase());
    return a;
  }

  // ---- bearer tokens ----
  issueToken(email) {
    const token = 'alo_' + randomBytes(24).toString('hex');
    this.data.tokens[token] = { email: email.toLowerCase(), createdAt: new Date().toISOString() };
    this.#upsert('tokens', token, this.data.tokens[token]);
    return token;
  }
  emailForToken(token) { return this.data.tokens[token]?.email ?? null; }
}
