# Commands

Slash commands let the Board reach any task and any agent from the phone. Agent and task arguments autocomplete from live Paperclip data. Commands that stop work ask for confirmation first.

## Sub-features

- `cmd-task-new` creates a task assigned to the chosen agent with title, optional description and priority.
- `cmd-task-list` lists tasks filtered by agent and status.
- `cmd-task-show` shows a task's title, status, assignee, description and last 5 comments by identifier.
- `cmd-task-comment` adds a Board comment to a task, which wakes the assignee.
- `cmd-agent-show` shows an agent's full card with last 5 comments.
- `cmd-agent-pause` pauses an agent after a confirm button that names runs that will stop.
- `cmd-agent-resume` resumes an agent; its tasks run again without manual work; a pacing pause is reported, not overridden.
- `cmd-agent-wake` wakes an agent and reports a skipped wake with its reason.
- `cmd-agent-raise` sets an agent's concurrent runs (1 to 10) and daily run cap (1 to 200) after showing before and after values.
- `cmd-autocomplete` suggests agent names and task identifiers.

## How to get to it (user POV)

- Type `/task` or `/agent` in any channel of the server and pick a subcommand.

## Driving it with verify.sh and Chrome

Preconditions:

- `verify.sh doctor` passes and the bot is running against S-Derby Test.

- **New task.** In Chrome run `/task new agent:CTO title:Command probe [v-$RUN] priority:high`. The reply shows the new identifier. `verify.sh api "/companies/$CID/issues?q=Command probe"` shows the task assigned to the CTO with priority `high`; `verify.sh activity` shows `issue.created` by the Board user.
- **List and show.** Run `/task list agent:CTO`. The new task is listed. Run `/task show id:<identifier>`. The reply shows the description and comments.
- **Comment.** Run `/task comment id:<identifier> text:Please continue`. `verify.sh api /issues/<identifier>/comments` shows the comment by the Board user.
- **Raise.** Run `/agent raise agent:Developer 1 concurrent:2 daily:40`. The confirmation shows `1 → 2` and `30 → 40`. Click `Apply`. `verify.sh api /agents/<id>` shows `runtimeConfig.heartbeat.maxConcurrentRuns: 2` and `maxDailyRuns: 40`, and every other runtimeConfig key is unchanged.
- **Pause and resume.** Run `verify.sh seed running --agent "Developer 1"` to start a long `process` run on a task. Run `/agent pause agent:Developer 1` and click `Pause`. Then `/agent resume agent:Developer 1`, then `/agent wake agent:Developer 1`. The wake reply is not "skipped", and `verify.sh api /issues/<task>/recovery-actions` shows no active action.
- **Pacing pause.** Run `verify.sh seed pacing-pause --agent "Developer 1"`, then `/agent resume agent:Developer 1`. The reply names the pacing reason and warns it may pause again.
- **Proof.** Screenshot each reply and save the API reads under `$VERIFY_DIR/evidence/commands/`.

## Gotchas

- Guild commands register instantly; global commands can take time. The bot registers guild commands only.
- `PATCH /agents/:id` replaces `runtimeConfig` whole. Prove `raise` kept the other keys, not just the two it set.
- The pause-and-resume recipe needs the resume fix from commit `cc0d14769` in the isolated instance. It runs from this checkout, so it has it.
