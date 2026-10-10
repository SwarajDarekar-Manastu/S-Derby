# Resilience and safety

The bot survives restarts of itself, Paperclip and Discord without duplicating or losing messages, acts only for the Board, acts once per click, and never relays a ping or a secret.

## Sub-features

- `res-restart` restarting the bot posts no duplicates and catches up on items and comments that arrived while it was down.
- `res-state-lost` deleting the state file and restarting rebuilds mappings from Discord without reposting.
- `res-paperclip-down` stopping Paperclip yields one "down" notice after two failed checks, buttons answer "Paperclip unavailable", and one "back" notice on recovery.
- `res-key-invalid` a revoked board key yields one notice in #bot-status and no further actions.
- `res-unauthorized` another Discord user's command, click or channel message changes nothing and gets "not allowed".
- `res-double-click` two fast clicks on one button act once.
- `res-mentions` relayed `@everyone`, `@here` and role mentions ping nobody.
- `res-secrets` agent text containing `pcp_`, `ghp_`, `github_pat_`, `sk-` or `xox` tokens is relayed as `[redacted]`.
- `res-heartbeat` #bot-status shows an "alive at" line updated every 5 minutes.
- `res-config` a missing or wrong config value stops the bot at startup with a message naming it.

## How to get to it (user POV)

- These are behaviors under failure; the Board sees them as notices in #bot-status and as correct, non-duplicated messages elsewhere.

## Driving it with verify.sh and Chrome

Preconditions:

- `verify.sh doctor` passes and the bot is running against S-Derby Test.

- **Restart.** Run `verify.sh bot stop`, then `verify.sh seed approval` and `verify.sh seed agent-comment` on a relayed task, then `verify.sh bot start`. Within 30 seconds each new item appears once; `verify.sh discord board-inbox --count-by-item` shows no item twice.
- **State lost.** Run `verify.sh bot stop`, delete `$VERIFY_DIR/bot-state.json`, `verify.sh bot start`. No item is reposted, and a click on an older message still works.
- **Paperclip down.** Run `verify.sh paperclip stop`, wait 150 seconds, click a button, then `verify.sh paperclip start`. #bot-status shows one down and one back notice; the click got "Paperclip unavailable".
- **Key invalid.** Run `verify.sh revoke-key`. Within 30 seconds #bot-status shows one notice naming the key; seeding a new approval produces no post.
- **Unauthorized.** Log in to Chrome as the second test Discord account. Run `/task new` and click a button. Both get "not allowed"; `verify.sh activity` shows nothing new.
- **Double click.** Seed an approval and click `Approve` twice quickly in Chrome. `verify.sh activity` shows one `approval.approved`.
- **Mentions and secrets.** Run `verify.sh seed agent-comment --body "@everyone token pcp_board_0123456789abcdef"`. The thread message shows `@everyone` as plain text with no ping, and `[redacted]` instead of the token.
- **Config.** Run `verify.sh bot start --without DISCORD_GUILD_ID`. The bot exits non-zero and prints `DISCORD_GUILD_ID is required`.
- **Proof.** Save #bot-status JSON, activity reads and screenshots under `$VERIFY_DIR/evidence/resilience/`.

## Gotchas

- The unauthorized recipe needs a second Discord account in S-Derby Test. Without it, report `res-unauthorized` as "unit only".
- The "down" notice waits for two failed checks of 60 seconds each. Waiting less proves nothing.
- Revoking the key ends the run's ability to seed through the bot's key; `verify.sh` seeds with its own separate key.
