import fs from "node:fs/promises";
import path from "node:path";
import { redirect } from "next/navigation";

/** Mirrored full HTML from intelligence-engine (`*-report-<iso>.html` in `public/`). */
const DEFAULT_BRIEF_PATH = "/brief?id=salesloft";

export default async function Home() {
  try {
    const publicDir = path.join(process.cwd(), "public");
    const files = await fs.readdir(publicDir);
    const reports = files.filter(
      (name) => name.endsWith(".html") && name.includes("-report-"),
    );
    reports.sort().reverse();
    const latest = reports[0];
    if (latest) {
      redirect(`/${latest}`);
    }
  } catch {
    // Public dir missing or unreadable — fall through.
  }
  redirect(DEFAULT_BRIEF_PATH);
}
