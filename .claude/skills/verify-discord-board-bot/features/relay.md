# Agent relay

Each decision agent has a channel: #cto, #senior-dev, #validation, #release. A new Board message there becomes a Paperclip task for that agent and a Discord thread. Thread replies become comments that wake the agent; the agent's comments come back into the thread under the agent's name.

## Sub-features

- `relay-new` turns a channel message into a task assigned to the channel's agent and opens a thread named `<identifier> <title>`.
- `relay-reply` turns a thread reply into a Board comment on that task.
- `relay-back` posts the agent's new comments into the thread under the agent's name, split in order when longer than 2,000 characters.
- `relay-web` posts Board comments made in the Paperclip web UI into the thread as "Board (web)".
- `relay-status` posts a one-line notice when the task changes status or is reassigned.
- `relay-reopen` replying to a done task reopens it and posts "reopened"; replying to a cancelled task posts Paperclip's reason and changes nothing.
- `relay-no-loop` ignores the bot's own and webhook messages.

## How to get to it (user POV)

- Write a message in #cto (or another agent channel), then reply in the thread the bot opens.

## Driving it with verify.sh and Chrome

Preconditions:

- `verify.sh doctor` passes and the bot is running against S-Derby Test.

- **New conversation.** In Chrome type `Relay probe [v-$RUN]: check the login timeout` in #cto. Within 15 seconds a thread named `<identifier> Relay probe [v-$RUN]: check the login timeout` appears. `verify.sh api "/companies/$CID/issues?q=Relay probe"` shows one task assigned to the CTO.
- **Reply.** In the thread type `Use 30 seconds`. `verify.sh api /issues/<identifier>/comments` shows a Board comment `Use 30 seconds`.
- **Agent reply.** Run `verify.sh seed agent-comment --agent "CTO" --issue <identifier> --body-file fixtures/long-reply.md` (3,500 characters). Within 15 seconds the thread shows two messages under the name `CTO`, in order, that together equal the file.
- **Web comment.** Run `verify.sh seed board-comment --issue <identifier> --body "From the desk"`. The thread shows `Board (web): From the desk`.
- **Status.** Run `verify.sh seed status --issue <identifier> --status done`. The thread shows a done notice. Reply `One more thing` in the thread. The task is back to `todo` and the thread shows "reopened".
- **No loop.** After all steps, the task has exactly the comments created above; none is a copy of an agent or bot message.
- **Proof.** Save the thread messages JSON and the comment list under `$VERIFY_DIR/evidence/relay/`.

## Gotchas

- Agent comments are posted with the agent's API key from `verify.sh seed agent-comment`; an issue `in_progress` needs a run id, so the seed command leaves the task in `todo` unless told otherwise.
- The agents use `wakeOnDemand: false` in verification. A Board comment would normally wake the agent; prove the wake intent through `verify.sh activity` (`issue.comment_added`), not through a run.
- Thread names are cut to 100 characters.
