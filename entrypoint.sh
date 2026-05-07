#!/bin/sh
# Seed config.json from default if not present
if [ ! -f /data/config.json ]; then
  echo "No config.json — copying default to /data/config.json"
  cp /app/config.default.json /data/config.json
fi

# Seed integrations.json (empty) if not present
if [ ! -f /data/integrations.json ]; then
  echo "No integrations.json — creating empty /data/integrations.json"
  echo '[]' > /data/integrations.json
fi

export CONFIG_PATH=/data/config.json
export INTEGRATIONS_PATH=/data/integrations.json

exec node server.js
