# Status board

The #status channel holds one pinned message that the bot edits every minute. It shows each decision agent's state, current task and latest statement, one line per other agent, the subscription windows with reset times, task counts, and pending approvals. Subscription and agent warnings go to #board-inbox.

## Sub-features

- `status-cards` shows a card per decision agent (CTO, Senior Developer, Validation Engineer, Release Manager) with state, current task and latest statement.
- `status-team` shows one line per remaining agent with state and current task.
- `status-subscription` shows each readable provider window with percent used and reset time, and "quota unavailable" for a provider that cannot be read.
- `status-counts` shows open, in-progress, blocked and done task counts and pending approvals.
- `status-single` keeps exactly one pinned status message and recreates it if deleted.
- `status-warn-pause` posts a warning that mentions the Board when an agent is paused by pacing or enters error state.

## How to get to it (user POV)

- Open #status in the Discord app.
- Receive a warning in #board-inbox (phone notification for pause and error warnings).

## Driving it with verify.sh and Chrome

Preconditions:

- `verify.sh doctor` passes and the bot is running against S-Derby Test.

- **Cards.** Create a task for the CTO and post an agent comment. Run `verify.sh seed task --agent "CTO" --title "Status probe [v-$RUN]" --status in_progress` and `verify.sh seed agent-comment --agent "CTO" --issue <id> --body "Working on the status probe"`. Within 70 seconds, `verify.sh discord status` shows the CTO card containing the task identifier and "Working on the status probe".
- **Team line.** Read `verify.sh discord status`. A line for `Developer 1` exists with its state.
- **Subscription.** Read `verify.sh discord status` and `verify.sh api /companies/$CID/costs/quota-windows`. Every provider with `ok: true` appears with the same percentages; every provider with `ok: false` appears as "quota unavailable".
- **Counts.** Compare the counts on the board with `verify.sh api /companies/$CID/dashboard`. They match.
- **Single message.** Delete the status message in Chrome. Within 70 seconds `verify.sh discord status` shows exactly one pinned bot message.
- **Pause warning.** Run `verify.sh seed pacing-pause --agent "Developer 1"`. Within 70 seconds `verify.sh discord board-inbox` shows a warning mentioning the Board user and naming `Developer 1` and the pause reason.
- **Proof.** Screenshot #status in Chrome to `$VERIFY_DIR/evidence/status/board.png` and save `verify.sh discord status` output to `status.json`.

## Gotchas

- The board updates every 60 seconds. Wait at least 70 seconds before asserting, not less.
- Quota windows read the host user's provider login. In the isolated instance they may show real usage of the `ai` user's subscription; compare against the isolated API, not the live board.
- Statements are cut to 300 characters. Assert a prefix, not the whole comment.
