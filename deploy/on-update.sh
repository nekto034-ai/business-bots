#!/bin/bash
# Runs on the server after bots-sync pulls a new commit (as root, cwd = repo root).
# Keep it idempotent: it runs on every update.
set -euo pipefail
cd /opt/business-bots

HOST=$(cat /etc/bots/hostname)   # e.g. 91-186-199-30.sslip.io

# Services
install -m 644 deploy/landing.service /etc/systemd/system/landing.service
systemctl daemon-reload
systemctl enable --quiet landing
systemctl restart landing

# Caddy: agent on the bare host, sites on subdomains. Validate before swapping,
# so a broken config never takes down the agent.
NEW=$(mktemp)
cat > "$NEW" <<CADDY
$HOST {
	reverse_proxy 127.0.0.1:8787
}

site.$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8080
}
CADDY
caddy validate --adapter caddyfile --config "$NEW" >/dev/null
if ! cmp -s "$NEW" /etc/caddy/Caddyfile; then
  install -m 644 "$NEW" /etc/caddy/Caddyfile
  systemctl reload caddy
fi
rm -f "$NEW"
echo "deploy done"
