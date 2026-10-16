#!/bin/bash
# Runs on the server after bots-sync pulls a new commit (as root, cwd = repo root).
# Keep it idempotent: it runs on every update.
set -euo pipefail
cd /opt/business-bots

HOST=$(cat /etc/bots/hostname)   # e.g. 91-186-199-30.sslip.io

# bots-agent updates itself from the repo. Restart is delayed so an exec that
# triggered this deploy can still return its output.
if ! cmp -s infra/agent/agent.js /opt/bots-agent/agent.js; then
  install -m 644 infra/agent/agent.js /opt/bots-agent/agent.js
  systemd-run --quiet --on-active=5 systemctl restart bots-agent
  echo "bots-agent updated, restarting in 5s"
fi

# Xiaomi cloud bridge for the fitness site: Python venv with the pinned mifit library.
MIFIT_VERSION=0.3.2
VENV=/opt/fitness-xiaomi-venv
if ! dpkg -s python3.12-venv >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3.12-venv >/dev/null
fi
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
if [ "$("$VENV/bin/python" -c 'import importlib.metadata as m; print(m.version("mifit"))' 2>/dev/null)" != "$MIFIT_VERSION" ]; then
  "$VENV/bin/pip" install -q "mifit==$MIFIT_VERSION"
fi

# Services
install -m 644 deploy/landing.service /etc/systemd/system/landing.service
install -m 644 deploy/fitness.service /etc/systemd/system/fitness.service
install -m 644 deploy/fitness-xiaomi.service /etc/systemd/system/fitness-xiaomi.service
systemctl daemon-reload
systemctl enable --quiet landing fitness fitness-xiaomi
systemctl restart landing fitness fitness-xiaomi

# Caddy: agent on the bare host, sites on subdomains. Validate before swapping,
# so a broken config never takes down the agent.
NEW=$(mktemp)
cat > "$NEW" <<CADDY
$HOST {
	reverse_proxy 127.0.0.1:8787
}

site.$HOST, site2.$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8080
}

fit.$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8090
}

kb.$HOST {
	encode gzip
	header X-Robots-Tag "noindex, nofollow"
	import /opt/business-bots/sites/kb/auth.caddy
	root * /opt/business-bots/sites/kb/public
	file_server
}
CADDY
caddy validate --adapter caddyfile --config "$NEW" >/dev/null
if ! cmp -s "$NEW" /etc/caddy/Caddyfile; then
  install -m 644 "$NEW" /etc/caddy/Caddyfile
  systemctl reload caddy
fi
rm -f "$NEW"
echo "deploy done"
