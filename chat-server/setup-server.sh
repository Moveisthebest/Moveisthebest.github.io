#!/usr/bin/env bash
# One-time server setup for the chat proxy. Run as root on the server with the
# files from chat-server/ in the current directory. Safe to re-run.
set -euo pipefail
SITE=/etc/nginx/sites-available/flash-api.top
INCLUDE_LINE='    include /etc/nginx/snippets/kw-chat.conf;'

install -d /opt/kw-chat/knowledge
install -m 644 server.mjs knowledge.mjs profile.md /opt/kw-chat/
for dir in knowledge papers; do
  install -d "/opt/kw-chat/$dir"
  if ls "$dir"/*.md >/dev/null 2>&1; then
    rm -f "/opt/kw-chat/$dir"/*.md
    install -m 644 "$dir"/*.md "/opt/kw-chat/$dir/"
  fi
done

if [ ! -f /etc/kw-chat.env ]; then
  install -m 600 kw-chat.env.example /etc/kw-chat.env
  echo "created /etc/kw-chat.env (add DEEPSEEK_API_KEY)"
fi

install -m 644 kw-chat.service /etc/systemd/system/kw-chat.service
systemctl daemon-reload
systemctl enable kw-chat >/dev/null 2>&1
systemctl restart kw-chat

install -m 644 nginx-kw-chat.conf /etc/nginx/snippets/kw-chat.conf
if ! grep -qF "$INCLUDE_LINE" "$SITE"; then
  [ "$(grep -c '^    location / {' "$SITE")" = 1 ] || { echo "unexpected nginx layout, not touching $SITE"; exit 1; }
  backup="/root/flash-api.top.nginx.bak-$(date +%Y%m%d%H%M%S)"
  cp -p "$SITE" "$backup"
  sed -i "0,/^    location \/ {/s//${INCLUDE_LINE//\//\\/}\n\n    location \/ {/" "$SITE"
  if ! nginx -t 2>&1; then
    cp -p "$backup" "$SITE"
    echo "nginx -t failed, restored $backup"; exit 1
  fi
  echo "nginx config updated (backup: $backup)"
fi
systemctl reload nginx
sleep 1
systemctl is-active kw-chat