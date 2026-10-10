import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import type { Ctx } from "./main.ts";
import { forDiscord } from "./main.ts";
import type { Agent } from "./paperclip.ts";
import { concurrency, cut, dailyCap, pauseReasonText, taskSummary } from "./render.ts";
import { gatherStatus } from "./status.ts";
import { statusBoard } from "./render.ts";

const STRING = 3, INTEGER = 4, SUB = 1;
const CONFIRM_TTL_MS = 120_000;
const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

const agentOption = { type: STRING, name: "agent", description: "Agent name", required: true, autocomplete: true };
const taskOption = { type: STRING, name: "id", description: "Task identifier, for example SDEA-42", required: true, autocomplete: true };

export function commandDefinitions() {
  return [
    {
      name: "task", description: "Work with Paperclip tasks",
      options: [
        { type: SUB, name: "new", description: "Create a task for an agent", options: [
          agentOption,
          { type: STRING, name: "title", description: "Task title", required: true, max_length: 200 },
          { type: STRING, name: "description", description: "What to do", required: false, max_length: 4000 },
          { type: STRING, name: "priority", description: "Priority (default medium)", required: false, choices: PRIORITIES.map((p) => ({ name: p, value: p })) },
        ] },
        { type: SUB, name: "list", description: "List open tasks", options: [
          { ...agentOption, required: false },
          { type: STRING, name: "status", description: "Only this status", required: false, choices: STATUSES.map((s) => ({ name: s.replaceAll("_", " "), value: s })) },
        ] },
        { type: SUB, name: "show", description: "Show a task with its latest comments", options: [taskOption] },
        { type: SUB, name: "comment", description: "Comment on a task; wakes its agent", options: [
          taskOption, { type: STRING, name: "text", description: "Your comment", required: true, max_length: 4000 },
        ] },
      ],
    },
    {
      name: "agent", description: "Look after Paperclip agents",
      options: [
        { type: SUB, name: "show", description: "An agent's state, task, statement and limits", options: [agentOption] },
        { type: SUB, name: "pause", description: "Pause an agent (asks first)", options: [agentOption] },
        { type: SUB, name: "resume", description: "Resume a paused agent and wake it", options: [agentOption] },
        { type: SUB, name: "wake", description: "Wake an agent now", options: [agentOption] },
        { type: SUB, name: "raise", description: "Change concurrent runs and the daily run cap (asks first)", options: [
          agentOption,
          { type: INTEGER, name: "concurrent", description: "Runs at the same time (1-10)", required: false, min_value: 1, max_value: 10 },
          { type: INTEGER, name: "daily", description: "Runs per day (1-200)", required: false, min_value: 1, max_value: 200 },
        ] },
      ],
    },
  ];
}

