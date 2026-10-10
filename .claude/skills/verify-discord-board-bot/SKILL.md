---
name: verify-discord-board-bot
description: Verify the S-Derby Discord Board bot (tools/discord-board-bot) end to end the way the Board uses it — status board, inbox buttons, slash commands, agent relay, resilience — against an isolated Paperclip on :3199 and the S-Derby Test Discord server. Use before calling any bot change done, after a Paperclip overlay deploy, or when the bot misbehaves.
---

# Verify the Discord Board bot

The bot connects Discord to Paperclip's REST API with a board key. Verification runs it against a throwaway Paperclip built from this checkout, never the live board on `:3100`, and against the **S-Derby Test** Discord server, never the real **S-Derby** server. The feature map in [`features/`](features/README.md) is the rubric: a feature is done only when every sub-feature there has proof from the real path.

All commands below run from `tools/discord-board-bot/`.

## Launch

```sh
pnpm install --ignore-workspace          # once
./verify/verify.sh up                    # isolated Paperclip on :3199, company BotVerify, agents, keys; ~20 s
./verify/verify.sh bot start             # the bot against :3199 and S-Derby Test
eval "$(./verify/verify.sh env)"         # exports CID, RUN, VERIFY_DIR
```

- `up` is ready when it prints five `ok` lines. It writes `tmp/bot-verify/run.json` (mode 600) with the company ID and the seed and bot keys.
- `bot start` needs `~/.config/sderby-discord-bot/test.env` (mode 600) with `DISCORD_TOKEN`, `DISCORD_GUILD_ID` (S-Derby Test), `DISCORD_BOARD_USER_ID` and `DISCORD_CHANNELS` (JSON of channel name to ID). It is ready when `tmp/bot-verify/bot.log` shows `logged in as` and #bot-status gets "Bot started".
- Without Discord credentials, `./verify/verify.sh preview [channel]` runs the bot's real status and inbox code against the isolated Paperclip and prints the exact payloads it would post. Use it for render checks; it is not proof of a Discord path.

## Doctor

```sh
./verify/verify.sh doctor
```

Checks that Paperclip on :3199 is healthy, built from this checkout's `HEAD`, holds company `BotVerify`, accepts the bot key, and uses the isolated database. Run it first whenever anything looks off. `./verify/verify.sh bot status` reports whether the bot process is alive.

## Drive

- **Paperclip side:** `./verify/verify.sh seed <kind>` creates approvals, questions, confirmations, decisions, tasks, agent comments, Board web comments, status changes, failed runs, long runs and pacing pauses. Agent comments and decisions are posted from inside a real agent run (the `process` adapter runs `verify.sh agent-post`), because Paperclip only accepts them with run context. `./verify/verify.sh api <path>` and `./verify/verify.sh activity` read state back.
- **Discord side, reading:** `./verify/verify.sh discord <channel>` lists the latest messages with embeds and components using the bot token. `--count-by-item` counts inbox messages per attention item for duplicate checks.
- **Discord side, acting as the Board:** use the chrome-devtools MCP tools on `https://discord.com/channels/<guild id>/<channel id>` in a Chrome profile logged in as the Board's Discord account. Click buttons by their label, type slash commands into the message box and pick the command from the popup, then take a screenshot. Bots cannot click other bots' buttons, so the browser is the only real path for user actions.
- The recipes per feature are in `features/*.md`.

## Evidence

- Save every proof under `$VERIFY_DIR/evidence/<feature>/<sub-feature>.*`: the `verify.sh discord` JSON before and after, a Chrome screenshot after the action, and the read-only API or activity read showing the Paperclip change with the Board user as actor.
- Exercise the real user path: a button click in Discord, not a direct API call. Seeding through `verify.sh` is setup, not proof.
- Unit tests (`pnpm test`, Node's test runner with fakes at the Discord and HTTP boundary) are required but count as "unit only".
- Report anything not driven as "not run" with the command tried and the missing precondition.

## Cleanup

```sh
./verify/verify.sh bot stop
./verify/verify.sh down       # stops only the process group it started, deletes the instance data, keeps evidence
```

`down` never touches the live board: it kills the process group recorded in `tmp/bot-verify/paperclip.pid` and deletes `tmp/bot-verify/paperclip`, `run.json` and `bot-state.json`. Evidence in `tmp/bot-verify/evidence/` survives. Delete the test messages in S-Derby Test by hand if the channels get noisy.

## Helpers

- `tools/discord-board-bot/verify/verify.sh` (executable) wraps `verify/harness.ts`; `./verify/verify.sh help` lists every command.
- `verify.sh up` sets `PAPERCLIP_RUNNER_BINARY=/bin/false` because this machine has no Rust toolchain to build the native runner; verification agents use the `process` adapter and never need it. It also turns off pacing auto-resume in the isolated company so seeded pacing pauses stay.
