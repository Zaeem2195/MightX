"use client";

import { Analytics } from "@vercel/analytics/next";
import { useEffect, useState } from "react";

const STORAGE_KEY = "brief_analytics_opt_out";
const QP = "brief_analytics_opt_out";

/**
 * Vercel Web Analytics — only mounts after checking opt-out (your own browser never
 * sends traffic if you set opt-out once). Visit production once with:
 * `?brief_analytics_opt_out=1` or run in DevTools:
 * localStorage.setItem('brief_analytics_opt_out','1'); location.reload()
 */
export function BriefAnalytics() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DISABLE_VERCEL_ANALYTICS === "1") {
      setEnabled(false);
      return;
    }
    try {
      const { hostname } = window.location;
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname.endsWith(".local")
      ) {
        setEnabled(false);
        return;
      }

      const url = new URL(window.location.href);
      if (url.searchParams.get(QP) === "1") {
        localStorage.setItem(STORAGE_KEY, "1");
        url.searchParams.delete(QP);
        const next =
          url.pathname +
          (url.searchParams.toString()
            ? `?${url.searchParams.toString()}`
            : "") +
          url.hash;
        window.history.replaceState({}, "", next);
        setEnabled(false);
        return;
      }

      if (localStorage.getItem(STORAGE_KEY) === "1") {
        setEnabled(false);
        return;
      }
    } catch {
      setEnabled(true);
      return;
    }
    setEnabled(true);
  }, []);

  if (enabled !== true) return null;
  return <Analytics />;
}
