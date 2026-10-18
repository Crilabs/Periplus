#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server. Run as root from a checkout (or copy) of the repo:
#   sudo bash scripts/server/bootstrap.sh <deploy-user-public-key-file>
# Idempotent: safe to re-run. Never overwrites an existing /opt/periplus/.env.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
PUBKEY_FILE="${1:?usage: bootstrap.sh <public-key-file for user deploy>}"
[ -r "$PUBKEY_FILE" ] || { echo "cannot read $PUBKEY_FILE" >&2; exit 1; }
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/periplus
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg ufw unattended-upgrades restic rclone cron

# Docker Engine + compose plugin from Docker's apt repository
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# Deploy user
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$(cat "$PUBKEY_FILE")" /home/deploy/.ssh/authorized_keys || cat "$PUBKEY_FILE" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# Firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# SSH: key login only
cat > /etc/ssh/sshd_config.d/99-periplus.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
sshd -t
systemctl reload ssh

# Automatic security updates
dpkg-reconfigure -f noninteractive unattended-upgrades

# Application directory
install -d -m 755 -o deploy -g deploy "$APP_DIR" "$APP_DIR/docker" "$APP_DIR/scripts/ops" "$APP_DIR/scripts/deploy"
install -m 644 -o deploy -g deploy "$REPO_DIR/docker/compose.prod.yml" "$APP_DIR/docker/compose.prod.yml"
install -m 644 -o deploy -g deploy "$REPO_DIR/docker/Caddyfile" "$APP_DIR/docker/Caddyfile"
install -m 755 -o deploy -g deploy "$REPO_DIR/scripts/ops/backup.sh" "$APP_DIR/scripts/ops/backup.sh"
install -m 755 -o deploy -g deploy "$REPO_DIR/scripts/ops/restore-check.sh" "$APP_DIR/scripts/ops/restore-check.sh"
install -m 755 -o deploy -g deploy "$REPO_DIR/scripts/deploy/deploy.sh" "$APP_DIR/scripts/deploy/deploy.sh"

if [ ! -e "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<'ENV'
# Fill in every value. Mode 600, owner deploy. Never commit.
PERIPLUS_DOMAIN=
POSTGRES_PASSWORD=
# Must use the same password as POSTGRES_PASSWORD
DATABASE_URL=postgres://periplus:CHANGE_ME@postgres:5432/periplus
SESSION_SECRET=
CONTACT_EMAIL=
LOG_LEVEL=info

# Archive: Hetzner Object Storage
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=periplus-archive
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# External services
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
JINA_API_KEY=
FIRECRAWL_API_KEY=

# Backups (scripts/ops/backup.sh)
RESTIC_REPOSITORY=sftp:STORAGEBOX_USER@STORAGEBOX_HOST:periplus-restic
RESTIC_PASSWORD=
STORAGEBOX_HOST=
STORAGEBOX_USER=
STORAGEBOX_PORT=23
STORAGEBOX_KEY_FILE=/home/deploy/.ssh/id_storagebox
ENV
  chown deploy:deploy "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"

# Backup cron: 02:30 UTC daily, as deploy (member of group docker)
cat > /etc/cron.d/periplus-backup <<'CRON'
CRON_TZ=UTC
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * deploy /opt/periplus/scripts/ops/backup.sh >> /opt/periplus/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/periplus-backup

echo "bootstrap done. Next: fill $APP_DIR/.env, add the Storage Box key, see docs/runbook.md"
