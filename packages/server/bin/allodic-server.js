#!/usr/bin/env node
// allodic-server — boots the self-hostable registry.
//   PORT           listen port                  (default 8787)
//   ALLODIC_DATA   data directory               (default ./.allodic-data)
//   see docs/DEPLOY.md for Stripe / SMTP / BASE_URL configuration.
import { createApp } from '../src/index.js';

let app;
try {
  ({ app } = createApp({}));
} catch (e) {
  // Configuration refusals (e.g. Stripe key without webhook secret) are
  // operator errors, not crashes — print the message, not a stack trace.
  console.error(`\n  allodic-server refused to start:\n  ${e.message}\n`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`allodic server \u2192 http://localhost:${port}`));
