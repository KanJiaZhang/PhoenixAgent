#!/bin/sh
set -e
cd /app

if [ ! -f fixtures/demo/data/demo.db ]; then
  echo "[entrypoint] building the demo warehouse"
  node scripts/build-demo-db.mjs
fi

if [ "${PAGENT_BUILD_MODEL:-1}" = "1" ] && [ ! -f "/data/build/${PAGENT_GRAPH:-demo-analytics}/candidates.json" ]; then
  echo "[entrypoint] building the semantic model"
  node packages/semantic/src/cli.ts build --graph "${PAGENT_GRAPH:-demo-analytics}" --workspace /data || true
fi

if [ -z "${PAGENT_API_KEYS:-}" ]; then
  echo "[entrypoint] PAGENT_API_KEYS is not set: the service will generate one and print it"
fi

exec node packages/api/src/bin.ts
