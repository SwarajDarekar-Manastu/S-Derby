# Discord Board bot verification map

This directory is the maintained source for verifying the S-Derby Board bot, the Discord bot in `tools/discord-board-bot/` that lets the Board run Paperclip from Discord. Read the index before driving, then use the matching feature file as the recipe. Every feature file is also the done rubric: a feature is done only when every sub-feature has proof from the real path.

## Baseline preconditions

- An isolated Paperclip runs from this checkout on `http://127.0.0.1:3199` with data in `$VERIFY_DIR/paperclip`, started by `verify.sh up`. Never point a verification bot at `localhost:3100`, the live board.
- The isolated company `BotVerify` has the agents `CTO`, `Senior Developer`, `Validation Engineer`, `Release Manager` and `Developer 1`. Their adapter is `process` with command `true`, so no run calls a model.
- The bot runs against the Discord server **S-Derby Test**, never the real **S-Derby** server.
- `verify.sh doctor` passes before any drive.

## Driving conventions

- Paperclip-side setup and proof go through `verify.sh` (seeding, read-only API reads).
- Discord-side user actions (clicking a button, running a slash command, typing in a channel) go through the Discord web app in Chrome, driven with the chrome-devtools MCP tools, logged in as the Board's Discord account. Address controls by their visible label.
- Discord-side state is read with `verify.sh discord <channel>`, which lists the latest messages, embeds and components using the bot token.
- Run one recipe at a time. Seeded items carry a unique `[v-<run id>]` suffix so recipes never confuse their items.

## Proof standards

- Capture the user action and the resulting state on both sides: the Discord message (JSON from `verify.sh discord`, plus a screenshot) and a second, read-only Paperclip read showing the change.
- A Paperclip mutation made from Discord must show the Board user as the actor in `verify.sh activity`.
- Unit tests (`pnpm test` in `tools/discord-board-bot`) use fakes at the Discord and HTTP boundary. They are required, but a sub-feature proved only by unit tests is reported as "unit only", not "verified".
- Report a sub-feature that could not be driven as "not run", with the command tried and the missing precondition. Never report it as verified through a different entry point.
- Evidence goes to `$VERIFY_DIR/evidence/<feature>/<sub-feature>.*` and survives cleanup.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh and Chrome`, `Gotchas`.

## Features

- [Status board](./status.md): the pinned #status message with agent cards, subscription usage and warnings.
- [Board inbox](./inbox.md): items needing a decision, with buttons that resolve them in Paperclip.
- [Commands](./commands.md): `/task` and `/agent` slash commands, including `/agent raise`.
- [Agent relay](./relay.md): conversations with decision agents through channels and threads.
- [Resilience and safety](./resilience.md): restarts, outages, unauthorized users, duplicates, content safety.
