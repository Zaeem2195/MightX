import { NextFetchEvent, NextRequest, NextResponse } from "next/server";

const DEDUPE_WINDOW_MS = 60_000;
const recentOpenMap = new Map<string, number>();
const TRACKING_SIGNING_SECRET = process.env.TRACKING_SIGNING_SECRET?.trim();

/** Comma-separated recipient emails (from signed token) — no Slack ping (test inboxes). */
function slackSkipRecipients(): Set<string> {
  const raw = process.env.TRACKING_SLACK_SKIP_RECIPIENTS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function verifySlackSuppressSig(trk: string, sq: string | null): Promise<boolean> {
  if (!sq || !TRACKING_SIGNING_SECRET || !trk) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TRACKING_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`slack-open-suppress:v1:${trk}`),
  );
  const expected = base64UrlEncode(signed);
  return safeEquals(expected, sq);
}
const BOT_UA_PATTERNS = [
  /bot/i,
  /spider/i,
  /crawler/i,
  /preview/i,
  /facebookexternalhit/i,
  /slackbot/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /discordbot/i,
];

function isPrefetchRequest(request: NextRequest) {
  const purpose = request.headers.get("purpose");
  const secPurpose = request.headers.get("sec-purpose");
  const nextPrefetch = request.headers.get("next-router-prefetch");
  const middlewarePrefetch = request.headers.get("x-middleware-prefetch");

  return (
    purpose === "prefetch" ||
    secPurpose === "prefetch" ||
    nextPrefetch === "1" ||
    middlewarePrefetch === "1"
  );
}

function isLikelyBotUserAgent(userAgent: string) {
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}

function toBase64(base64UrlValue: string) {
  const base64 = base64UrlValue.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (base64.length % 4)) % 4;
  return `${base64}${"=".repeat(padding)}`;
}

function decodeBase64Url(base64UrlValue: string) {
  return atob(toBase64(base64UrlValue));
}

function base64UrlEncode(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let raw = "";
  for (const byte of view) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function safeEquals(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

type TrackingPayload = {
  v: number;
  i: string;
  e: string;
  c?: string;
  exp: number;
};

async function verifyTrackingToken(token: string): Promise<TrackingPayload | null> {
  if (!TRACKING_SIGNING_SECRET) return null;
  const [payloadB64, providedSignature] = token.split(".");
  if (!payloadB64 || !providedSignature) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TRACKING_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );
  const expectedSignature = base64UrlEncode(signed);
  if (!safeEquals(expectedSignature, providedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(payloadB64)) as TrackingPayload;
    if (
      payload?.v !== 1 ||
      !payload?.i ||
      !payload?.e ||
      typeof payload?.exp !== "number"
    ) {
      return null;
    }
    if (Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.method === "HEAD" || isPrefetchRequest(request)) {
    return NextResponse.next();
  }

  const trackingToken = request.nextUrl.searchParams.get("trk");
  const id = request.nextUrl.searchParams.get("id");

  if (trackingToken) {
    const timestamp = new Date().toISOString();
    const source = request.nextUrl.searchParams.get("utm_source") || "unknown";
    const campaignParam =
      request.nextUrl.searchParams.get("utm_campaign") || "unknown";
    const userAgent = request.headers.get("user-agent") || "unknown";
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";

    if (isLikelyBotUserAgent(userAgent)) {
      console.log(
        `[ASSET SKIPPED] Lead ID: ${id} at ${timestamp} (bot user-agent detected)`,
      );
      return NextResponse.next();
    }

    const verifiedPayload = await verifyTrackingToken(trackingToken);
    if (!verifiedPayload) {
      return NextResponse.next();
    }

    const suppressSq = request.nextUrl.searchParams.get("sq");
    const slackQuiet =
      (await verifySlackSuppressSig(trackingToken, suppressSq)) === true;

    const leadId = id || verifiedPayload.i;
    const campaign = verifiedPayload.c || campaignParam;
    const recipientEmail = verifiedPayload.e.toLowerCase();
    const skipForTestInbox = slackSkipRecipients().has(recipientEmail);
    const dedupeKey = `${recipientEmail}::${leadId}::${campaign}`;
    const nowMs = Date.now();
    const lastOpenAt = recentOpenMap.get(dedupeKey) ?? 0;

    if (nowMs - lastOpenAt < DEDUPE_WINDOW_MS) {
      return NextResponse.next();
    }

    recentOpenMap.set(dedupeKey, nowMs);
    const logLine = `[ASSET OPENED] Lead ID: ${leadId} at ${timestamp}`;
    console.log(logLine);

    const defaultAttribution =
      "Note: Slack fires when this signed URL loads in a browser — not proof the mailbox owner clicked (internal QA, forwards, or inbox previews can trigger).";
    const attributionLine =
      process.env.TRACKING_SLACK_ATTRIBUTION_NOTE?.trim() || defaultAttribution;

    const slackMessage = [
      "*ASSET OPENED*",
      `Lead ID: ${leadId}`,
      `Email (encoded in token): ${recipientEmail}`,
      `Time (UTC): ${timestamp}`,
      `Source: ${source}`,
      `Campaign: ${campaign}`,
      `IP: ${ip}`,
      `Path: ${request.nextUrl.pathname}${request.nextUrl.search}`,
      `User-Agent: ${userAgent.slice(0, 140)}`,
      "",
      attributionLine,
    ].join("\n");

    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl && !slackQuiet && !skipForTestInbox) {
      event.waitUntil(
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: slackMessage }),
        }).catch(() => {
          // Keep request flow uninterrupted if webhook fails.
        }),
      );
    } else if (webhookUrl && (slackQuiet || skipForTestInbox)) {
      console.log(
        `[ASSET OPENED] Slack skipped (${slackQuiet ? "valid sq= suppress sig" : "TRACKING_SLACK_SKIP_RECIPIENTS"})`,
      );
    }
  }

  return NextResponse.next();
}

// `/brief` — dynamic Next route. `/:slug-brief.html` — static HTML from
// `scripts/generate-html-brief.js` (public/<slug>-brief.html). Both use ?id= for tracking.
export const config = {
  matcher: ["/brief", "/((?!_next/|api/).*)-brief.html"],
};
