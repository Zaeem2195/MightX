/**
 * deploy-vercel.js — deploy brief-app to Vercel from your machine
 *
 * Prerequisites:
 *   1. Create a token: https://vercel.com/account/tokens
 *   2. Add to brief-app/.env.local (gitignored):
 *        VERCEL_TOKEN=...
 *   3. One-time link (from brief-app):  npx vercel link
 *      (creates .vercel/project.json — safe to commit for team CI, or keep local only)
 *
 * Usage:
 *   npm run deploy:vercel              # production
 *   npm run deploy:vercel -- --preview
 */

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const appRoot = path.join(__dirname, "..");

require("dotenv").config({ path: path.join(appRoot, ".env.local") });
require("dotenv").config({ path: path.join(appRoot, ".env") });

const isPreview = process.argv.includes("--preview");
const vercelProject = path.join(appRoot, ".vercel", "project.json");

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env },
    shell: true,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

if (!process.env.VERCEL_TOKEN?.trim()) {
  console.error(`
Missing VERCEL_TOKEN.

1. Create a token: https://vercel.com/account/tokens
2. Add to brief-app/.env.local:

   VERCEL_TOKEN=your_token_here

3. From brief-app, link the project once (if you have not already):

   cd brief-app
   npx vercel link

Then run: npm run deploy:vercel
`);
  process.exit(1);
}

if (!fs.existsSync(vercelProject)) {
  console.error(`
No .vercel/project.json found.

Run once from brief-app:

  cd brief-app
  npx vercel link

Choose your Vercel team and the existing brief-app project (or create a new one).
`);
  process.exit(1);
}

const args = ["vercel@latest", "deploy", "--yes"];
if (isPreview) {
  args.push("--preview");
} else {
  args.push("--prod");
}

console.log(isPreview ? "\nDeploying preview…\n" : "\nDeploying production…\n");
run("npx", args);
