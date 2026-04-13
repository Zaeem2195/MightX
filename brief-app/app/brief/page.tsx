import briefs from "@/data/briefs.json";
import { loadBriefsFromReports, type BriefRecord } from "@/lib/brief-loader";

type BriefPageProps = {
  searchParams: Promise<{ id?: string }>;
};

function formatCompanyName(rawId?: string) {
  if (!rawId) return "Your Company";
  return rawId
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeLeadId(rawId?: string) {
  if (!rawId) return "";
  return rawId.trim().toLowerCase().replace(/\s+/g, "_");
}

export default async function BriefPage({ searchParams }: BriefPageProps) {
  const params = await searchParams;
  const normalizedLeadId = normalizeLeadId(params.id);
  const reportBackedBriefs = await loadBriefsFromReports();
  const allBriefs: Record<string, BriefRecord> = {
    ...(briefs as Record<string, BriefRecord>),
    ...reportBackedBriefs,
  };
  const brief = allBriefs[normalizedLeadId];
  const leadId = normalizedLeadId || "unknown";
  const companyName = brief?.companyName ?? formatCompanyName(params.id);
  const weekSummary =
    brief?.weekSummary ??
    "We do not have a prebuilt brief for this lead ID yet. Once connected to your report pipeline, this section will render real-time competitor intelligence.";
  const topAlert =
    brief?.topAlert ??
    "No specific alert available for this lead ID yet. Tracking is active and this open has been logged.";
  const competitorSignals = brief?.competitorSignals ?? [];
  const recommendedActions = brief?.recommendedActions ?? [
    "Verify the lead ID mapping from Instantly to your brief data store.",
    "Generate a fresh competitor snapshot for this account.",
    "Reopen this URL after data sync to view populated insights.",
  ];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-6 py-14">
      <header className="border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Automated Competitive Intelligence
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {companyName} Competitive Brief
        </h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
          Lead ID: <span className="font-mono">{leadId}</span>
        </p>
      </header>

      <section className="mt-8 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-xl font-semibold">Executive Snapshot</h2>
        <p className="mt-3 text-zinc-700 dark:text-zinc-300">{weekSummary}</p>
      </section>

      <section className="mt-6 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-xl font-semibold">Top Alert</h2>
        <p className="mt-3 text-zinc-700 dark:text-zinc-300">{topAlert}</p>
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        {competitorSignals.length ? (
          competitorSignals.map((signal) => (
            <article
              key={signal.title}
              className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
            >
              <h3 className="text-lg font-semibold">{signal.title}</h3>
              <p className="mt-2 text-zinc-700 dark:text-zinc-300">
                {signal.detail}
              </p>
            </article>
          ))
        ) : (
          <article className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800 sm:col-span-2">
            <h3 className="text-lg font-semibold">Competitor Signals</h3>
            <p className="mt-2 text-zinc-700 dark:text-zinc-300">
              No competitor signals are stored for this lead ID yet.
            </p>
          </article>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-xl font-semibold">Recommended Sales Actions</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
          {recommendedActions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      </section>

      <footer className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">
        Brief generated from latest available report data when a matching lead
        ID is found.
      </footer>
    </main>
  );
}
