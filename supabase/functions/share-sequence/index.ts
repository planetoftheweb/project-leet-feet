import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.79.0";
import { handleShareRequest, type Deps } from "./handler.ts";

// Locked down after the 2026-10-16 security audit: the old version emailed
// any address with any sender, name and link taken from the request body.
// See handler.ts for the rules.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

function defaultOrigin(): string {
  const projectRef = SUPABASE_URL.split("//")[1]?.split(".")[0] || "";
  return `https://${projectRef}.lovableproject.com`;
}

// Comma-separated list of origins the share link may use, for example
// "https://kilosayaw.com,https://www.kilosayaw.com". Unlisted origins fall
// back to the default.
const allowedOrigins = (Deno.env.get("SHARE_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

serve((req) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  // Every query runs as the caller, so RLS applies: a user can only see
  // shares they created and their own sequences.
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const deps: Deps = {
    async getUser() {
      const { data, error } = await db.auth.getUser();
      if (error || !data.user) return null;
      return {
        id: data.user.id,
        email: data.user.email ?? null,
        emailConfirmed: Boolean(data.user.email_confirmed_at),
      };
    },
    async findOwnShare(userId, token) {
      const { data, error } = await db
        .from("shared_sequences")
        .select("token, shared_by, shared_with_email, created_at, sequences(name, user_id)")
        .eq("token", token)
        .eq("shared_by", userId)
        .maybeSingle();
      if (error || !data) return null;
      const seq = (Array.isArray(data.sequences) ? data.sequences[0] : data.sequences) as
        | { name: string; user_id: string }
        | null;
      if (!seq || seq.user_id !== userId) return null;
      return {
        token: data.token,
        sharedBy: data.shared_by,
        recipientEmail: data.shared_with_email,
        sequenceName: seq.name,
        createdAt: data.created_at,
      };
    },
    async countSharesSince(userId, sinceIso) {
      const { count, error } = await db
        .from("shared_sequences")
        .select("id", { count: "exact", head: true })
        .eq("shared_by", userId)
        .gte("created_at", sinceIso);
      if (error) throw error;
      return count ?? 0;
    },
    async sendEmail(msg) {
      if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Sequence Sharing <share@kilosayaw.com>",
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
        }),
      });
      if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    },
    allowedOrigins,
    defaultOrigin: defaultOrigin(),
    now: () => Date.now(),
  };

  return handleShareRequest(req, deps);
});
