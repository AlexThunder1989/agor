#!/bin/sh
set -eu
export pnpm_config_verify_deps_before_run=false CI=true
export NODE_OPTIONS=--conditions=source
cd /app
export AGOR_BUILD_SHA=$(cat benchmarks/pr2928/arm-sha.txt)
# No provider credentials, SSH mounts, git provisioning, agents, or watchers.
NODE_ENV=production pnpm --dir apps/agor-ui exec vite build > benchmarks/pr2928/results/build-$AGOR_BUILD_SHA.log 2>&1
ln -sfn ../agor-ui/dist /app/apps/agor-daemon/ui
mkdir -p node_modules/@agor
ln -sfn /app/packages/core node_modules/@agor/core
node --import tsx scripts/ensure-development-config.ts
node --import tsx apps/agor-cli/bin/dev.ts db migrate --yes --offline-cutover
node --import tsx benchmarks/pr2928/seed.mts
export PORT=$DAEMON_PORT
exec node --import tsx apps/agor-daemon/src/main.ts
