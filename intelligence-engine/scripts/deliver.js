/**
 * Delivery Engine — sends the HTML report via email
 * ──────────────────────────────────────────────────
 * Uses nodemailer with any SMTP provider (Gmail, Outlook, etc.)
 * Called by run-client.js after the report is generated.
 */

import 'dotenv/config';
import nodemailer from 'nodemailer';

// ── Build SMTP transporter ────────────────────────────────────────────────────
function createTransporter() {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
  const missing  = required.filter(k => !process.env[k]);

  if (missing.length) {
    throw new Error(`Missing SMTP config: ${missing.join(', ')}. Check your .env file.`);
  }

  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function deliverReport(clientConfig, html, reportContent) {
  const transporter = createTransporter();

  const week    = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const subject = `Intelligence Briefing — ${clientConfig.name} — Week of ${week}`;

  const toList = [
    clientConfig.contactEmail,
    ...(clientConfig.reportCcEmails || []),
  ].filter(Boolean);

  if (!toList.length) {
    throw new Error('No recipient email configured. Set contactEmail in the client config.');
  }

  const fromName  = process.env.SMTP_FROM_NAME  || 'Intelligence Briefing';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

  const info = await transporter.sendMail({
    from:    `"${fromName}" <${fromEmail}>`,
    to:      toList.join(', '),
    subject,
    html,
    text:    `Weekly intelligence briefing for ${clientConfig.name}. Open this email in a browser to view the full report.`,
  });

  const hasTrigger = reportContent?.topAlert?.exists || reportContent?.triggerEmails?.exists;

  console.log(`\n📧  Report delivered:`);
  console.log(`    To:      ${toList.join(', ')}`);
  console.log(`    Subject: ${subject}`);
  console.log(`    ID:      ${info.messageId}`);
  if (hasTrigger) {
    console.log(`    ⚡ Trigger event included — client should act on this promptly.`);
  }

  return info;
}
