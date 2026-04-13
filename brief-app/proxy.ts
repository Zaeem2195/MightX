import { NextFetchEvent, NextRequest, NextResponse } from "next/server";

const DEDUPE_WINDOW_MS = 60_000;
const recentOpenMap = new Map<string, number>();

export function proxy(request: NextRequest, event: NextFetchEvent) {
  const id = request.nextUrl.searchParams.get("id");

  if (id) {
    const timestamp = new Date().toISOString();
    const source = request.nextUrl.searchParams.get("utm_source") || "unknown";
    const campaign = request.nextUrl.searchParams.get("utm_campaign") || "unknown";
    const dedupeKey = `${id}::${source}::${campaign}`;
    const nowMs = Date.now();
    const lastOpenAt = recentOpenMap.get(dedupeKey) ?? 0;

    if (nowMs - lastOpenAt < DEDUPE_WINDOW_MS) {
      return NextResponse.next();
    }

    recentOpenMap.set(dedupeKey, nowMs);
    const message = `[ASSET OPENED] Lead ID: ${id} at ${timestamp} | source=${source} | campaign=${campaign}`;
    console.log(message);

    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      event.waitUntil(
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message }),
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
