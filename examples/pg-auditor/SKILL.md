---
name: pg-auditor
description: Audits Postgres migrations for locking hazards before they take down production. Use when reviewing any migration file.
compatibility: Requires read access to migration files; a Postgres MCP server improves live-schema checks.
metadata:
  version: "1.4.0"
  price: "$29"
  author: razvan
---

# Postgres Migration Auditor

{{~ Before merging | Prior to merging | Before you merge | Ahead of merging }} any migration {{~ touching | that touches | affecting | involving }}
{{~ hot tables | high-traffic tables | busy tables | heavily used tables }}, {{~ run | perform | apply | work through }} these checks.

## Checks
1. {{~ Flag | Call out | Surface | Report }} CREATE INDEX without CONCURRENTLY on {{~ large | big | sizable | substantial }} tables.
2. ALTER TABLE ... ADD COLUMN with DEFAULT on {{~ large | big | sizable | substantial }} tables ({{~ pre-PG11: full rewrite | full rewrite before PG11 | a full rewrite pre-PG11 | before PG11, a full table rewrite }}).
3. {{~ Foreign key additions | New foreign keys | Added foreign keys | Foreign keys being added }} {{~ need | require | call for | demand }} NOT VALID + VALIDATE two-step.
4. Type changes that {{~ take | acquire | grab | hold }} {{~ ACCESS EXCLUSIVE locks | an ACCESS EXCLUSIVE lock | ACCESS EXCLUSIVE locking | the ACCESS EXCLUSIVE lock }}.

## Output
For each {{~ hazard | risk | finding | issue }}: severity, the lock it {{~ takes | acquires | requires | involves }}, blast radius, and the {{~ safe rewrite | safe alternative | non-blocking rewrite | lock-safe rewrite }}.
