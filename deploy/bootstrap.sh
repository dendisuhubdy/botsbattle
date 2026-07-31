#!/usr/bin/env bash
set -euo pipefail

# One-time droplet preparation. Run as root on a fresh Ubuntu 24.04 droplet.

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# Second phase, run only after `ssh deploy@<host> true` has been proven to work.
if [ "${1:-}" = "--harden-ssh" ]; then
  echo "==> hardening sshd"
  # Refuse to disable root login unless the deploy user can actually authenticate.
  # Getting this wrong locks everyone out of a box holding a hot wallet.
  if [ ! -s /home/deploy/.ssh/authorized_keys ]; then
    echo "REFUSING: /home/deploy/.ssh/authorized_keys is missing or empty" >&2
    exit 1
  fi
  if ! diff -q /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys >/dev/null; then
    echo "REFUSING: deploy authorized_keys does not match root's" >&2
    exit 1
  fi
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  # Ubuntu 24.04 ships cloud-init drop-ins that re-enable password auth; they win on
  # include order, so neutralise them too rather than trusting sshd_config alone.
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -e "$f" ] || continue
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$f"
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "$f"
  done
  sshd -t
  systemctl restart ssh
  echo "sshd hardened: root login disabled, password auth disabled"
  sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication)'
  exit 0
fi

echo "==> packages"
apt-get update
apt-get install -y ca-certificates curl gnupg ufw postgresql-client

echo "==> docker"
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> deploy user"
if ! id deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" deploy
fi
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

echo "==> firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> unattended security updates"
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# sshd hardening is deliberately NOT done here. Disabling root login before anyone has
# proven they can log in as `deploy` is how you lock yourself out of a production box that
# holds a hot wallet. Run `bootstrap.sh --harden-ssh` only after `ssh deploy@<host> true`
# has succeeded from a second terminal.
echo
echo "bootstrap complete -- sshd NOT yet hardened"
echo "verify 'ssh deploy@<host> true' works, THEN run: bash bootstrap.sh --harden-ssh"
ufw status verbose
