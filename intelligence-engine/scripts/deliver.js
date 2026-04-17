/**
 * Delivery Engine — sends the HTML report via email
 * ──────────────────────────────────────────────────
 * Two drivers:
 *   1) resend  — HTTPS API (preferred; works past Gmail's ~500/day ceiling,
 *                better deliverability, supports per-client from-domain).
 *   2) smtp    — nodemailer with any SMTP provider (kept for local dev and
 *                operators not yet on a transactional provider).
 *
 * Driver selection:
 *   - If EMAIL_DRIVER is set, it wins ('resend' or 'smtp').
 *   - Else, if RESEND_API_KEY is set, driver is 'resend'.
 *   - Else, driver is 'smtp' (legacy behaviour — unchanged).
 *
 * Per-client branding overrides (optional, in config/clients/<id>.json):
 *   "email": {
 *     "fromName":  "Acme CI Brief",
 *     "fromEmail": "ci@acmecorp-brief.com",
 *     "replyTo":   "success@yourdomain.com"
 *   }
 */

import 'dotenv/config';
import nodemailer from 'nodemailer';

function resolveDriver() {
  const explicit = process.env.EMAIL_DRIVER?.trim().toLowerCase();
  if (explicit === 'resend' || explicit === 'smtp') return explicit;
  if (process.env.RESEND_API_KEY?.trim()) return 'resend';
  return 'smtp';
}

function resolveFrom(clientConfig) {
  const perClient = clientConfig?.email || {};
  const fromName =
    perClient.fromName ||
    process.env.EMAIL_FROM_NAME ||
    process.env.SMTP_FROM_NAME ||
    'Intelligence Briefing';
  const fromEmail =
    perClient.fromEmail ||
    process.env.EMAIL_FROM ||
    process.env.SMTP_FROM_EMAIL ||
    process.env.SMTP_USER;
  const replyTo = perClient.replyTo || process.env.EMAIL_REPLY_TO || null;
  return { fromName, fromEmail, replyTo };
}

function buildSubject(clientConfig) {
  const week = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return `Intelligence Briefing — ${clientConfig.name} — Week of ${week}`;
}

function buildToList(clientConfig) {
  const toList = [
    clientConfig.contactEmail,
    ...(clientConfig.reportCcEmails || []),
  ].filter(Boolean);
  if (!toList.length) {
    throw new Error('No recipient email configured. Set contactEmail in the client config.');
  }
  return toList;
}

function buildPlaintextFallback(clientConfig) {
  const cid = clientConfig.id || 'client';
  const dashLine =
    clientConfig.reportPreferences?.includeDashboard !== false
      ? ` Dashboard (archive + timeline): your operator hosts data/${cid}/dashboard.html or sends a link — regenerated each weekly run.`
      : '';
  return `Weekly intelligence briefing for ${clientConfig.name}. Open this email in a browser to view the full report.${dashLine}`;
}

// ── Resend driver (HTTPS API) ─────────────────────────────────────────────────
async function sendViaResend({ fromName, fromEmail, replyTo, toList, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error('RESEND_API_KEY missing. Set it or switch EMAIL_DRIVER=smtp.');
  if (!fromEmail) {
    throw new Error('No from-address configured. Set EMAIL_FROM (verified on Resend) or SMTP_FROM_EMAIL.');
  }

  const body = {
    from: `${fromName} <${fromEmail}>`,
    to: toList,
    subject,
    html,
    text,
  };
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const reason = payload?.message || payload?.error || `HTTP ${res.status}`;
    throw new Error(`Resend API error: ${reason}`);
  }

  return {
    driver: 'resend',
    messageId: payload?.id || '(no id returned)',
    raw: payload,
  };
}

// ── SMTP driver (legacy, via nodemailer) ──────────────────────────────────────
function createSmtpTransporter() {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing SMTP config: ${missing.join(', ')}. Check your .env file.`);
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendViaSmtp({ fromName, fromEmail, replyTo, toList, subject, html, text }) {
  const transporter = createSmtpTransporter();
  const mail = {
    from: `"${fromName}" <${fromEmail}>`,
    to: toList.join(', '),
    subject,
    html,
    text,
  };
  if (replyTo) mail.replyTo = replyTo;

  const info = await transporter.sendMail(mail);
  return {
    driver: 'smtp',
    messageId: info.messageId,
    raw: info,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function deliverReport(clientConfig, html, reportContent) {
  const driver = resolveDriver();
  const { fromName, fromEmail, replyTo } = resolveFrom(clientConfig);
  const subject = buildSubject(clientConfig);
  const toList = buildToList(clientConfig);
  const text = buildPlaintextFallback(clientConfig);

  const payload = { fromName, fromEmail, replyTo, toList, subject, html, text };

  const result =
    driver === 'resend' ? await sendViaResend(payload) : await sendViaSmtp(payload);

  const hasTrigger = reportContent?.topAlert?.exists || reportContent?.triggerEmails?.exists;

  console.log(`\n📧  Report delivered (driver: ${result.driver}):`);
  console.log(`    From:    ${fromName} <${fromEmail}>`);
  if (replyTo) console.log(`    Reply-to:${replyTo}`);
  console.log(`    To:      ${toList.join(', ')}`);
  console.log(`    Subject: ${subject}`);
  console.log(`    ID:      ${result.messageId}`);
  if (hasTrigger) {
    console.log(`    ⚡ Trigger event included — client should act on this promptly.`);
  }

  return result;
}
