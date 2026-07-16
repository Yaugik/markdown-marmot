#!/bin/sh
set -eu

npm run db:migrate:folio
npm run db:migrate

if [ "${SEED_DEMO:-false}" = "true" ]; then
  npm run db:seed
fi

exec "$@"
