import fs from "node:fs/promises";
import path from "node:path";

export type BriefRecord = {
  companyName: string;
  weekSummary: string;
  topAlert: string;
  competitorSignals: { title: string; detail: string }[];
  recommendedActions: string[];
};

type ReportContent = {
  weekSummary?: string;
  topAlert?: { headline?: string; detail?: string; exists?: boolean };
  competitorSections?: {
    competitorName?: string;
    summaryLine?: string;
    hasFindings?: boolean;
  }[];
  enablementUpdate?: string;
  salesPlayThisWeek?: string;
};

const INTELLIGENCE_DATA_ROOT = path.resolve(
  process.cwd(),
  "..",
  "intelligence-engine",
  "data",
);

function toTitleCase(value: string) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractCompanyNameFromDir(dirName: string) {
  return toTitleCase(dirName.replace(/^demo-/, "").replace(/-/g, " "));
}

function extractLeadIdFromDir(dirName: string) {
  return dirName.replace(/^demo-/, "").replace(/-/g, "_").toLowerCase();
}

function extractRecommendedActions(report: ReportContent) {
  if (report.enablementUpdate) {
    const actions = report.enablementUpdate
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (actions.length) return actions;
  }

  if (report.salesPlayThisWeek) {
    return [report.salesPlayThisWeek];
  }

  return [
    "Generate the latest competitor briefing for this account.",
    "Update battlecards with this week's strongest competitor moves.",
    "Prioritize active deals where these competitor claims are surfacing.",
  ];
}

function mapReportToBrief(dirName: string, report: ReportContent): BriefRecord {
  const competitorSignals = (report.competitorSections ?? [])
    .filter((section) => section.hasFindings !== false)
    .slice(0, 2)
    .map((section) => ({
      title: section.competitorName || "Competitor",
      detail:
        section.summaryLine ||
        "New positioning and messaging shifts were detected this week.",
    }));

  return {
    companyName: extractCompanyNameFromDir(dirName),
    weekSummary:
      report.weekSummary ||
      "No week summary is available for this account yet.",
    topAlert:
      report.topAlert?.headline ||
      report.topAlert?.detail ||
      "No top alert was generated for this account this week.",
    competitorSignals,
    recommendedActions: extractRecommendedActions(report),
  };
}

async function loadLatestReportFromDemoDir(
  demoDirPath: string,
): Promise<ReportContent | null> {
  const files = await fs.readdir(demoDirPath);
  const reportFiles = files
    .filter(
      (file) =>
        file.startsWith("report-content-") &&
        file.endsWith(".json"),
    )
    .sort()
    .reverse();

  if (!reportFiles.length) return null;

  const latestPath = path.join(demoDirPath, reportFiles[0]);
  const raw = await fs.readFile(latestPath, "utf8");
  return JSON.parse(raw) as ReportContent;
}

export async function loadBriefsFromReports(): Promise<Record<string, BriefRecord>> {
  try {
    const entries = await fs.readdir(INTELLIGENCE_DATA_ROOT, {
      withFileTypes: true,
    });
    const demoDirs = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("demo-"),
    );

    const output: Record<string, BriefRecord> = {};

    for (const dir of demoDirs) {
      const report = await loadLatestReportFromDemoDir(
        path.join(INTELLIGENCE_DATA_ROOT, dir.name),
      );
      if (!report) continue;

      const leadId = extractLeadIdFromDir(dir.name);
      output[leadId] = mapReportToBrief(dir.name, report);
    }

    return output;
  } catch {
    return {};
  }
}
