# FAQ — asked by real people, answered straight

**Do refunds actually revoke access, or is that marketing?**
Actually. The Stripe webhook matches refunds back to their order and
revokes the license once the captured amount is fully refunded —
downloads and updates stop for every device on it. A *partial* goodwill
refund deliberately does not revoke: the buyer keeps the license and the
books record exactly the cents returned. Event-driven, no polling.
(Subscribe the four webhook events; DEPLOY.md.)

**If I buy one skill, do I get everything that seller makes?**
No. The token proves who you are, per seller; every skill checks for a
paid, non-revoked order for *that* skill. Trying an unbought one returns
`402` and a buy link.

**Who writes the benchmarks — allodic?**
The publisher, today. They're signed, bound to the exact release, and
re-runnable by any buyer — self-certification with teeth. Softball exams
are visible as softballs (tasks are public). Registry-authored suites are
the natural next rung — any independent registry can publish and sign its
own.

**"Verified publisher" — verified by whom?**
By the publisher's own signing key: integrity and continuity (your first
install pins the key; changed keys refuse updates). It is not third-party
identity attestation, and the UI says so.

**Is the registry index global?**
No. Every server is its own registry — your catalog, your numbers, at
your domain. There is no central index, and registries report nothing to
Allodic. (The CLI tool sends privacy-limited product analytics unless
disabled — see the next answer; registries and skills do not.)

**Does anything phone home?**
Installed skills: never — nothing a buyer runs contains Allodic
telemetry. The CLI: yes, disclosed and privacy-limited, unless you turn
it off. It sends coarse command outcomes to Allodic (via `j.allodic.dev`)
and install/update delivery events to the relevant publisher — never
skill content, names, paths, credentials, buyer data, or exact prices.
One shared switch disables both: `allodic telemetry disable`,
`ALLODIC_TELEMETRY=0`, or `DO_NOT_TRACK=1`. The full allowlist is in
[telemetry.md](telemetry.md) and inspectable via `allodic telemetry
show`. Usage stats: computed locally, shared only by explicit `report`.

**Can't a seller just fake the scan and eval badges?**
On their own server, once. Claims are signed and reproducible; a claim
that fails a buyer's `verify` is portable fraud evidence, refunds revoke,
and the audience leaves. See trust-model.md.

**What stops a buyer from re-sharing the files?**
Nothing prevents it — possession is DRM-free by design. Every copy is
per-buyer fingerprinted (down to meaning-level canaries that survive
reformatting), so leaks are attributable via `trace`.

**Why "allodic"?**
Allodial land is held outright — no landlord, no overlord, no platform
cut. That's the thesis, applied to what you make with AI.
