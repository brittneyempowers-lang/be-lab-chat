import { auth } from "@wix/essentials";
import { items } from "@wix/data";

/* ---- settings (none of these are secret) ---- */
export const LIVE_API = "https://www.wixapis.com";
export const ALLOWED_ORIGINS = ["https://www.brittneyempowers.com", "https://brittneyempowers.com"];
export const COLLECTION = "LabChatUsage";
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MODEL = "claude-haiku-5-5";
export const MAX_INPUT_CHARS = 6000;
export const MAX_TURNS = 8;
export const MAX_OUTPUT_TOKENS = 1500;
/* Safety valve for the whole lab: no more than this many chats in any 24 hours. */
export const GLOBAL_DAILY_CAP = 400;
/* plan id on brittneyempowers.com -> chats allowed per rolling 24 hours */
export const PLAN_LIMITS: Record<string, { tier: string; limit: number }> = {
  "2f248d82-291c-4120-9d9a-6039a42a8005": { tier: "one-time", limit: 3 },
};

export function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

export function reply(request: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: cors(request) });
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: cors(request) });
}

export type Member = { memberId: string; tier: string; limit: number };

/* Ask the live site who this token belongs to and which lab plans they hold.
   The token is the member's own sign-in token from brittneyempowers.com, so
   Wix only answers with that member's orders. */
export async function verifyMember(token: unknown): Promise<Member | null> {
  if (typeof token !== "string" || token.length < 40 || token.length > 6000) return null;
  let res: Response;
  try {
    res = await fetch(`${LIVE_API}/pricing-plans/v2/member/orders?orderStatuses=ACTIVE`, {
      headers: { Authorization: token, "Content-Type": "application/json" },
    });
  } catch {
    throw new Error("verify_unreachable");
  }
  if (res.status === 401 || res.status === 403 || res.status === 400) return null;
  if (!res.ok) throw new Error("verify_failed_" + res.status);
  const data = (await res.json()) as { orders?: any[] };
  let best: Member | null = null;
  for (const o of data.orders || []) {
    const plan = PLAN_LIMITS[o.planId];
    const memberId = o.buyer && o.buyer.memberId;
    if (!plan || o.status !== "ACTIVE" || typeof memberId !== "string") continue;
    if (!best || plan.limit > best.limit) best = { memberId, tier: plan.tier, limit: plan.limit };
  }
  return best;
}

export type Usage = { used: number; remaining: number; resetAt: string | null; globalUsed: number };

export async function readUsage(member: Member): Promise<Usage> {
  const since = new Date(Date.now() - WINDOW_MS);
  const query = auth.elevate(items.query);
  const mine = await query(COLLECTION).eq("memberId", member.memberId).gt("_createdDate", since).ascending("_createdDate").limit(100).find();
  const count = auth.elevate(items.count);
  const globalUsed = await count(COLLECTION, { filter: { _createdDate: { $gt: { $date: since.toISOString() } } } } as any).then(
    (r: any) => (typeof r === "number" ? r : r?.totalCount ?? 0),
    () => 0,
  );
  const used = mine.items.length;
  const remaining = Math.max(0, member.limit - used);
  let resetAt: string | null = null;
  if (remaining === 0 && used > 0) {
    /* the slot that frees up first is the oldest chat still inside the window */
    const freeing = mine.items[used - member.limit] || mine.items[0];
    const created = new Date((freeing as any)._createdDate);
    resetAt = new Date(created.getTime() + WINDOW_MS).toISOString();
  }
  return { used, remaining, resetAt, globalUsed };
}

export async function recordUse(member: Member, chars: number): Promise<string> {
  const insert = auth.elevate(items.insert);
  const row: any = await insert(COLLECTION, { memberId: member.memberId, tier: member.tier, chars });
  return row._id;
}

export async function refundUse(id: string): Promise<void> {
  try {
    await auth.elevate(items.remove)(COLLECTION, id);
  } catch {
    /* a failed refund only costs the member one chat; never fail the request over it */
  }
}
