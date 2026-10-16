// Core logic for the share-sequence function, kept free of network imports
// so it can be unit tested with fakes (see handler.test.ts).
//
// The function only does one job: email the recipient of a share the caller
// just created for their own sequence. Everything that goes into the email
// (recipient, sender, sequence name, link) comes from the database or the
// verified session, never from the request body.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Max share emails one user can trigger per rolling hour and day. */
export const HOURLY_LIMIT = 5;
export const DAILY_LIMIT = 20;
/** A share can only be emailed shortly after it is created. */
export const SHARE_FRESH_MS = 10 * 60 * 1000;

export interface AuthedUser {
  id: string;
  email: string | null;
  emailConfirmed: boolean;
}

export interface ShareRow {
  token: string;
  sharedBy: string;
  recipientEmail: string;
  sequenceName: string;
  createdAt: string;
}

export interface Deps {
  /** Resolve the caller from the request's Authorization header. */
  getUser(authHeader: string): Promise<AuthedUser | null>;
  /** Share with this token created by this user (with its sequence name), or null. */
  findOwnShare(userId: string, token: string): Promise<ShareRow | null>;
  /** How many shares this user created since the given time. */
  countSharesSince(userId: string, sinceIso: string): Promise<number>;
  sendEmail(msg: { to: string; subject: string; html: string }): Promise<void>;
  /** Origins the share link may point at, e.g. ["https://app.example.com"]. */
  allowedOrigins: string[];
  /** Used when the request's appUrl is missing or not allowed. */
  defaultOrigin: string;
  now(): number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text for a subject line: no control characters, bounded length. */
export function cleanSubjectText(value: string, max = 120): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

export function pickOrigin(appUrl: unknown, allowed: string[], fallback: string): string {
  if (typeof appUrl !== "string") return fallback;
  try {
    const origin = new URL(appUrl).origin;
    return allowed.includes(origin) ? origin : fallback;
  } catch {
    return fallback;
  }
}

export function buildEmail(share: ShareRow, senderEmail: string, origin: string) {
  const link = `${origin}/shared/${encodeURIComponent(share.token)}`;
  const name = escapeHtml(share.sequenceName);
  const sender = escapeHtml(senderEmail);
  return {
    to: share.recipientEmail,
    subject: `${cleanSubjectText(senderEmail, 255)} shared a sequence with you: ${cleanSubjectText(share.sequenceName)}`,
    html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #10b981;">You've been invited to view a sequence!</h2>
            <p><strong>${sender}</strong> has shared a sequence with you:</p>
            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin: 0; color: #1f2937;">${name}</h3>
            </div>
            <p>Click the button below to view and save this sequence:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapeHtml(link)}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                View Sequence
              </a>
            </div>
            <p style="color: #6b7280; font-size: 14px;">
              If you don't have an account yet, you'll be able to sign up and access this sequence.
            </p>
          </div>
        `,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function handleShareRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "Sign in to share." });

  let user: AuthedUser | null = null;
  try {
    user = await deps.getUser(authHeader);
  } catch {
    user = null;
  }
  if (!user || !user.email) return json(401, { error: "Sign in to share." });
  if (!user.emailConfirmed) return json(403, { error: "Confirm your email before sharing." });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid request." });
  }
  const token = typeof body?.shareToken === "string" ? body.shareToken : "";
  if (!UUID_RE.test(token)) return json(400, { error: "Invalid request." });

  const share = await deps.findOwnShare(user.id, token);
  if (!share || share.sharedBy !== user.id) return json(404, { error: "Share not found." });

  const now = deps.now();
  const created = Date.parse(share.createdAt);
  if (!Number.isFinite(created) || now - created > SHARE_FRESH_MS) {
    return json(409, { error: "This share is too old to email. Create a new share." });
  }

  const hourCount = await deps.countSharesSince(user.id, new Date(now - 60 * 60 * 1000).toISOString());
  const dayCount = await deps.countSharesSince(user.id, new Date(now - 24 * 60 * 60 * 1000).toISOString());
  if (hourCount > HOURLY_LIMIT || dayCount > DAILY_LIMIT) {
    return json(429, { error: "Too many shares. Try again later." });
  }

  const origin = pickOrigin(body.appUrl, deps.allowedOrigins, deps.defaultOrigin);
  try {
    await deps.sendEmail(buildEmail(share, user.email, origin));
  } catch (err) {
    console.error("share-sequence: email send failed", err instanceof Error ? err.message : err);
    return json(502, { error: "Could not send the email. Try again." });
  }
  return json(200, { ok: true });
}
