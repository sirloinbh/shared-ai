#!/bin/bash
# Installs and starts the nightly dump and the weekly restore check. Run once as root on the server;
# adding HEALTHCHECK_URL_* to .env later needs no rerun:
#   sudo bash /opt/shared-ai/deploy/install-backup.sh
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
install -d -o ubuntu -g ubuntu -m 700 /var/backups/ai
for unit in backup restore-check; do
  install -m 644 "$dir/$unit.service" "/etc/systemd/system/shared-ai-$unit.service"
  install -m 644 "$dir/$unit.timer" "/etc/systemd/system/shared-ai-$unit.timer"
done
systemctl daemon-reload
systemctl enable --now shared-ai-backup.timer shared-ai-restore-check.timer
systemctl list-timers shared-ai-backup.timer shared-ai-restore-check.timer --no-pager
