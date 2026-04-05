/**
 * Script 5: Classify incoming reply via Claude
 * ─────────────────────────────────────────────
 * Can be called two ways:
 *
 * 1. CLI (manual test):
 *    echo "Thanks, not interested right now." | node scripts/5-classify-replies.js
 *
 * 2. HTTP server mode (for n8n webhook):
 *    node scripts/5-classify-replies.js --serve
 *    Listens on PORT (default 3001) for POST /classify
 *    Body: { "reply": "...", "leadEmail": "...", "leadName": "..." }
 *
 * n8n calls this server via HTTP Request node after Instantly
 * fires a reply webhook. n8n then routes on the classification.
 */

import 'dotenv/config';
import http from 'http';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-haiku-4-5-20251001';   // Fast + cheap for classification
const PORT   = process.env.CLASSIFY_PORT || 3001;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY missing from .env');
  process.exit(1);
}

// ── Load classifier prompt ────────────────────────────────────────────────────
const promptTemplate = fs.readFileSync(
  path.join(ROOT, 'prompts', 'reply-classifier.txt'),
  'utf8'
);

// ── Core classification function ──────────────────────────────────────────────
async function classifyReply(replyText) {
  const prompt = promptTemplate.replace('{{REPLY_TEXT}}', replyText);

  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 300,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw     = message.content[0]?.text?.trim() || '';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// ── CLI mode: read reply from stdin ──────────────────────────────────────────
async function runCLI() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const replyText = Buffer.concat(chunks).toString('utf8').trim();

  if (!replyText) {
    console.error('❌  Pipe a reply into this script: echo "reply text" | node scripts/5-classify-replies.js');
    process.exit(1);
  }

  console.log('\n🔍  Classifying reply...\n');
  const result = await classifyReply(replyText);
  console.log(JSON.stringify(result, null, 2));
}

// ── HTTP server mode: called by n8n ──────────────────────────────────────────
function runServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/classify') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found. POST to /classify' }));
      return;
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body      = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const replyText = body.reply || body.text || body.message || '';

        if (!replyText) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing reply text in body' }));
          return;
        }

        const result = await classifyReply(replyText);

        const response = {
          ...result,
          leadEmail:   body.leadEmail  || null,
          leadName:    body.leadName   || null,
          classifiedAt: new Date().toISOString(),
        };

        console.log(`[${new Date().toISOString()}] ${body.leadEmail || 'unknown'} → ${result.classification} (${result.confidence})`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        console.error('Classification error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`\n🟢  Reply classifier running on http://localhost:${PORT}/classify`);
    console.log(`    n8n HTTP Request node → POST http://YOUR_SERVER:${PORT}/classify`);
    console.log(`    Body: { "reply": "...", "leadEmail": "...", "leadName": "..." }\n`);
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
const serveMode = process.argv.includes('--serve');

if (serveMode) {
  runServer();
} else {
  runCLI().catch(err => {
    console.error('❌  Error:', err.message);
    process.exit(1);
  });
}
