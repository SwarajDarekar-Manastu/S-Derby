import type { ButtonInteraction, Message, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import type { Ctx } from "./main.ts";
import { forDiscord, isDiscordCode } from "./main.ts";
import { PaperclipError, PaperclipUnavailable, type AttentionItem } from "./paperclip.ts";
import { inboxMessage, resolvedMessage, type Embed, type Payload } from "./render.ts";

const POSTS_PER_POLL = 10;

async function allItems(ctx: Ctx): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.pc.attention(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export async function pollInbox(ctx: Ctx): Promise<void> {
  const items = await allItems(ctx);
  const channel = await ctx.channel("board-inbox");
  // A resolved item that is still in the feed two minutes later came back (snooze ended,
  // revision requested): post it again. Within two minutes it is only feed lag.
  const fresh = items.filter((i) => {
    const record = ctx.state.inbox[i.id];
    return !record || (record.resolved && Date.now() - (record.resolvedAt ?? 0) > 120_000);
  });
  for (const item of fresh.slice(0, POSTS_PER_POLL)) {
    // One item that cannot be fetched or rendered must not hold up the rest of the inbox.
    try {
      const message = await channel.send(forDiscord(await renderItem(ctx, item)));
      ctx.state.inbox[item.id] = { messageId: message.id };
    } catch (error) {
      if (error instanceof PaperclipUnavailable) throw error;
      console.error(`[inbox] could not post ${item.id}:`, error);
    }
  }
  if (fresh.length > POSTS_PER_POLL) {
    await channel.send({ content: `…and ${fresh.length - POSTS_PER_POLL} more items. They will post over the next minutes.` });
  }
  const live = new Set(items.map((i) => i.id));
  for (const [id, record] of Object.entries(ctx.state.inbox)) {
    if (record.resolved || live.has(id)) continue;
    await markResolved(ctx, id, "Resolved in Paperclip").catch((error) => console.error(`[inbox] could not resolve ${id}:`, error));
  }
}

async function renderItem(ctx: Ctx, item: AttentionItem): Promise<Payload> {
  const agents = await ctx.agents();
  const base = { agentNames: new Map(agents.map((a) => [a.id, a.name])), boardUserId: ctx.cfg.boardUserId };
  if (item.sourceKind === "approval") return inboxMessage(item, { ...base, approvalPayload: (await ctx.pc.approval(item.subject.id)).payload });
  if (item.sourceKind === "decision") return inboxMessage(item, { ...base, decision: await ctx.pc.decision(item.subject.id) });
  if (item.sourceKind === "issue_thread_interaction") {
    const issueId = String(item.subject.metadata?.issueId ?? item.relatedIssue?.id ?? "");
    const interaction = (await ctx.pc.interactions(issueId)).find((i) => i.id === item.subject.id);
    return inboxMessage(item, { ...base, interaction });
  }
  return inboxMessage(item, base);
}

async function markResolved(ctx: Ctx, itemId: string, outcome: string): Promise<void> {
  const record = ctx.state.inbox[itemId];
  if (!record) return;
  record.resolved = true;
  record.resolvedAt = Date.now();
  const channel = await ctx.channel("board-inbox");
  const message = await channel.messages.fetch(record.messageId).catch((error) => {
    if (isDiscordCode(error, 10008)) return null; // deleted by hand: nothing to update
    throw error;
  });
  if (message) await message.edit(forDiscord(resolvedMessage(payloadOf(message), outcome)));
}

function payloadOf(message: Message): Payload {
  return { content: message.content, embeds: message.embeds.map((e) => e.toJSON() as Embed) };
}

/** Item id lives in each message footer, so a lost state file can be rebuilt from Discord. */
export async function rebuildInbox(ctx: Ctx): Promise<void> {
  if (Object.keys(ctx.state.inbox).length) return;
  const messages = await (await ctx.channel("board-inbox")).messages.fetch({ limit: 100 });
  for (const m of messages.values()) {
    if (m.author.id !== ctx.client.user?.id) continue;
    const itemId = m.embeds[0]?.footer?.text?.match(/item:(\S+)/)?.[1];
    // Resolved messages carry the ✓ title; items shown without buttons are still open.
    const resolved = m.embeds[0]?.title?.startsWith("✓ ") ?? false;
    if (itemId) ctx.state.inbox[itemId] = { messageId: m.id, ...(resolved ? { resolved, resolvedAt: Date.now() } : {}) };
  }
}

const inFlight = new Set<string>();
/** Answers to multi-question cards, collected until every question has one. */
const partialAnswers = new Map<string, Map<number, string[]>>();

type InboxInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

export async function handleInboxInteraction(ctx: Ctx, interaction: InboxInteraction): Promise<void> {
  const [prefix, ...parts] = interaction.customId.split(":");
  const messageId = interaction.message?.id ?? "";
  const itemId = Object.entries(ctx.state.inbox).find(([, r]) => r.messageId === messageId)?.[0];

  // Reject asks for an optional note first; the modal submit comes back here.
  if (prefix === "ap" && parts[1] === "reject" && interaction.isButton()) {
    return interaction.showModal({ custom_id: `apr:${parts[0]}`, title: "Reject approval",
      components: [{ type: 1, components: [{ type: 4, custom_id: "note", label: "Note for the agent (optional)", style: 2, required: false, max_length: 2000 }] }] });
  }
  if (prefix === "dc" && interaction.isButton()) {
    // A modal must be the first answer, so this read has to beat Discord's 3-second limit.
    const decision = await withinDiscordDeadline(ctx.pc.decision(parts[0]));
    const option = decision.options[Number(parts[1])];
    if (decision.status !== "open" || !option) return staleReply(ctx, interaction, itemId, `Decision is already ${decision.status}.`);
    if (decision.inputs?.length) {
      return interaction.showModal({ custom_id: `dcm:${parts[0]}:${parts[1]}`, title: `Option ${Number(parts[1]) + 1}`.slice(0, 45),
        components: decision.inputs.slice(0, 5).map((input) => ({ type: 1, components: [{ type: 4, custom_id: input.id, label: input.label.slice(0, 45),
          style: 2, required: Boolean(input.required), max_length: Math.min(input.maxLength ?? 4000, 4000), placeholder: input.placeholder?.slice(0, 100) ?? undefined }] })) });
    }
  }

  if (inFlight.has(messageId)) return void interaction.reply({ content: "Already working on this one.", flags: 64 });
  inFlight.add(messageId);
  try {
    if (interaction.isModalSubmit()) await interaction.deferUpdate().catch(() => interaction.deferReply({ flags: 64 }));
    else await interaction.deferUpdate();
    const outcome = await act(ctx, interaction, prefix, parts);
    if (outcome === null) return; // partial answer recorded; card stays open
    if (itemId) await markResolved(ctx, itemId, outcome);
  } catch (error) {
    if (error instanceof PaperclipError && [404, 409].includes(error.status)) {
      return staleReply(ctx, interaction, itemId, `Already resolved or changed in Paperclip: ${error.reason}`);
    }
    if (error instanceof PaperclipError && error.status === 422) {
      // Validation failed: the card is still open in Paperclip, so keep it open here.
      return void (await interaction.followUp({ content: `Paperclip said: ${error.reason}`, flags: 64 }));
    }
    throw error;
  } finally {
    inFlight.delete(messageId);
  }
}

async function act(ctx: Ctx, interaction: InboxInteraction, prefix: string, parts: string[]): Promise<string | null> {
  const { pc } = ctx;
  switch (prefix) {
    case "ap":
      await pc.approve(parts[0]);
      return "Approved by the Board via Discord";
    case "apr": {
      const note = interaction.isModalSubmit() ? interaction.fields.getTextInputValue("note").trim() : "";
      await pc.reject(parts[0], note || undefined);
      return `Rejected by the Board via Discord${note ? `: ${note}` : ""}`;
    }
    case "dc":
    case "dcm": {
      const decision = await pc.decision(parts[0]);
      const option = decision.options[Number(parts[1])];
      const inputValues = interaction.isModalSubmit()
        ? Object.fromEntries((decision.inputs ?? []).map((i) => [i.id, interaction.fields.getTextInputValue(i.id)]))
        : undefined;
      await pc.decide(parts[0], option.id, inputValues, `discord:${parts[0]}:${parts[1]}`);
      return `Decided by the Board via Discord: ${option.label}`;
    }
    case "cf": {
      const [issueId, interactionId, verb] = parts;
      if (verb === "accept") await pc.accept(issueId, interactionId);
      else await pc.rejectInteraction(issueId, interactionId);
      return verb === "accept" ? "Confirmed by the Board via Discord" : "Declined by the Board via Discord";
    }
    case "qs": {
      if (!interaction.isStringSelectMenu()) return null;
      const [issueId, interactionId, questionIndex] = parts;
      const card = (await pc.interactions(issueId)).find((i) => i.id === interactionId);
      if (!card || card.status !== "pending") throw new PaperclipError(409, { error: "question card is no longer pending" }, "");
      const questions = (card.payload.questions ?? []) as { id: string; options: { id: string; label: string }[] }[];
      const answers = partialAnswers.get(interactionId) ?? new Map<number, string[]>();
      answers.set(Number(questionIndex), interaction.values);
      partialAnswers.set(interactionId, answers);
      if (answers.size < questions.length) {
        await interaction.followUp({ content: `Answer ${Number(questionIndex) + 1} saved. ${questions.length - answers.size} to go.`, flags: 64 });
        return null;
      }
      await pc.respond(issueId, interactionId, questions.map((q, n) => ({ questionId: q.id, optionIds: answers.get(n) ?? [] })));
      partialAnswers.delete(interactionId);
      const chosen = questions.map((q, n) => (answers.get(n) ?? []).map((id) => q.options.find((o) => o.id === id)?.label ?? id).join(", "));
      return `Answered by the Board via Discord: ${chosen.join(" · ")}`;
    }
    default:
      throw new Error(`unknown button ${prefix}`);
  }
}

function withinDiscordDeadline<T>(request: Promise<T>): Promise<T> {
  return Promise.race([request, new Promise<never>((_, reject) => setTimeout(
    () => reject(new PaperclipUnavailable("Paperclip unavailable: no answer within 2 seconds. Try again.")), 2000).unref())]);
}

async function staleReply(ctx: Ctx, interaction: InboxInteraction, itemId: string | undefined, text: string) {
  const payload = { content: text, flags: 64 } as const;
  await (interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload));
  if (itemId) await markResolved(ctx, itemId, "Resolved in Paperclip");
}