export async function handleCommand(ctx: Ctx, interaction: AutocompleteInteraction | ChatInputCommandInteraction): Promise<void> {
  if (interaction.isAutocomplete()) return autocomplete(ctx, interaction);
  if (interaction.user.id !== ctx.cfg.boardUserId) {
    return void interaction.reply({ content: "Not allowed: this bot only acts for the S-Derby Board.", flags: 64 });
  }
  await interaction.deferReply({ flags: 64 });
  const sub = interaction.options.getSubcommand();
  const reply = (content: string) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  const agentArg = async (required = true): Promise<Agent | undefined> => {
    const name = interaction.options.getString("agent", required);
    if (!name) return undefined;
    const agent = await ctx.agentByName(name);
    if (!agent) throw new UserError(`No agent named "${name}".`);
    return agent;
  };

  try {
    if (interaction.commandName === "task") {
      if (sub === "new") {
        const agent = (await agentArg())!;
        const issue = await ctx.pc.createIssue({
          title: interaction.options.getString("title", true),
          description: interaction.options.getString("description") ?? undefined,
          priority: interaction.options.getString("priority") ?? "medium",
          assigneeAgentId: agent.id,
        });
        const paused = agent.status === "paused" ? ` ${agent.name} is paused (${pauseReasonText(agent.pauseReason)}); it starts after \`/agent resume\`.` : "";
        return void (await reply(`Created \`${issue.identifier}\` ${issue.title} for ${agent.name}.${paused}`));
      }
      if (sub === "list") {
        const agent = await agentArg(false);
        const status = interaction.options.getString("status") ?? "todo,in_progress,in_review,blocked";
        const issues = await ctx.pc.issues({ status, assigneeAgentId: agent?.id, limit: 25 });
        const names = new Map((await ctx.agents()).map((a) => [a.id, a.name]));
        const lines = issues.map((i) => `\`${i.identifier}\` ${cut(i.title, 70)} · ${i.status.replaceAll("_", " ")} · ${names.get(i.assigneeAgentId ?? "") ?? "unassigned"}`);
        return void (await reply(lines.length ? cut(lines.join("\n"), 1990) : "No matching tasks."));
      }
      const issue = await ctx.pc.issue(interaction.options.getString("id", true));
      if (sub === "show") {
        const names = new Map((await ctx.agents()).map((a) => [a.id, a.name]));
        const comments = await ctx.pc.lastComments(issue.id, 5);
        return void (await interaction.editReply(forDiscord(taskSummary(issue, names.get(issue.assigneeAgentId ?? "") ?? null, comments, names))));
      }
      if (sub === "comment") {
        const comment = await ctx.pc.comment(issue.id, interaction.options.getString("text", true));
        ctx.state.ownComments.push(comment.id);
        ctx.save();
        return void (await reply(`Commented on \`${issue.identifier}\`; its agent was woken.`));
      }
    }

    const agent = (await agentArg())!;
    switch (sub) {
      case "show": {
        const input = await gatherStatus(ctx);
        const board = statusBoard({ ...input, agents: input.agents.filter((s) => s.agent.id === agent.id) });
        const card = board.embeds?.[0];
        const limits = `Limits: ${concurrency(agent)} at a time · ${dailyCap(agent) ?? "no"} runs per day`;
        return void (await interaction.editReply({ embeds: card ? [{ ...card, footer: { text: limits } }] : [], content: card ? "" : `${agent.name}: ${limits}`, allowedMentions: { parse: [] } }));
      }
      case "pause":
        return void (await interaction.editReply({
          content: `Pause **${agent.name}**? Any run in progress stops now.`,
          components: [{ type: 1, components: [{ type: 2, style: 4, label: "Pause", custom_id: `ag:pause:${agent.id}:${Date.now()}` }] }],
        }));
      case "resume": {
        const pacing = agent.pauseReason === "subscription_pacing";
        await ctx.pc.resume(agent.id);
        const wake = await ctx.pc.wake(agent.id);
        const woke = wake.status === "skipped" ? `Wake skipped: ${wake.message ?? wake.reason ?? "no reason given"}.` : "Woken.";
        return void (await reply(`Resumed **${agent.name}**. ${woke}${pacing ? "\n⚠️ It was paused by subscription pacing; pacing may pause it again until the window resets." : ""}`));
      }
      case "wake": {
        const wake = await ctx.pc.wake(agent.id);
        return void (await reply(wake.status === "skipped" ? `Wake skipped: ${wake.message ?? wake.reason ?? "no reason given"}.` : `Woke **${agent.name}**.`));
      }
      case "raise": {
        const c = interaction.options.getInteger("concurrent") ?? concurrency(agent);
        const d = interaction.options.getInteger("daily") ?? dailyCap(agent) ?? 30;
        if (c === concurrency(agent) && d === dailyCap(agent)) return void (await reply("Nothing to change."));
        return void (await interaction.editReply({
          content: `**${agent.name}**\nRuns at the same time: ${concurrency(agent)} → **${c}**\nRuns per day: ${dailyCap(agent) ?? "none"} → **${d}**\nMore concurrent runs use the subscription faster.`,
          components: [{ type: 1, components: [{ type: 2, style: 1, label: "Apply", custom_id: `ag:raise:${agent.id}:${c}:${d}:${Date.now()}` }] }],
        }));
      }
    }
  } catch (error) {
    if (error instanceof UserError) return void (await reply(error.message));
    throw error;
  }
}

/** Confirm buttons from /agent pause and /agent raise. They expire after two minutes. */
export async function handleCommandComponent(ctx: Ctx, interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<void> {
  if (!interaction.isButton()) return;
  const [, action, agentId, ...rest] = interaction.customId.split(":");
  const issuedAt = Number(rest.at(-1));
  if (Date.now() - issuedAt > CONFIRM_TTL_MS) return void interaction.update({ content: "Expired. Run the command again.", components: [] });
  await interaction.update({ content: "Working…", components: [] });
  const agent = await ctx.pc.agent(agentId);
  if (action === "pause") {
    await ctx.pc.pause(agentId);
    return void (await interaction.editReply({ content: `Paused **${agent.name}**.` }));
  }
  if (action === "raise") {
    const [c, d] = rest.map(Number);
    const runtimeConfig = { ...(agent.runtimeConfig ?? {}) };
    // PATCH replaces runtimeConfig whole: keep every other key as it was.
    runtimeConfig.heartbeat = { ...((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>), maxConcurrentRuns: c, maxDailyRuns: d };
    const updated = await ctx.pc.patchAgent(agentId, { runtimeConfig });
    return void (await interaction.editReply({ content: `**${agent.name}** now runs ${concurrency(updated)} at a time, ${dailyCap(updated)} per day.` }));
  }
}

async function autocomplete(ctx: Ctx, interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused(true);
  const typed = String(focused.value).toLowerCase();
  if (interaction.user.id !== ctx.cfg.boardUserId) return interaction.respond([]);
  if (focused.name === "agent") {
    const agents = (await ctx.agents()).filter((a) => a.status !== "terminated" && a.name.toLowerCase().includes(typed));
    return interaction.respond(agents.slice(0, 25).map((a) => ({ name: a.name, value: a.name })));
  }
  const issues = await ctx.pc.issues({ q: typed || undefined, status: "todo,in_progress,in_review,blocked,backlog", limit: 25 });
  return interaction.respond(issues.slice(0, 25).map((i) => ({ name: cut(`${i.identifier} ${i.title}`, 100), value: i.identifier })));
}

class UserError extends Error {}
