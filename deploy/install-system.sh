#!/bin/sh
set -eu
# Run as root from a deployed checkout. Credentials and config are provisioned separately.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NAME=${1:-pi-clerk}
case "$NAME" in *[!a-z0-9-]*|'') echo 'Invalid service name' >&2; exit 1;; esac
id "$NAME" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$NAME"
NODE=$(command -v node)
test -f "$ROOT/config.json"
test -f "$ROOT/.env"
chown -R "$NAME:$NAME" "$ROOT"
chmod 600 "$ROOT/.env"
cat > "/etc/systemd/system/$NAME.service" <<UNIT
[Unit]
Description=Pi personal Telegram assistant
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$NAME
WorkingDirectory=$ROOT
Environment=HOME=/home/$NAME
ExecStart=$NODE $ROOT/scripts/start.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillMode=control-group
UMask=0077
MemoryMax=700M
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now "$NAME.service"
systemctl is-active "$NAME.service"
