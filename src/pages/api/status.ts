import type { APIRoute } from "astro";
import { preflight, readUsage, reply, verifyMember } from "../../lib/lab";

export const OPTIONS: APIRoute = ({ request }) => preflight(request);

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const member = await verifyMember(body.token);
    if (!member) return reply(request, 401, { error: "not_member" });
    const usage = await readUsage(member);
    return reply(request, 200, { tier: member.tier, limit: member.limit, used: usage.used, remaining: usage.remaining, resetAt: usage.resetAt });
  } catch (err) {
    console.error("status failed", err);
    return reply(request, 503, { error: "unavailable" });
  }
};
