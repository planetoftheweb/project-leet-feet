// Run: deno test supabase/functions/share-sequence/handler.test.ts
import { assertEquals, assert } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  DAILY_LIMIT,
  HOURLY_LIMIT,
  escapeHtml,
  handleShareRequest,
  pickOrigin,
  type Deps,
  type ShareRow,
} from "./handler.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const TOKEN = "11111111-2222-4333-8444-555555555555";

function makeDeps(overrides: Partial<Deps> = {}, share: Partial<ShareRow> = {}) {
  const sent: { to: string; subject: string; html: string }[] = [];
  const row: ShareRow = {
    token: TOKEN,
    sharedBy: "user-1",
    recipientEmail: "friend@example.com",
    sequenceName: "Warmup",
    createdAt: new Date(NOW - 30_000).toISOString(),
    ...share,
  };
  const deps: Deps = {
    getUser: async (h) => (h === "Bearer good" ? { id: "user-1", email: "me@example.com", emailConfirmed: true } : null),
    findOwnShare: async (userId, token) => (userId === row.sharedBy && token === row.token ? row : null),
    countSharesSince: async () => 1,
    sendEmail: async (m) => { sent.push(m); },
    allowedOrigins: ["https://app.example.com"],
    defaultOrigin: "https://default.example.com",
    now: () => NOW,
    ...overrides,
  };
  return { deps, sent };
}

function post(body: unknown, auth = "Bearer good") {
  return new Request("https://fn.example.com/share-sequence", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("normal share: emails the stored recipient with a fixed template", async () => {
  const { deps, sent } = makeDeps();
  const res = await handleShareRequest(post({ shareToken: TOKEN, appUrl: "https://app.example.com/editor" }), deps);
  assertEquals(res.status, 200);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, "friend@example.com");
  assert(sent[0].html.includes(`https://app.example.com/shared/${TOKEN}`));
  assert(sent[0].html.includes("me@example.com"));
});

Deno.test("attack: body recipient, sender and name are ignored", async () => {
  const { deps, sent } = makeDeps();
  const res = await handleShareRequest(post({
    shareToken: TOKEN,
    recipientEmail: "victim@bank.example",
    senderEmail: "security@bank.example",
    sequenceName: "Your account is locked",
  }), deps);
  assertEquals(res.status, 200);
  assertEquals(sent[0].to, "friend@example.com");
  assert(!sent[0].html.includes("security@bank.example"));
  assert(!sent[0].subject.includes("account is locked"));
});

Deno.test("attack: link cannot point at an attacker site", async () => {
  const { deps, sent } = makeDeps();
  await handleShareRequest(post({ shareToken: TOKEN, appUrl: "https://evil.example/phish" }), deps);
  assert(sent[0].html.includes("https://default.example.com/shared/"));
  assert(!sent[0].html.includes("evil.example"));
});

Deno.test("attack: HTML in the sequence name is escaped", async () => {
  const { deps, sent } = makeDeps({}, { sequenceName: '<a href="https://evil.example">Click</a><img src=x onerror=alert(1)>' });
  await handleShareRequest(post({ shareToken: TOKEN }), deps);
  assert(!sent[0].html.includes("<img"));
  assert(!sent[0].html.includes('<a href="https://evil.example"'));
  assert(sent[0].html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

Deno.test("attack: signed-out or unknown callers are rejected", async () => {
  const { deps, sent } = makeDeps();
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }, ""), deps)).status, 401);
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }, "Bearer forged"), deps)).status, 401);
  assertEquals(sent.length, 0);
});

Deno.test("attack: unconfirmed email accounts cannot send", async () => {
  const { deps, sent } = makeDeps({
    getUser: async () => ({ id: "user-1", email: "me@example.com", emailConfirmed: false }),
  });
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }), deps)).status, 403);
  assertEquals(sent.length, 0);
});

Deno.test("attack: someone else's share token is rejected", async () => {
  const { deps, sent } = makeDeps({}, { sharedBy: "user-2" });
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }), deps)).status, 404);
  assertEquals((await handleShareRequest(post({ shareToken: "not-a-uuid" }), deps)).status, 400);
  assertEquals(sent.length, 0);
});

Deno.test("attack: an old share cannot be re-sent over and over", async () => {
  const { deps, sent } = makeDeps({}, { createdAt: new Date(NOW - 60 * 60 * 1000).toISOString() });
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }), deps)).status, 409);
  assertEquals(sent.length, 0);
});

Deno.test("rate limit: hourly and daily caps", async () => {
  const hourly = makeDeps({ countSharesSince: async () => HOURLY_LIMIT + 1 });
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }), hourly.deps)).status, 429);
  const daily = makeDeps({
    countSharesSince: async (_u, since) => (Date.parse(since) < NOW - 2 * 60 * 60 * 1000 ? DAILY_LIMIT + 1 : 1),
  });
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }), daily.deps)).status, 429);
  const ok = makeDeps({ countSharesSince: async () => HOURLY_LIMIT });
  assertEquals((await handleShareRequest(post({ shareToken: TOKEN }), ok.deps)).status, 200);
  assertEquals(hourly.sent.length + daily.sent.length, 0);
});

Deno.test("helpers", () => {
  assertEquals(escapeHtml(`<"'&>`), "&lt;&quot;&#39;&amp;&gt;");
  assertEquals(pickOrigin("https://app.example.com/x?y", ["https://app.example.com"], "https://d"), "https://app.example.com");
  assertEquals(pickOrigin("javascript:alert(1)", ["https://app.example.com"], "https://d"), "https://d");
  assertEquals(pickOrigin(undefined, [], "https://d"), "https://d");
});
