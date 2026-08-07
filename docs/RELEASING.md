# Releasing

One version, everywhere. `npm test` fails on drift (`scripts/check-versions.js`).

## Bump

```bash
bash scripts/set-version.sh 0.1.0-alpha.2   # root + workspaces + cross-pins + npm channel
git commit -am "v0.1.0-alpha.2" && git tag v0.1.0-alpha.2
git push --follow-tags        # pushes the commit AND its tag — `--tags` alone
                              # can land the tag while the branch stays behind
```

## Publish to npm

Pushing the tag runs `.github/workflows/publish-npm.yml`: full test matrix
(claimed Node floor + current) → publish → registry smoke test. It needs an
`NPM_TOKEN` repo secret (automation token with publish rights on `allodic`
and the `@allodic` scope).

**Order is load-bearing.** Both `@allodic/server` and `allodic` pin
`@allodic/core` at the *exact* release version. Publish out of order and you
get the classic launch-day failure: the repo is tagged, the Docker image
exists, and `npx allodic@alpha` resolves the CLI but not its dependency.
Core first, always:

1. `@allodic/core`
2. `@allodic/server`
3. `allodic`

The workflow is **idempotent** — each package is skipped if `name@version`
is already on the registry — so a run that failed after publishing core can
simply be re-run to publish the rest. Packages ship with **npm provenance**
(`--provenance`, id-token attestation): the same verify-don't-trust standard
the product applies to skills. Dist-tag and access come from each package's
`publishConfig` (prereleases carry `tag: alpha`; never `latest`).

After publishing, the workflow **smoke tests from the public registry on a
clean machine**: waits for all three `name@version`s to propagate, then in
an empty temp dir asserts `npx -y allodic@<version> --version` prints
exactly the tagged version, `help` renders, `@allodic/server` installs with
its `allodic-server` bin present, and `@allodic/core` resolves as its
transitive dependency. No checkout, no workspaces, no cache to hide behind.

Manual fallback (same order, same checks):

```bash
VERSION=$(node -p "require('./package.json').version")
for W in packages/core packages/server packages/cli; do
  npm publish --workspace "$W" --provenance     # skips nothing: check first with
done                                            #   npm view <name>@$VERSION version
cd "$(mktemp -d)" && npx -y "allodic@$VERSION" --version   # must print $VERSION
```

## Channels

Prerelease channels are explicit. Nothing labelled `latest` until the first
default release.

**npm** — `set-version.sh` derives the dist-tag from the version: prereleases
get `publishConfig.tag: "alpha"`, so bare `npm publish` cannot accidentally
ship an alpha as `latest`. Stable versions drop the field. Consumers:

```bash
npx allodic@alpha ...     # prerelease channel, opt-in
npx allodic ...           # resolves only once a default release exists
```

**Docker (ghcr)** — the workflow uses `latest=auto`:

| git tag          | image tags                          |
| ---------------- | ----------------------------------- |
| `v0.1.0-alpha.1` | `0.1.0-alpha.1`, `alpha`, `sha-…`   |
| `v0.1.0`         | `0.1.0`, `latest`, `sha-…`          |

`ghcr.io/allodic-hq/allodic:alpha` is the moving prerelease tag; it is never
called `latest`.

## What the first default release means

`0.1.0` without a prerelease suffix is not a stability promise — major
version zero is initial development and the public API may still change. It
means the default published release is usable: the literal quickstart
commands work, the launch-blocking issues are closed, and we're willing to
hand it to someone who typed `npx allodic` with no channel qualifier.
