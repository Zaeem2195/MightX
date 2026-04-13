#!/usr/bin/env python3
"""
Extract leads from an enriched JSON master by field match, write a batch file,
update the master (minus those leads), and optionally push the batch to
Instantly API v2 (same contract as scripts/4-push-instantly.js).

Default behaviour matches the original e-learning helper:
  --field companyIndustry --equals e-learning

Expected enriched shape (from 2-enrich-leads.js):
  { "meta": {...}, "leads": [ { ..., "personalization": { ... } } ] }

Field resolution: for --field X, reads lead["personalization"][X] if set,
else lead[X].

Usage (from gtm-engine):
  python scripts/process_elearning_batch.py --dry-run
  python scripts/process_elearning_batch.py --equals "Computer Software" --no-instantly
  python scripts/process_elearning_batch.py --field title --contains "Chief Revenue" --batch-out processed-cro-batch.json
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
DEFAULT_FIELD = "companyIndustry"
DEFAULT_EQUALS = "e-learning"

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


def slug_for_filename(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "batch"


def field_value(lead: dict[str, Any], field: str) -> str:
    p = lead.get("personalization")
    if isinstance(p, dict) and field in p and p[field] is not None:
        raw = p[field]
    else:
        raw = lead.get(field)
    return str(raw if raw is not None else "").strip()


def norm_compact(s: str) -> str:
    return re.sub(r"[\s_\-]+", "", s.casefold())


def matches_equals(lead_val: str, target: str) -> bool:
    if not lead_val or not target:
        return False
    a, b = lead_val.strip(), target.strip()
    if a.casefold() == b.casefold():
        return True
    return norm_compact(a) == norm_compact(b)


def matches_contains(lead_val: str, sub: str) -> bool:
    if not lead_val or not sub:
        return False
    return sub.strip().casefold() in lead_val.casefold()


def lead_matches(
    lead: dict[str, Any],
    field: str,
    equals: str | None,
    contains: str | None,
) -> bool:
    val = field_value(lead, field)
    if contains is not None:
        return matches_contains(val, contains)
    assert equals is not None
    return matches_equals(val, equals)


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


def default_batch_filename(field: str, equals: str | None, contains: str | None) -> str:
    fslug = slug_for_filename(field)
    if contains is not None:
        vslug = slug_for_filename(contains)
        mode = "contains"
    else:
        vslug = slug_for_filename(equals or "")
        mode = "equals"
    return f"processed-{fslug}-{vslug}-{mode}-batch.json"


def filter_description(field: str, equals: str | None, contains: str | None) -> str:
    if contains is not None:
        return f'{field} contains "{contains}" (case-insensitive)'
    return f'{field} equals "{equals}" (case-insensitive; spacing/hyphen variants folded)'


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract leads from enriched JSON by field match; optional Instantly push.",
    )
    parser.add_argument(
        "--source",
        default=DEFAULT_SOURCE,
        help=f"Enriched JSON filename under data/ (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--field",
        default=DEFAULT_FIELD,
        help=f"Lead field name (personalization first, then top-level). Default: {DEFAULT_FIELD}",
    )
    parser.add_argument(
        "--equals",
        default=None,
        metavar="VALUE",
        help=f'Equality match (case-insensitive; spacing/hyphen folding). Default if neither --contains nor --equals: "{DEFAULT_EQUALS}".',
    )
    parser.add_argument(
        "--contains",
        default=None,
        metavar="SUBSTRING",
        help="Substring match (case-insensitive). When set, --equals is ignored.",
    )
    parser.add_argument(
        "--batch-out",
        default=None,
        metavar="FILENAME",
        help="Batch JSON under data/. Default: processed-<field>-<value>-equals|contains-batch.json",
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
        help="Optional copy-*.json merged by email for ai_subject/ai_body",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print counts only; no writes, no API.")
    parser.add_argument(
        "--no-instantly",
        action="store_true",
        help="Write batch + updated master only; do not call Instantly.",
    )
    args = parser.parse_args()

    field = (args.field or "").strip()
    if not field:
        print("ERROR: --field must be non-empty.", file=sys.stderr)
        return 1

    contains = (args.contains or "").strip() or None
    equals: str | None = None
    if contains is None:
        equals = (args.equals if args.equals is not None else DEFAULT_EQUALS).strip()
        if not equals:
            print("ERROR: --equals must be non-empty (or use --contains).", file=sys.stderr)
            return 1
    elif args.equals is not None and str(args.equals).strip():
        print("ERROR: use only one of --equals or --contains.", file=sys.stderr)
        return 1

    load_dotenv_gtm()

    data_dir: Path = args.data_dir.resolve()
    source_path = data_dir / args.source
    batch_rel = args.batch_out or default_batch_filename(field, equals, contains)
    batch_path = Path(batch_rel)
    if not batch_path.is_absolute():
        batch_path = data_dir / batch_rel

    if not source_path.is_file():
        print(f"ERROR: Source file not found: {source_path}", file=sys.stderr)
        return 1

    doc = json.loads(source_path.read_text(encoding="utf-8"))
    leads: list[dict[str, Any]] = list(doc.get("leads") or [])

    before_total = len(leads)
    extracted = [L for L in leads if lead_matches(L, field, equals, contains)]
    remaining = [L for L in leads if not lead_matches(L, field, equals, contains)]

    extracted_count = len(extracted)
    remaining_count = len(remaining)
    desc = filter_description(field, equals, contains)

    print("--- Safety: counts ---")
    print(f"  Leads in source file ({source_path.name}):     {before_total}")
    print(f"  Matched ({desc}):              {extracted_count}")
    print(f"  Leads remaining after removal:                 {remaining_count}")
    print(f"  Check: {remaining_count} + {extracted_count} == {before_total} ? ", end="")

    if remaining_count + extracted_count != before_total:
        print("FAIL — aborting, data would not reconcile.")
        return 1
    print("OK")

    if extracted_count == 0:
        print("No matching leads; nothing to do.", file=sys.stderr)
        return 1

    if args.dry_run:
        print("\nDry run: no files written, no Instantly calls.")
        return 0

    batch_doc = {
        "meta": {
            "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sourceFile": args.source,
            "totalLeads": extracted_count,
            "filterField": field,
            "filterEquals": equals,
            "filterContains": contains,
            "filterDescription": desc,
        },
        "leads": extracted,
    }
    atomic_write_json(batch_path, batch_doc)
    print(f"\nWrote batch → {batch_path}")

    prev_meta = doc.get("meta") or {}
    batch_filename_for_meta = batch_path.name
    master_out = {
        **doc,
        "leads": remaining,
        "meta": {
            **prev_meta,
            "lastModifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "totalEnriched": remaining_count,
            "totalLeadsAfterBatchExtract": remaining_count,
            "extractedBatchFile": batch_filename_for_meta,
            "extractedCount": extracted_count,
            "extractedFilterField": field,
            "extractedFilterEquals": equals,
            "extractedFilterContains": contains,
        },
    }
    atomic_write_json(source_path, master_out)
    print(f"Updated master → {source_path} ({remaining_count} leads)")

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
    for i, lead in enumerate(extracted):
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
    log_slug = slug_for_filename(field + (contains or equals or ""))
    log_path = data_dir / f"push-log-extract-{log_slug}-{time.strftime('%Y-%m-%dT%H-%M-%SZ', time.gmtime())}.json"
    atomic_write_json(
        log_path,
        {
            "meta": {
                "pushedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "batchFile": batch_filename_for_meta,
                "sourceUpdated": args.source,
                "filterField": field,
                "filterEquals": equals,
                "filterContains": contains,
                "pushed": pushed,
                "failed": failed,
            },
        },
    )
    print(f"Wrote log → {log_path}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
