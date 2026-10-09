import type { APIRoute } from "astro";
import { generateText } from "ai";
import { anthropic } from "@wix/ai";
import {
  GLOBAL_DAILY_CAP, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, MAX_TURNS, MODEL,
  plain, preflight, readUsage, recordUse, refundUse, reply, summarize, verifyMember,
} from "../../lib/lab";

const SYSTEM = [
  "You are the AI assistant inside the Brittney Empowers AI Lab, a members-only practice space for beginners:",
  "entrepreneurs, small business owners, coaches, and church and ministry leaders.",
  "Carry out the member's prompt directly and well. Use plain, friendly language and keep answers focused and practical.",
  "If their prompt asks you to ask questions first, ask them, briefly.",
  "Members have a small number of chats, so give a complete, useful answer in one reply instead of a teaser.",
  "Do not invent facts about the member's business. Say so when you are unsure.",
  "Write in plain text only: short paragraphs and simple numbered or dashed lists.",
  "Never use Markdown. No asterisks for bold, no pound-sign headings, no backticks, no tables.",
  "You cannot browse the internet or open links. If asked for current news, prices or live information, say you cannot look it up and help with what you know.",
].join(" ");

type Turn = { role: "user" | "assistant"; content: string };

function cleanTurns(raw: unknown): Turn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns: Turn[] = [];
  for (const t of raw.slice(-MAX_TURNS)) {
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") return null;
    const content = t.content.trim().slice(0, MAX_INPUT_CHARS);
    if (!content) return null;
    turns.push({ role: t.role, content });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

export const OPTIONS: APIRoute = ({ request }) => preflight(request);

export const POST: APIRoute = async ({ request }) => {
  let useId: string | null = null;
  let who: any = null;
  let sent = 0;
  try {
    const body = await request.json().catch(() => ({}));
    const turns = cleanTurns(body.messages);
    if (!turns) return reply(request, 400, { error: "bad_request" });

    const member = await verifyMember(body.token);
    if (!member) return reply(request, 401, { error: "not_member" });

    const before = await readUsage(member);
    if (before.remaining <= 0) {
      return reply(request, 429, { error: "limit", tier: member.tier, limit: member.limit, remaining: 0, resetAt: before.resetAt });
    }
    if (before.globalUsed >= GLOBAL_DAILY_CAP) return reply(request, 503, { error: "busy" });

    /* count the chat before spending on the AI call; refund it if the call fails */
    const chars = turns.reduce((n, t) => n + t.content.length, 0);
    who = member;
    sent = chars;
    useId = await recordUse(member, chars);

    const result = await generateText({
      model: anthropic(MODEL),
      system: SYSTEM,
      messages: turns,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const text = plain(result.text || "");
    if (!text) throw new Error("empty_reply");

    /* count from what we already know instead of re-reading, so a slow database read can't show a stale number */
    const after = summarize(member.limit, [...before.times, Date.now()], before.globalUsed + 1);
    return reply(request, 200, { text, tier: member.tier, limit: member.limit, remaining: after.remaining, resetAt: after.resetAt });
  } catch (err) {
    if (useId && who) await refundUse(useId, who, sent, String((err as any)?.message || err));
    console.error("chat failed", err);
    return reply(request, 503, { error: "unavailable" });
  }
};
