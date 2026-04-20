/**
 * Compute `sq=` for a tracked URL so brief-app can load the brief without Slack noise.
 * Usage:
 *   node brief-app/scripts/print-slack-suppress-sig.mjs "<full-trk-query-value>"
 *
 * Append to the same URL: &sq=<printed-value> (encode if needed).
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const secret = process.env.TRACKING_SIGNING_SECRET?.trim();
const trk = process.argv[2];

if (!secret) {
  console.error("TRACKING_SIGNING_SECRET missing");
  process.exit(1);
}
if (!trk) {
  console.error('Usage: node print-slack-suppress-sig.mjs "<trk token>"');
  process.exit(1);
}

const msg = `slack-open-suppress:v1:${trk}`;
const sig = crypto.createHmac("sha256", secret).update(msg, "utf8").digest("base64url");

console.log(sig);
