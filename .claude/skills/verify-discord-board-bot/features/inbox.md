# Board inbox

The #board-inbox channel gets one message per Paperclip attention item. Each message carries everything needed to decide without opening Paperclip, and buttons for the kinds the bot can resolve. The message updates when the item is resolved anywhere.

## Sub-features

- `inbox-post` posts a new attention item within 30 seconds, with its full content and a "desktop" link.
- `inbox-approval` resolves an approval with Approve or Reject; Reject asks for an optional note.
- `inbox-question` answers an agent's `ask_user_questions` card with one select menu per question.
- `inbox-confirm` accepts or rejects a `request_confirmation` card.
- `inbox-decision` decides an open decision with one button per option, and opens a form when the decision has inputs.
- `inbox-readonly` shows other kinds (blocked task, failed run, budget, recovery, suggested tasks, verdicts) in full with "needs the desktop" and no buttons.
- `inbox-resolved-elsewhere` marks a message "resolved in Paperclip" when the item disappears from the feed.
- `inbox-stale-click` answers "already resolved" when a button is clicked after the item was resolved elsewhere, and changes nothing.
- `inbox-ping` mentions the Board for approvals, decisions and questions, and posts other kinds without a mention.

## How to get to it (user POV)

- Open #board-inbox in Discord and click a button on an item.
- Get a phone notification for an approval, decision or question.

## Driving it with verify.sh and Chrome

Preconditions:

- `verify.sh doctor` passes and the bot is running against S-Derby Test.

- **Approval.** Run `verify.sh seed approval --title "Approve probe [v-$RUN]"`. Within 30 seconds `verify.sh discord board-inbox` shows the item with buttons `Approve` and `Reject` and a mention of the Board. In Chrome click `Approve` on that message. The message changes to "Approved by <Board>". `verify.sh api /approvals/<id>` shows `status: approved`, and `verify.sh activity` shows `approval.approved` by the Board user.
- **Question.** Run `verify.sh seed question --title "Question probe [v-$RUN]"`. In Chrome pick option `B` in the select menu. `verify.sh api /issues/<issue>/interactions` shows the interaction answered with option `b`.
- **Confirmation.** Run `verify.sh seed confirmation`. Click `Confirm`. The interaction is accepted.
- **Decision.** Run `verify.sh seed decision --options 3`. Click the second option. `verify.sh api /decisions/<id>` shows that option chosen. Run `verify.sh seed decision --options 2 --input`. Clicking an option opens a form; submit text; the decision records the input value.
- **Read-only kind.** Run `verify.sh seed failed-run --agent "Developer 1"`. The message has the failure text, "needs the desktop", no buttons and no mention.
- **Resolved elsewhere.** Run `verify.sh seed approval`, wait for the post, then `verify.sh resolve approval <id> --approve`. Within 30 seconds the message reads "resolved in Paperclip".
- **Stale click.** Seed an approval, wait for the post, stop the bot's poller with `verify.sh bot pause-polling`, resolve it through the API, then click `Approve` in Chrome. The ephemeral reply says it is already resolved; activity shows one approval action only.
- **Proof.** For each sub-feature save the message JSON before and after, a screenshot after the click, and the API read, under `$VERIFY_DIR/evidence/inbox/`.

## Gotchas

- Decisions can only be created inside an agent run. `verify.sh seed decision` wakes a `process` agent whose command posts the decision; allow 20 seconds.
- A question card wakes its assignee. Seed it on an issue assigned to an agent with `wakeOnDemand` off, or the agent's run may close it.
- Discord shows "This interaction failed" if the bot does not acknowledge within 3 seconds. That text in a screenshot is a failure even if Paperclip changed.
