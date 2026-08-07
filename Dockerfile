# Base pinned by DIGEST, not tag — `node:22-slim` is mutable; this byte-exact
# image is not. The tag is kept in the comment for humans; bump by updating the
# digest deliberately:
#   curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" \
#     | jq -r .token | xargs -I{} curl -sI -H "Authorization: Bearer {}" \
#       -H "Accept: application/vnd.oci.image.index.v1+json" \
#       https://registry-1.docker.io/v2/library/node/manifests/22-slim | grep -i digest
# node:22-slim as of 2026-08-02:
FROM node@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46
WORKDIR /app

# Authoritative external gate engines, both preferred over builtin fallbacks:
#  - skills-ref: official Agent Skills reference validator (spec gate)
#  - SkillSpector (NVIDIA): skill security scanner, static-only ("is it safe" gate)
# Pinned in scripts/gate-engines.txt — the SAME file CI installs from, so the
# image can never carry different engine versions than the ones tests passed on.
COPY scripts/gate-engines.txt scripts/
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip git \
  && pip3 install --break-system-packages --no-cache-dir -r scripts/gate-engines.txt \
  && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching — workspaces need every package.json present.
# `npm ci` against the COMMITTED lockfile: the image resolves the exact
# dependency tree the tests ran against, or the build fails. Never `npm install`
# here — it would re-resolve semver ranges at build time.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev

# App source
COPY . .

ENV NODE_ENV=production PORT=8787 ALLODIC_DATA=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/catalog').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/bin/allodic-server.js"]
