import { redirect } from "next/navigation";

/**
 * Some links use `/elearning-brief/brief?id=…` by analogy with `/brief?id=…`.
 * The hosted asset is a single static file: `/elearning-brief.html?id=…`.
 */
export default async function ElearningBriefPathRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) q.append(key, v);
    } else {
      q.set(key, value);
    }
  }
  const suffix = q.size ? `?${q.toString()}` : "";
  redirect(`/elearning-brief.html${suffix}`);
}
