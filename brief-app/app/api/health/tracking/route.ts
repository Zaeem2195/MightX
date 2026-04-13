import { NextResponse } from "next/server";

export async function GET() {
  const timestamp = new Date().toISOString();
  const message = [
    "*ASSET OPENED*",
    "Lead ID: tracking_healthcheck",
    `Time (UTC): ${timestamp}`,
    "Source: healthcheck",
    "Campaign: healthcheck",
    "IP: n/a",
    "Path: /api/health/tracking",
    "User-Agent: internal-healthcheck",
  ].join("\n");
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    return NextResponse.json(
      {
        ok: false,
        sentToSlack: false,
        reason: "SLACK_WEBHOOK_URL is not configured",
        message,
      },
      { status: 500 },
    );
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });

    return NextResponse.json({
      ok: response.ok,
      sentToSlack: response.ok,
      status: response.status,
      message,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        sentToSlack: false,
        reason: "Webhook request failed",
        error: error instanceof Error ? error.message : "Unknown error",
        message,
      },
      { status: 500 },
    );
  }
}
