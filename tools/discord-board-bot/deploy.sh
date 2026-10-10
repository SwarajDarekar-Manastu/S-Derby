#!/usr/bin/env bash
# Install or update the bot as the systemd user service sderby-discord-bot under the paperclip user.
# Usage: tools/discord-board-bot/deploy.sh        (run as a sudoer from the repo checkout)
# Secrets stay in /home/paperclip/.config/sderby-discord-bot/env (mode 600); this script never reads them.
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
DEST=/home/paperclip/discord-board-bot
CONF=/home/paperclip/.config/sderby-discord-bot
UNIT_DIR=/home/paperclip/.config/systemd/user
NODE=/home/paperclip/.local/node-v24.21.0-linux-x64/bin/node
U=$(id -u paperclip)
as_paperclip() { sudo -n -u paperclip XDG_RUNTIME_DIR=/run/user/$U "$@"; }

sudo -n test -f "$CONF/env" || { echo "missing $CONF/env; create it first (see README)"; exit 1; }
sudo -n rsync -a --delete --exclude verify --exclude test --exclude '*.md' --exclude deploy.sh "$SRC/" "$DEST/"
sudo -n chown -R paperclip:paperclip "$DEST"
sudo -n -u paperclip mkdir -p "$UNIT_DIR" /home/paperclip/.local/state/sderby-discord-bot
sudo -n -u paperclip tee "$UNIT_DIR/sderby-discord-bot.service" >/dev/null <<EOF
[Unit]
Description=S-Derby Discord Board bot
After=network-online.target paperclipai.service

[Service]
WorkingDirectory=$DEST
EnvironmentFile=$CONF/env
Environment=BOT_STATE_FILE=/home/paperclip/.local/state/sderby-discord-bot/state.json
ExecStart=$NODE src/main.ts
Restart=always
RestartSec=10
# Exit code 2 is a configuration error: restarting would only repeat it.
RestartPreventExitStatus=2

[Install]
WantedBy=default.target
EOF
as_paperclip systemctl --user daemon-reload
as_paperclip systemctl --user enable sderby-discord-bot.service >/dev/null
as_paperclip systemctl --user restart sderby-discord-bot.service
sleep 8
as_paperclip systemctl --user --no-pager --lines=8 status sderby-discord-bot.service | sed -n '1,4p;/logged in\|config error\|notice/p'
