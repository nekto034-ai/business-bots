#!/usr/bin/env python3
"""Builds the cloud-init for the bots server from the files in infra/.

Usage: python3 infra/build_cloud_init.py > cloud-init.yaml
The server runs it once on first boot: installs Node.js, git, Caddy, firewall,
clones the repo, starts bots-agent (behind HTTPS) and the bots-sync timer.
"""
from pathlib import Path

import yaml

INFRA = Path(__file__).resolve().parent
REPO_URL = "https://github.com/nekto034-ai/business-bots.git"
TRACKED_BRANCH = "claude/relaxed-brahmagupta-keba77"

AGENT_SERVICE = """\
[Unit]
Description=bots-agent remote control
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/bots-agent/agent.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""

SYNC_SERVICE = """\
[Unit]
Description=Pull business-bots repo and deploy on change

[Service]
Type=oneshot
ExecStart=/usr/local/bin/bots-sync
"""

SYNC_TIMER = """\
[Unit]
Description=Run bots-sync every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
"""

# Public hostname via sslip.io (<ip-with-dashes>.sslip.io resolves to the IP),
# so Caddy can get a real Let's Encrypt certificate without buying a domain.
SETUP_HTTPS = r"""
IP=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
HOST="$(echo "$IP" | tr . -).sslip.io"
printf '%s {\n\treverse_proxy 127.0.0.1:8787\n}\n' "$HOST" > /etc/caddy/Caddyfile
echo "$HOST" > /etc/bots/hostname
systemctl restart caddy
"""


class Literal(str):
    pass


yaml.add_representer(Literal, lambda d, s: d.represent_scalar("tag:yaml.org,2002:str", s, style="|"))


def file_entry(path, content, perms="0644"):
    return {"path": path, "content": Literal(content), "permissions": perms}


def build():
    keys = (INFRA / "authorized_keys").read_text()
    return {
        "package_update": True,
        "package_upgrade": True,
        "packages": ["git", "curl", "ufw", "unattended-upgrades", "caddy"],
        "write_files": [
            file_entry("/opt/bots-agent/agent.js", (INFRA / "agent" / "agent.js").read_text()),
            file_entry("/usr/local/bin/bots-sync", (INFRA / "sync.sh").read_text(), "0755"),
            file_entry("/etc/bots-agent/authorized_keys", keys, "0600"),
            file_entry("/etc/bots/branch", TRACKED_BRANCH + "\n"),
            file_entry("/etc/systemd/system/bots-agent.service", AGENT_SERVICE),
            file_entry("/etc/systemd/system/bots-sync.service", SYNC_SERVICE),
            file_entry("/etc/systemd/system/bots-sync.timer", SYNC_TIMER),
        ],
        "runcmd": [
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
            "apt-get install -y nodejs",
            f"git clone --branch {TRACKED_BRANCH} {REPO_URL} /opt/business-bots",
            "ufw allow OpenSSH",
            "ufw allow 80/tcp",
            "ufw allow 443/tcp",
            "ufw --force enable",
            ["bash", "-c", SETUP_HTTPS],
            "systemctl daemon-reload",
            "systemctl enable --now bots-agent bots-sync.timer",
            "dpkg-reconfigure -f noninteractive unattended-upgrades",
            "systemctl enable --now unattended-upgrades",
        ],
    }


if __name__ == "__main__":
    print("#cloud-config\n" + yaml.dump(build(), sort_keys=False, allow_unicode=True, width=1000))
