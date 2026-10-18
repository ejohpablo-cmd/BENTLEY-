// Fair-use limits: 4 pictures and 3 million tokens per cycle. When either one is used up, Axelvon
// rests for 1 hour 30 minutes. After the rest the counters start again at zero and the cycle repeats.
//
// The numbers live in the user_usage table. People can read their own row (so the app can show the
// countdown) but only this function can change it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Db = ReturnType<typeof createClient>;

export const IMAGE_LIMIT = 4;
export const TOKEN_LIMIT = 3_000_000;
export const REST_MS = 90 * 60 * 1000; // 1 hour 30 minutes

export type Usage = { tokens: number; images: number };

// Thrown while the person is resting. "until" is when they can use Axelvon again (ISO time).
export class RestingError extends Error {
  until: string;
  constructor(until: string) {
    super("You've used up your limit for now. Axelvon is resting.");
    this.until = until;
  }
}

const NOTHING_USED: Usage = { tokens: 0, images: 0 };

// Call before doing any work. Throws RestingError during a rest; starts a fresh cycle once it is over.
export async function checkUsage(admin: Db, userId: string): Promise<Usage> {
  const { data, error } = await admin
    .from("user_usage")
    .select("tokens_used,images_used,locked_until")
    .eq("user_id", userId)
    .maybeSingle();
  // If the table can't be read, people are not locked out by mistake (the problem is logged).
  if (error) {
    console.error("Could not read usage", error.message);
    return { ...NOTHING_USED };
  }
  if (!data) return { ...NOTHING_USED };

  const until = data.locked_until ? Date.parse(data.locked_until as string) : NaN;
  if (Number.isFinite(until)) {
    if (until > Date.now()) throw new RestingError(data.locked_until as string);
    // The rest is over: start a new cycle.
    await admin
      .from("user_usage")
      .update({ tokens_used: 0, images_used: 0, locked_until: null, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    return { ...NOTHING_USED };
  }
  return { tokens: Number(data.tokens_used) || 0, images: Number(data.images_used) || 0 };
}

// Call after the work is done. Adds what was used and starts the rest when a limit is reached.
export async function recordUsage(admin: Db, userId: string, used: Usage): Promise<void> {
  if (used.tokens <= 0 && used.images <= 0) return;

  const { data } = await admin.from("user_usage").select("tokens_used,images_used").eq("user_id", userId).maybeSingle();
  const tokens = (Number(data?.tokens_used) || 0) + Math.max(0, Math.round(used.tokens));
  const images = (Number(data?.images_used) || 0) + Math.max(0, Math.round(used.images));
  const full = tokens >= TOKEN_LIMIT || images >= IMAGE_LIMIT;

  const { error } = await admin.from("user_usage").upsert(
    {
      user_id: userId,
      tokens_used: tokens,
      images_used: images,
      locked_until: full ? new Date(Date.now() + REST_MS).toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) console.error("Could not save usage", error.message);
}
