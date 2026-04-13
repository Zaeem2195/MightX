import { NextFetchEvent, NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest, event: NextFetchEvent) {
  const id = request.nextUrl.searchParams.get("id");

  if (id) {
    const timestamp = new Date().toISOString();
    const message = `[ASSET OPENED] Lead ID: ${id} at ${timestamp}`;
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
