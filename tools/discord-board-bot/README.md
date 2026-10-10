# S-Derby Discord Board bot

Lets the S-Derby Board run Paperclip from Discord: a live status board, an inbox of decisions with buttons, slash commands for tasks and agents, and conversation channels with the four decision agents. It talks to Paperclip only through its REST API with a board API key and connects out to Discord, so nothing on the host accepts inbound traffic.

## What it does

| Channel | Behavior |
| --- | --- |
| #status | One pinned message, edited every minute: each decision agent's state, task and latest statement; the team; subscription windows; task counts |
| #board-inbox | Every Paperclip attention item. Approvals, decisions, confirmations and question cards have buttons; others show in full. Mentions the Board for decisions and for pacing pauses and agent errors |
| #cto, #senior-dev, #validation, #release | A message starts a task for that agent and a thread. Replies become comments; the agent's comments come back under its name |
| #bot-status | Start, outage, key and permission notices, and an "alive at" line every 5 minutes |

Commands: `/task new|list|show|comment` and `/agent show|pause|resume|wake|raise`. Only the configured Board user can use them, click buttons, or post into agent channels.

## Configuration

All settings come from the environment, usually an env file loaded by systemd:

| Variable | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `DISCORD_GUILD_ID` | The S-Derby server ID |
| `DISCORD_BOARD_USER_ID` | The Board's Discord user ID; the only user the bot acts for |
| `DISCORD_CHANNELS` | JSON: `{"status":"…","board-inbox":"…","bot-status":"…","cto":"…","senior-dev":"…","validation":"…","release":"…"}` |
| `PAPERCLIP_URL` | `http://127.0.0.1:3100` |
| `PAPERCLIP_BOARD_KEY` | A board API key (`pcp_board_…`) |
| `PAPERCLIP_COMPANY_ID` | The S-Derby company ID |
| `PAPERCLIP_BOARD_KEY_NAME` | The key's name, for the expiry warning (default `discord-board-bot`) |
| `BOT_STATE_FILE` | Where the bot keeps message and thread mappings (default `bot-state.json`) |

The bot stops at startup with the name of any missing setting. The Discord app needs **Message Content Intent** on and these permissions in the server: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Embed Links, Attach Files, Manage Webhooks, Use Application Commands, Manage Messages (to pin the status board).

## Running

```sh
pnpm install --ignore-workspace
pnpm start          # node src/main.ts (Node 24 runs TypeScript directly)
pnpm test           # unit tests
pnpm typecheck
```

In production it runs as the systemd user unit `sderby-discord-bot.service` under the `paperclip` user, next to `paperclipai.service`.

## Rotating secrets

- **Discord token:** Developer Portal → Bot → Reset Token, write the new token into the env file, restart the service.
- **Board key:** create a new key (`POST /api/board-api-keys` with name `discord-board-bot` and an `expiresAt`), put it in the env file, restart, then revoke the old one (`DELETE /api/board-api-keys/:id`). The bot warns in #bot-status 7 days before expiry and stops acting the moment a key is rejected.

## Stopping it

`systemctl --user stop sderby-discord-bot` as the `paperclip` user. Messages already in Discord stay; nothing in Paperclip changes.

## Verifying changes

See `.claude/skills/verify-discord-board-bot/SKILL.md`. The harness in `verify/` runs the bot against an isolated Paperclip on `:3199`, never the live board.
