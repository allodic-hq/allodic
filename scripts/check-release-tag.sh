#!/usr/bin/env bash
# ONE release-version gate, shared by EVERY tag-triggered publication —
# .github/workflows/publish-npm.yml AND publish-image.yml. Split-brain
# scenario this kills: tag v0.1.0 on a tree whose packages say
# 0.1.0-alpha.2 → npm refuses (good) but the image workflow used to derive
# tags from git alone and would happily push ghcr :0.1.0 and :latest
# containing alpha packages. Nothing version-tagged may build or push until
# this passes.
#
# Usage: check-release-tag.sh [tag]   (defaults to $GITHUB_REF_NAME)
set -euo pipefail
VERSION=$(node -p "require('./package.json').version")
REF="${GITHUB_REF:-}"
TAG="${1:-${GITHUB_REF_NAME:-}}"

if [ -n "$REF" ] && [ "${REF#refs/tags/}" = "$REF" ] && [ -z "${1:-}" ]; then
  echo "release gate: not a tag ref ($REF) — no version-tagged publication to gate"
  exit 0
fi
TAG="${TAG#v}"
if [ -z "$TAG" ]; then
  echo "::error::release gate: no tag to check (pass one, or run on a tag ref)"
  exit 1
fi
if [ "$TAG" != "$VERSION" ]; then
  echo "::error::git tag v$TAG does not match package version $VERSION — run: bash scripts/set-version.sh $TAG, commit, re-tag"
  exit 1
fi
echo "✓ release gate: tag v$TAG == package version $VERSION"
