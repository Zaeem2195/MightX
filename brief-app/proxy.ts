import { NextFetchEvent, NextRequest, NextResponse } from "next/server";

const DEDUPE_WINDOW_MS = 60_000;
const recentOpenMap = new Map<string, number>();
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

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.method === "HEAD" || isPrefetchRequest(request)) {
    return NextResponse.next();
  }

  const id = request.nextUrl.searchParams.get("id");

  if (id) {
    const timestamp = new Date().toISOString();
    const source = request.nextUrl.searchParams.get("utm_source") || "unknown";
    const campaign = request.nextUrl.searchParams.get("utm_campaign") || "unknown";
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

    const dedupeKey = `${id}::${source}::${campaign}`;
    const nowMs = Date.now();
    const lastOpenAt = recentOpenMap.get(dedupeKey) ?? 0;

    if (nowMs - lastOpenAt < DEDUPE_WINDOW_MS) {
      return NextResponse.next();
    }

    recentOpenMap.set(dedupeKey, nowMs);
    const logLine = `[ASSET OPENED] Lead ID: ${id} at ${timestamp}`;
    console.log(logLine);
    const slackMessage = [
      "*ASSET OPENED*",
      `Lead ID: ${id}`,
      `Time (UTC): ${timestamp}`,
      `Source: ${source}`,
      `Campaign: ${campaign}`,
      `IP: ${ip}`,
      `Path: ${request.nextUrl.pathname}${request.nextUrl.search}`,
      `User-Agent: ${userAgent.slice(0, 140)}`,
    ].join("\n");

    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      event.waitUntil(
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: slackMessage }),
        }).catch(() => {
          // Keep request flow uninterrupted if webhook fails.
        }),
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/brief",
};
