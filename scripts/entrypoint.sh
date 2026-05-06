#!/bin/sh

if [ "$IS_DEV" = "true" ]; then
  echo "Starting in development mode..."
  npm run start:dev
else
  echo "Starting in production mode..."
  npm run db:deploy && exec node -r dotenv/config -r tsconfig-paths/register --enable-source-maps build/index.js
fi
