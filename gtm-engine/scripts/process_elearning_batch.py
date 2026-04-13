#!/usr/bin/env python3
"""
Extract e-learning industry leads from an enriched JSON master list,
write a batch file, update the master (minus those leads), and optionally
push the batch to Instantly API v2 (same contract as scripts/4-push-instantly.js).

Expected enriched shape (from 2-enrich-leads.js):
  { "meta": {...}, "leads": [ { ..., "personalization": { "companyIndustry": ... } } ] }

Usage (from repo root or gtm-engine):
  python scripts/process_elearning_batch.py
  python scripts/process_elearning_batch.py --dry-run
  python scripts/process_elearning_batch.py --no-instantly
  python scripts/process_elearning_batch.py --copy-json data/copy-2026-04-13T15-53-31.json

Requires for Instantly push: INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID in gtm-engine/.env
(stdlib only — no pip installs.)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
GTM_ROOT = SCRIPT_DIR.parent
DATA_DIR = GTM_ROOT / "data"

DEFAULT_SOURCE = "enriched-2026-04-06T15-55-49.json"
DEFAULT_BATCH = "processed_elearning_batch.json"

INSTANTLY_API_BASE = "https://api.instantly.ai/api/v2/leads"
BATCH_DELAY_MS = 500


def load_dotenv_gtm() -> None:
    env_path = GTM_ROOT / ".env"
    if not env_path.is_file():
        return
    raw = env_path.read_text(encoding="utf-8")
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^export\s+(.+)$", line)
        if m:
            line = m.group(1).strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


def industry_of(lead: dict[str, Any]) -> str:
    p = lead.get("personalization") or {}
    raw = p.get("companyIndustry") or lead.get("companyIndustry") or ""
    return str(raw).strip()


def is_elearning(lead: dict[str, Any]) -> bool:
    s = industry_of(lead).lower()
    if s == "e-learning":
        return True
    compact = re.sub(r"[\s_\-]+", "", s)
    return compact == "elearning"


def normalize_api_key(raw: str) -> str:
    k = (raw or "").strip()
    if k.startswith('"') and k.endswith('"'):
        k = k[1:-1].strip()
    if k.lower().startswith("bearer "):
        k = k[7:].strip()
    return k


def atomic_write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)


def load_copy_by_email(copy_path: Path) -> dict[str, dict[str, Any]]:
    if not copy_path.is_file():
        raise FileNotFoundError(f"Copy file not found: {copy_path}")
    doc = json.loads(copy_path.read_text(encoding="utf-8"))
    rows = doc.get("copy") or []
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        em = str(row.get("email") or "").strip().lower()
        if em:
            out[em] = row
    return out


def build_instantly_body(
    lead: dict[str, Any],
    copy_row: dict[str, Any] | None,
) -> dict[str, Any]:
    email = str(lead.get("email") or "").strip()
    first = str(lead.get("firstName") or "").strip()
    last = str(lead.get("lastName") or "").strip()
    company = str(lead.get("companyName") or "").strip()
    title = str(lead.get("title") or "").strip()

    subject = ""
    body = ""
    if copy_row:
        subject = str(copy_row.get("subject") or "").strip()
        body = str(copy_row.get("body") or "").strip()

    campaign = os.environ.get("INSTANTLY_CAMPAIGN_ID", "").strip()
    if not campaign:
        raise RuntimeError("INSTANTLY_CAMPAIGN_ID is not set")

    return {
        "campaign": campaign,
        "email": email,
        "first_name": first,
        "last_name": last,
        "company_name": company,
        "skip_if_in_workspace": True,
        "custom_variables": {
            "ai_subject": subject,
            "ai_body": body,
            "title": title,
        },
    }


def post_lead(api_key: str, body: dict[str, Any]) -> tuple[int, str]:
    req = urllib.request.Request(
        INSTANTLY_API_BASE,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return resp.status, text
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        return e.code, err_body


def main() -> int:
    parser = argparse.ArgumentParser(description="Split e-learning leads and push to Instantly.")
    parser.add_argument(
        "--source",
        default=DEFAULT_SOURCE,
        help=f"Enriched JSON filename under data/ (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--batch-out",
        default=DEFAULT_BATCH,
        help=f"Output batch filename under data/ (default: {DEFAULT_BATCH})",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=DATA_DIR,
        help="Directory containing enriched JSON (default: gtm-engine/data)",
    )
    parser.add_argument(
        "--copy-json",
        type=Path,
        default=None,
        help="Optional copy-*.json (same shape as generate-copy output) merged by email for ai_subject/ai_body",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print counts only; no writes, no API.")
    parser.add_argument(
        "--no-instantly",
        action="store_true",
        help="Write batch + updated master only; do not call Instantly.",
    )
    args = parser.parse_args()

    load_dotenv_gtm()

    data_dir: Path = args.data_dir.resolve()
    source_path = data_dir / args.source
    batch_path = data_dir / args.batch_out

    if not source_path.is_file():
        print(f"ERROR: Source file not found: {source_path}", file=sys.stderr)
        return 1

    doc = json.loads(source_path.read_text(encoding="utf-8"))
    leads: list[dict[str, Any]] = list(doc.get("leads") or [])

    before_total = len(leads)
    elearning = [L for L in leads if is_elearning(L)]
    remaining = [L for L in leads if not is_elearning(L)]

    extracted_count = len(elearning)
    remaining_count = len(remaining)

    print("--- Safety: counts ---")
    print(f"  Leads in source file ({source_path.name}):     {before_total}")
    print(f"  Matched companyIndustry e-learning (flex):     {extracted_count}")
    print(f"  Leads remaining after removal:                 {remaining_count}")
    print(f"  Check: {remaining_count} + {extracted_count} == {before_total} ? ", end="")

    if remaining_count + extracted_count != before_total:
        print("FAIL — aborting, data would not reconcile.")
        return 1
    print("OK")

    if extracted_count == 0:
        print("No e-learning leads found; nothing to do.", file=sys.stderr)
        return 1

    if args.dry_run:
        print("\nDry run: no files written, no Instantly calls.")
        return 0

    batch_doc = {
        "meta": {
            "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sourceFile": args.source,
            "totalLeads": extracted_count,
            "filter": "companyIndustry == e-learning (case-insensitive; elearning accepted)",
        },
        "leads": elearning,
    }
    atomic_write_json(batch_path, batch_doc)
    print(f"\nWrote batch → {batch_path}")

    prev_meta = doc.get("meta") or {}
    master_out = {
        **doc,
        "leads": remaining,
        "meta": {
            **prev_meta,
            "lastModifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "totalEnriched": remaining_count,
            "totalLeadsAfterElearningSplit": remaining_count,
            "elearningBatchFile": args.batch_out,
            "elearningExtractedCount": extracted_count,
        },
    }
    atomic_write_json(source_path, master_out)
    print(f"Updated master → {source_path} ({remaining_count} leads)")

    # Post-write verification read
    verify = json.loads(source_path.read_text(encoding="utf-8"))
    verify_n = len(verify.get("leads") or [])
    print("\n--- Safety: after write ---")
    print(f"  Re-read master lead count: {verify_n}")
    if verify_n != remaining_count:
        print("ERROR: post-read count mismatch.", file=sys.stderr)
        return 1
    print("  OK (no data loss vs. expected remaining count)")

    if args.no_instantly:
        print("\n--no-instantly: skipping Instantly API.")
        return 0

    api_key = normalize_api_key(os.environ.get("INSTANTLY_API_KEY", ""))
    if not api_key or not os.environ.get("INSTANTLY_CAMPAIGN_ID", "").strip():
        print(
            "ERROR: INSTANTLY_API_KEY and INSTANTLY_CAMPAIGN_ID must be set in gtm-engine/.env for push.",
            file=sys.stderr,
        )
        return 1

    copy_by_email: dict[str, dict[str, Any]] | None = None
    if args.copy_json:
        cp = args.copy_json if args.copy_json.is_absolute() else data_dir / args.copy_json
        copy_by_email = load_copy_by_email(cp)
        print(f"Loaded copy rows by email from: {cp}")

    print(f"\nPushing {extracted_count} leads to Instantly (delay {BATCH_DELAY_MS} ms between calls)...\n")
    pushed = 0
    failed = 0
    for i, lead in enumerate(elearning):
        email = str(lead.get("email") or "").strip()
        label = f"{lead.get('firstName','')} {lead.get('lastName','')} @ {lead.get('companyName','')}"
        copy_row = copy_by_email.get(email.lower()) if copy_by_email else None
        if copy_by_email is not None and copy_row is None:
            print(f"  [{i+1}/{extracted_count}] SKIP (no copy row for email) {label} <{email}>")
            failed += 1
            continue
        body = build_instantly_body(lead, copy_row)
        print(f"  [{i+1}/{extracted_count}] POST {label} <{email}> ... ", end="", flush=True)
        status, text = post_lead(api_key, body)
        if status == 200 or status == 201:
            print("OK")
            pushed += 1
        else:
            print(f"FAIL {status}: {text[:200]}")
            failed += 1
        if i < extracted_count - 1:
            time.sleep(BATCH_DELAY_MS / 1000.0)

    print(f"\nInstantly: pushed={pushed} failed/skipped={failed}")
    log_path = data_dir / f"push-log-elearning-{time.strftime('%Y-%m-%dT%H-%M-%SZ', time.gmtime())}.json"
    atomic_write_json(
        log_path,
        {
            "meta": {
                "pushedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "batchFile": args.batch_out,
                "sourceUpdated": args.source,
                "pushed": pushed,
                "failed": failed,
            },
        },
    )
    print(f"Wrote log → {log_path}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
