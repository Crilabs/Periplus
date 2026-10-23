#!/usr/bin/env bash
# One-time setup of Periplus on an Ubuntu 24.04 server shared with other apps. Run as root from a checkout
# (or copy) of the repo:
#   sudo bash scripts/server/bootstrap.sh <public-key-file for user periplus>
# Idempotent: safe to re-run. Never overwrites an existing /opt/periplus/.env.
# The server is shared: firewall and SSH settings stay as they are, and TLS is the server's own Caddy (systemd),
# which gets docker/Caddyfile as an imported site block.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
PUBKEY_FILE="${1:?usage: bootstrap.sh <public-key-file for user periplus>}"
[ -r "$PUBKEY_FILE" ] || { echo "cannot read $PUBKEY_FILE" >&2; exit 1; }
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/periplus
# Own user, not the server's shared `deploy`: membership in group docker is root-equivalent and must not extend
# to the other apps' deploy keys.
APP_USER=periplus
CADDY_MAIN=/etc/caddy/Caddyfile
CADDY_SITE=/etc/caddy/periplus.caddy
export DEBIAN_FRONTEND=noninteractive

systemctl is-active --quiet caddy || { echo "the server's Caddy (systemd unit caddy) is not running" >&2; exit 1; }

apt-get update
apt-get install -y ca-certificates curl gnupg unattended-upgrades restic rclone cron

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

# App user (deploys over SSH, owns /opt/periplus, runs the backup)
id "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$APP_USER"
usermod -aG docker "$APP_USER"
APP_HOME="/home/$APP_USER"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/.ssh"
touch "$APP_HOME/.ssh/authorized_keys"
grep -qxF "$(cat "$PUBKEY_FILE")" "$APP_HOME/.ssh/authorized_keys" || cat "$PUBKEY_FILE" >> "$APP_HOME/.ssh/authorized_keys"
chown "$APP_USER:$APP_USER" "$APP_HOME/.ssh/authorized_keys"
chmod 600 "$APP_HOME/.ssh/authorized_keys"

# Automatic security updates
dpkg-reconfigure -f noninteractive unattended-upgrades

# Application directory
OWN=(-o "$APP_USER" -g "$APP_USER")
install -d -m 755 "${OWN[@]}" "$APP_DIR" "$APP_DIR/docker" "$APP_DIR/scripts/ops" "$APP_DIR/scripts/deploy"
install -m 644 "${OWN[@]}" "$REPO_DIR/docker/compose.prod.yml" "$APP_DIR/docker/compose.prod.yml"
install -m 755 "${OWN[@]}" "$REPO_DIR/scripts/ops/backup.sh" "$APP_DIR/scripts/ops/backup.sh"
install -m 755 "${OWN[@]}" "$REPO_DIR/scripts/ops/restore-check.sh" "$APP_DIR/scripts/ops/restore-check.sh"
install -m 755 "${OWN[@]}" "$REPO_DIR/scripts/deploy/deploy.sh" "$APP_DIR/scripts/deploy/deploy.sh"

# Site block in the server's Caddy. Validated before the reload, so a broken file never takes the other sites down;
# on failure the previous state is restored.
cp -p "$CADDY_MAIN" "$CADDY_MAIN.bak-periplus"
[ -e "$CADDY_SITE" ] && cp -p "$CADDY_SITE" "$CADDY_SITE.bak-periplus"
install -m 644 "$REPO_DIR/docker/Caddyfile" "$CADDY_SITE"
grep -qxF "import $CADDY_SITE" "$CADDY_MAIN" || printf '\n# Periplus (scripts/server/bootstrap.sh)\nimport %s\n' "$CADDY_SITE" >> "$CADDY_MAIN"
# As the service user: validate opens the log files, so as root it would create them unreadable for Caddy and
# hide exactly that error until the reload.
if ! runuser -u caddy -- caddy validate --config "$CADDY_MAIN" --adapter caddyfile; then
  mv "$CADDY_MAIN.bak-periplus" "$CADDY_MAIN"
  if [ -e "$CADDY_SITE.bak-periplus" ]; then mv "$CADDY_SITE.bak-periplus" "$CADDY_SITE"; else rm -f "$CADDY_SITE"; fi
  echo "caddy validate failed; $CADDY_MAIN restored, Caddy not reloaded" >&2
  exit 1
fi
rm -f "$CADDY_MAIN.bak-periplus" "$CADDY_SITE.bak-periplus"
systemctl reload caddy

if [ ! -e "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<'ENV'
# Fill in every value. Mode 600, owner periplus. Never commit.
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
# Place images (spec 13); empty disables image generation
OPENAI_API_KEY=
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
STORAGEBOX_KEY_FILE=/home/periplus/.ssh/id_storagebox
ENV
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"

# Backup cron: 02:30 UTC daily, as periplus (member of group docker)
cat > /etc/cron.d/periplus-backup <<'CRON'
CRON_TZ=UTC
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * periplus /opt/periplus/scripts/ops/backup.sh >> /opt/periplus/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/periplus-backup

echo "bootstrap done. Next: fill $APP_DIR/.env, add the Storage Box key, see docs/runbook.md"
