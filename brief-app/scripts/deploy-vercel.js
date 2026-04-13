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
const { spawnSync, execSync } = require("child_process");

const appRoot = path.join(__dirname, "..");

function getGitRoot(dir) {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    return out ? path.normalize(out) : null;
  } catch {
    return null;
  }
}

/**
 * Vercel project "Root Directory" is relative to the Git repo root. If you run
 * the CLI from `repo/brief-app` while Root Directory is `brief-app`, the CLI
 * resolves `brief-app/brief-app` and fails. Deploy from the Git root and keep
 * a minimal `.vercel/project.json` there (ids only — no `settings.rootDirectory`).
 */
function prepareMonorepoVercelContext(appRoot) {
  const gitRoot = getGitRoot(appRoot);
  const normApp = path.normalize(appRoot);
  if (!gitRoot || path.normalize(gitRoot) === normApp) {
    return { vercelCwd: appRoot };
  }
  const rel = path.relative(gitRoot, normApp);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { vercelCwd: appRoot };
  }
  const srcPath = path.join(appRoot, ".vercel", "project.json");
  const raw = fs.readFileSync(srcPath, "utf8");
  const linked = JSON.parse(raw);
  const minimal = {
    projectId: linked.projectId,
    orgId: linked.orgId,
    projectName: linked.projectName,
  };
  if (!minimal.projectId || !minimal.orgId) {
    return { vercelCwd: appRoot };
  }
  const rootVercelDir = path.join(gitRoot, ".vercel");
  fs.mkdirSync(rootVercelDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootVercelDir, "project.json"),
    `${JSON.stringify(minimal, null, 2)}\n`,
    "utf8",
  );
  return { vercelCwd: gitRoot };
}

// Load `.env` first, then `.env.local` with override so local secrets win.
// (If `.env` defines VERCEL_TOKEN=` empty, loading it second used to wipe a good `.env.local` value.)
require("dotenv").config({ path: path.join(appRoot, ".env") });
require("dotenv").config({
  path: path.join(appRoot, ".env.local"),
  override: true,
});

function listEnvFileKeys(filePath) {
  if (!fs.existsSync(filePath)) return [];
  let raw = fs.readFileSync(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const m = line.match(/^(?:export\s+)?([\w.-]+)\s*=/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

// Personal Access Token (PAT) from https://vercel.com/account/tokens — use `vcp_...` / legacy `...` form.
// Do NOT put `VERCEL_OIDC_TOKEN` (JWT) into `VERCEL_TOKEN`: the CLI rejects values containing `.` and `-`.
const classicToken = [process.env.VERCEL_TOKEN, process.env.VERCEL_ACCESS_TOKEN]
  .find((v) => typeof v === "string" && v.trim().length > 0)
  ?.trim();

if (classicToken) {
  process.env.VERCEL_TOKEN = classicToken;
} else if (process.env.VERCEL_OIDC_TOKEN?.trim()) {
  delete process.env.VERCEL_TOKEN;
}

const isPreview = process.argv.includes("--preview");
const vercelProject = path.join(appRoot, ".vercel", "project.json");

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd: cwd ?? appRoot,
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
  const localPath = path.join(appRoot, ".env.local");
  const keys = listEnvFileKeys(localPath);
  const hasOidc = Boolean(process.env.VERCEL_OIDC_TOKEN?.trim());

  console.error(`
Missing VERCEL_TOKEN (Personal Access Token from your Vercel account).

This script does not use VERCEL_OIDC_TOKEN for local deploy — that value is a JWT for GitHub Actions OIDC and the CLI rejects it as --token.

1. Create a PAT: https://vercel.com/account/tokens  (scope: Full account or enough to deploy)
2. Add to brief-app/.env.local:

   VERCEL_TOKEN=vcp_xxxxxxxx

3. You can keep VERCEL_OIDC_TOKEN for CI; just add VERCEL_TOKEN for local \`npm run deploy:vercel\`.

4. From brief-app, link once if needed:

   npx vercel link
`);
  if (hasOidc) {
    console.error(
      "(You have VERCEL_OIDC_TOKEN set — add a separate VERCEL_TOKEN PAT for local CLI deploy.)",
    );
  }
  if (keys.length) {
    console.error(`Variable names in .env.local: ${keys.join(", ")}`);
  }
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

const { vercelCwd } = prepareMonorepoVercelContext(appRoot);
if (vercelCwd !== appRoot) {
  console.log(
    `Using Git repo root for Vercel (monorepo Root Directory): ${vercelCwd}\n`,
  );
}

console.log(isPreview ? "\nDeploying preview…\n" : "\nDeploying production…\n");
run("npx", args, vercelCwd);
