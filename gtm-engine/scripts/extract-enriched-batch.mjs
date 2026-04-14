/**
 * Extract leads from enriched JSON by field match, write a batch file, update
 * the master in place. Optional Instantly push: use generate-copy + push-instantly
 * on the batch + copy files (this script only mutates JSON).
 *
 * Usage (from gtm-engine):
 *   node scripts/extract-enriched-batch.mjs --dry-run
 *   node scripts/extract-enriched-batch.mjs --no-instantly
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const DEFAULT_SOURCE = "enriched-2026-04-06T15-55-49.json";
const DEFAULT_FIELD = "companyIndustry";
const DEFAULT_EQUALS = "e-learning";

function slugForFilename(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "batch"
  );
}

function fieldValue(lead, field) {
  const p = lead.personalization;
  let raw;
  if (p && typeof p === "object" && field in p && p[field] != null) {
    raw = p[field];
  } else {
    raw = lead[field];
  }
  return raw == null ? "" : String(raw).trim();
}

function normCompact(s) {
  return String(s).toLowerCase().replace(/[\s_\-]+/g, "");
}

function matchesEquals(leadVal, target) {
  if (!leadVal || !target) return false;
  const a = leadVal.trim();
  const b = target.trim();
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return normCompact(a) === normCompact(b);
}

function matchesContains(leadVal, sub) {
  if (!leadVal || !sub) return false;
  return leadVal.toLowerCase().includes(sub.trim().toLowerCase());
}

function leadMatches(lead, field, equals, contains) {
  const val = fieldValue(lead, field);
  if (contains != null) return matchesContains(val, contains);
  return matchesEquals(val, equals);
}

function defaultBatchFilename(field, equals, contains) {
  const fslug = slugForFilename(field);
  const vslug = slugForFilename(contains != null ? contains : equals || "");
  const mode = contains != null ? "contains" : "equals";
  return `processed-${fslug}-${vslug}-${mode}-batch.json`;
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    dryRun: has("--dry-run"),
    noInstantly: has("--no-instantly"),
    source: val("--source") || DEFAULT_SOURCE,
    field: val("--field") || DEFAULT_FIELD,
    equals: val("--equals"),
    contains: val("--contains"),
    batchOut: val("--batch-out"),
  };
}

function main() {
  const args = parseArgs();
  const field = (args.field || "").trim();
  let contains = args.contains != null ? String(args.contains).trim() : null;
  if (contains === "") contains = null;

  let equals = null;
  if (contains == null) {
    equals = (args.equals != null ? String(args.equals) : DEFAULT_EQUALS).trim();
    if (!equals) {
      console.error("ERROR: --equals must be non-empty (or use --contains).");
      process.exit(1);
    }
  } else if (args.equals != null && String(args.equals).trim()) {
    console.error("ERROR: use only one of --equals or --contains.");
    process.exit(1);
  }

  const sourcePath = path.join(DATA_DIR, args.source);
  const batchRel =
    args.batchOut || defaultBatchFilename(field, equals, contains);
  const batchPath = path.isAbsolute(batchRel)
    ? batchRel
    : path.join(DATA_DIR, batchRel);

  if (!fs.existsSync(sourcePath)) {
    console.error(`ERROR: Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  const doc = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const leads = Array.isArray(doc.leads) ? doc.leads : [];
  const beforeTotal = leads.length;
  const extracted = leads.filter((L) =>
    leadMatches(L, field, equals, contains),
  );
  const remaining = leads.filter(
    (L) => !leadMatches(L, field, equals, contains),
  );

  const extractedCount = extracted.length;
  const remainingCount = remaining.length;
  const desc =
    contains != null
      ? `${field} contains "${contains}" (case-insensitive)`
      : `${field} equals "${equals}" (case-insensitive; spacing/hyphen variants folded)`;

  console.log("--- Safety: counts ---");
  console.log(`  Leads in source file (${path.basename(sourcePath)}):     ${beforeTotal}`);
  console.log(`  Matched (${desc}):              ${extractedCount}`);
  console.log(`  Leads remaining after removal:                 ${remainingCount}`);
  process.stdout.write(
    `  Check: ${remainingCount} + ${extractedCount} == ${beforeTotal} ? `,
  );
  if (remainingCount + extractedCount !== beforeTotal) {
    console.log("FAIL — aborting.");
    process.exit(1);
  }
  console.log("OK");

  if (extractedCount === 0) {
    console.error("No matching leads; nothing to do.");
    process.exit(1);
  }

  if (args.dryRun) {
    console.log("\nDry run: no files written.");
    process.exit(0);
  }

  if (!args.noInstantly) {
    console.error(
      "Pass --no-instantly to write files. This script does not call Instantly. After extract: npm run generate-copy -- --file <batch.json>, then npm run push-instantly -- --file <copy.json>.",
    );
    process.exit(1);
  }

  const batchDoc = {
    meta: {
      extractedAt: new Date().toISOString(),
      sourceFile: args.source,
      totalLeads: extractedCount,
      filterField: field,
      filterEquals: equals,
      filterContains: contains,
      filterDescription: desc,
      tool: "extract-enriched-batch.mjs",
    },
    leads: extracted,
  };
  atomicWriteJson(batchPath, batchDoc);
  console.log(`\nWrote batch → ${batchPath}`);

  const prevMeta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};
  const masterOut = {
    ...doc,
    leads: remaining,
    meta: {
      ...prevMeta,
      lastModifiedAt: new Date().toISOString(),
      totalEnriched: remainingCount,
      totalLeadsAfterBatchExtract: remainingCount,
      extractedBatchFile: path.basename(batchPath),
      extractedCount: extractedCount,
      extractedFilterField: field,
      extractedFilterEquals: equals,
      extractedFilterContains: contains,
    },
  };
  atomicWriteJson(sourcePath, masterOut);
  console.log(`Updated master → ${sourcePath} (${remainingCount} leads)`);

  const verify = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const verifyN = Array.isArray(verify.leads) ? verify.leads.length : 0;
  console.log("\n--- Safety: after write ---");
  console.log(`  Re-read master lead count: ${verifyN}`);
  if (verifyN !== remainingCount) {
    console.error("ERROR: post-read count mismatch.");
    process.exit(1);
  }
  console.log("  OK (no data loss vs. expected remaining count)");
  console.log("\n--no-instantly: skipping Instantly API.");
}

main();
