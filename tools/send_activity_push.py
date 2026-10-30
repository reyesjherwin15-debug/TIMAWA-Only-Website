#!/usr/bin/env python3
"""Send TIMAWA activity notifications to every subscribed member.

Usage
-----
  python tools/send_activity_push.py --test
  python tools/send_activity_push.py --event <eventId>
  python tools/send_activity_push.py --upcoming 24
  python tools/send_activity_push.py --title "Gala moved" --body "Now 8 PM at the usual place"
  python tools/send_activity_push.py --list

Setup
-----
  1. Firebase console -> Project settings -> Service accounts -> Generate new private key
     Save it as tools/service-account.json  (never commit or upload it)
  2. pip install -r tools/requirements.txt
  3. VAPID keys already exist: tools/.vapid-private.pem + push-config.js
     Regenerate with: python tools/generate_vapid_keys.py --force

Notes
-----
* Members receive these even when the site is closed (real Web Push, not an
  in-page alert). iOS needs TIMAWA added to the home screen, iOS 16.4+.
* Endpoints that the push service reports as gone (404/410) are deleted, so the
  collection cleans itself up as phones change.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_KEY = ROOT / "tools" / ".vapid-private.pem"
DEFAULT_SA = ROOT / "tools" / "service-account.json"
COLLECTION = "pushSubscriptions"
LOG_COLLECTION = "pushLog"

ICON = "icons/icon-192.png"
BADGE = "icons/badge-72.png"

# Apple's push service answers 403 BadJwtToken when the VAPID `sub` claim points at
# a fictional domain (mailto:...@example.com). Chrome tolerates it, Safari/iOS does
# not — and this project sends to both — so the default is the deployed site URL.
# Override with --vapid-subject or the VAPID_SUBJECT environment variable.
DEFAULT_SUBJECT = os.environ.get(
    "VAPID_SUBJECT",
    "https://reyesjherwin15-debug.github.io",
)


def normalize_subject(value: str) -> str:
    """Accept `you@mail.com`, `mailto:you@mail.com` or an https origin.

    A URL is reduced to scheme+host: py_vapid's own validation (and some push
    services) reject `sub` values that carry a path, so a copied site URL would
    otherwise fail to sign.
    """
    value = (value or "").strip()
    if "@" in value and not value.startswith("mailto:"):
        value = "mailto:" + value
    if value.startswith(("http://", "https://")):
        from urllib.parse import urlsplit
        parts = urlsplit(value)
        if parts.netloc:
            return f"{parts.scheme}://{parts.netloc}"
    return value


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def local_tz():
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo("Asia/Manila")
    except Exception:
        return timezone(timedelta(hours=8))


def fmt_when(value) -> str:
    if not isinstance(value, datetime):
        return str(value or "")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    local = value.astimezone(local_tz())
    return local.strftime("%a, %d %b · %I:%M %p").replace(" 0", " ")


def trim(text: str, limit: int = 110) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def build_event_payload(event_id: str, data: dict, kind: str) -> dict:
    title = (data.get("title") or "Squad activity").strip()
    when = fmt_when(data.get("dateTime"))
    bits = [b for b in [data.get("type"), when, data.get("location")] if b]
    body = " • ".join(bits)
    description = trim(data.get("description"), 90)
    if description:
        body = f"{body}\n{description}" if body else description

    if kind == "reminder":
        heading = f"Starting soon: {title}"
        tag = f"activity-{event_id}-reminder"
    else:
        heading = f"New activity: {title}"
        tag = f"activity-{event_id}"

    return {
        "title": heading,
        "body": body or "Tap to see the details.",
        "icon": "icons/notif-event.png",
        "badge": BADGE,
        "url": "calendar.html",
        "tag": tag,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        # context lets the page close this notification as soon as the member
        # reaches the screen it belongs to (calendar.html clears "event:").
        "meta": {"eventId": event_id, "kind": kind, "context": f"event:{event_id}"},
    }


def build_test_payload() -> dict:
    return {
        "title": "TIMAWA notifications are live",
        "body": "This is a test. Members will get alerts like this for new activities.",
        "icon": "icons/notif-default.png",
        "badge": BADGE,
        "url": "calendar.html",
        "tag": "timawa-test",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "meta": {"kind": "test", "context": "ann:test"},
    }


# --------------------------------------------------------------------------- #
# Firebase
# --------------------------------------------------------------------------- #

def init_firestore(service_account: Path | None):
    import firebase_admin
    from firebase_admin import credentials, firestore

    if service_account and service_account.exists():
        cred = credentials.Certificate(str(service_account))
    else:
        # GOOGLE_APPLICATION_CREDENTIALS or a machine with ADC configured.
        cred = credentials.ApplicationDefault()

    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def load_subscriptions(db, limit: int):
    docs = []
    query = db.collection(COLLECTION).where("enabled", "==", True).limit(limit)
    for doc in query.stream():
        data = doc.to_dict() or {}
        keys = data.get("keys") or {}
        endpoint = data.get("endpoint")
        if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
            continue
        docs.append((doc.reference, {
            "endpoint": endpoint,
            "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
        }))
    return docs


# --------------------------------------------------------------------------- #
# Sending
# --------------------------------------------------------------------------- #

def send_all(db, subscriptions, payload: dict, *, vapid_private, subject: str,
             dry_run: bool, delay: float, quiet: bool = False) -> dict:
    from pywebpush import WebPushException, webpush

    body = json.dumps(payload)
    stats = {"sent": 0, "gone": 0, "failed": 0}
    hinted_403 = False

    for ref, info in subscriptions:
        label = (info["endpoint"].split("/")[-1] or "")[:12]
        if dry_run:
            stats["sent"] += 1
            if not quiet:
                print(f"  [dry-run] would send to …{label}")
            continue

        try:
            webpush(
                subscription_info=info,
                data=body,
                vapid_private_key=str(vapid_private),
                vapid_claims={"sub": subject},
                timeout=15,
            )
            stats["sent"] += 1
            if not quiet:
                print(f"  sent  …{label}")
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                stats["gone"] += 1
                try:
                    ref.delete()
                except Exception:
                    pass
                if not quiet:
                    print(f"  gone  …{label} (removed)")
            elif status == 403 and not hinted_403:
                # Almost always the VAPID subject, not the keys (Apple is strict).
                hinted_403 = True
                stats["failed"] += 1
                print(f"  FAIL  …{label}: {exc}")
                print("        Apple rejects a VAPID `sub` whose domain is fictional or missing.\n"
                      "        Pass --vapid-subject with a real inbox or your https:// site URL "
                      f"(current: {subject}).")
            elif status == 429:
                time.sleep(2)
                try:
                    webpush(
                        subscription_info=info,
                        data=body,
                        vapid_private_key=str(vapid_private),
                        vapid_claims={"sub": subject},
                        timeout=15,
                    )
                    stats["sent"] += 1
                    if not quiet:
                        print(f"  sent  …{label} (after retry)")
                except Exception as retry_exc:  # noqa: BLE001
                    stats["failed"] += 1
                    print(f"  FAIL  …{label}: {retry_exc}")
            else:
                stats["failed"] += 1
                print(f"  FAIL  …{label}: {exc}")
        except Exception as exc:  # noqa: BLE001
            stats["failed"] += 1
            print(f"  FAIL  …{label}: {exc}")

        if delay:
            time.sleep(delay)

    return stats


def already_logged(db, doc_id: str) -> bool:
    try:
        return db.collection(LOG_COLLECTION).document(doc_id).get().exists
    except Exception:
        return False


def write_log(db, doc_id: str, **fields) -> None:
    try:
        db.collection(LOG_COLLECTION).document(doc_id).set(fields, merge=True)
    except Exception as exc:  # noqa: BLE001
        print(f"  (could not write pushLog/{doc_id}: {exc})")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Send TIMAWA activity notifications to subscribed members."
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--event", metavar="ID", help="notify about one event document")
    target.add_argument("--upcoming", nargs="?", const=24.0, type=float, metavar="HOURS",
                        help="remind members about events starting within HOURS (default 24)")
    target.add_argument("--test", action="store_true", help="send a test notification")
    target.add_argument("--list", action="store_true", help="only count subscribers")
    target.add_argument("--title", help="ad-hoc message title (use with --body)")

    parser.add_argument("--body", default="", help="ad-hoc message body")
    parser.add_argument("--url", default="calendar.html", help="page to open on tap")
    parser.add_argument("--dry-run", action="store_true", help="print without sending")
    parser.add_argument("--limit", type=int, default=1000, help="max subscriptions to load")
    parser.add_argument("--delay", type=float, default=0.05, help="pause between sends (s)")
    parser.add_argument("--service-account", default=None, help="path to service-account.json")
    parser.add_argument("--vapid-private", default=str(DEFAULT_KEY), help="VAPID private key (PEM)")
    parser.add_argument("--vapid-subject", default=os.environ.get("VAPID_SUBJECT", ""),
                        help="mailto: address identifying the sender")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    if args.title and not args.body:
        parser.error("--title needs --body")

    vapid_private = Path(args.vapid_private)
    if not vapid_private.exists():
        print(f"Missing VAPID private key: {vapid_private}")
        print("Run: python tools/generate_vapid_keys.py")
        return 2

    subject = normalize_subject(args.vapid_subject or DEFAULT_SUBJECT)
    if not subject.startswith(("mailto:", "https://")):
        parser.error("--vapid-subject must be a mailto: address or an https:// URL")

    sa = Path(args.service_account) if args.service_account else DEFAULT_SA
    db = init_firestore(sa)

    subs = load_subscriptions(db, args.limit)
    print(f"Subscribers: {len(subs)}")
    if args.list:
        return 0
    if not subs:
        print("Nobody is subscribed yet — nothing to send.")
        return 0

    if args.event:
        snapshot = db.collection("events").document(args.event).get()
        if not snapshot.exists:
            print(f"No event with id {args.event}")
            return 1
        payload = build_event_payload(args.event, snapshot.to_dict() or {}, "created")
        payload["url"] = args.url or payload["url"]
    elif args.upcoming is not None:
        hours = max(1.0, args.upcoming)
        now = datetime.now(timezone.utc)
        window_end = now + timedelta(hours=hours)
        upcoming = (
            db.collection("events")
            .where("dateTime", ">=", now)
            .where("dateTime", "<=", window_end)
            .stream()
        )
        sent_any = 0
        for snapshot in upcoming:
            doc_id = f"{snapshot.id}__reminder"
            if already_logged(db, doc_id):
                continue
            payload = build_event_payload(snapshot.id, snapshot.to_dict() or {}, "reminder")
            print(f"\nReminder for: {payload['title']}")
            stats = send_all(
                db, subs, payload,
                vapid_private=vapid_private, subject=subject,
                dry_run=args.dry_run, delay=args.delay, quiet=args.quiet,
            )
            print(f"  {stats['sent']} sent · {stats['gone']} gone · {stats['failed']} failed")
            if not args.dry_run:
                write_log(db, doc_id, eventId=snapshot.id, kind="reminder",
                          sentAt=datetime.now(timezone.utc), **stats)
            sent_any += 1
        if not sent_any:
            print("No upcoming events in that window (or reminders already sent).")
        return 0
    elif args.test:
        payload = build_test_payload()
    else:
        payload = {
            "title": args.title,
            "body": args.body,
            "icon": "icons/notif-default.png",
            "badge": BADGE,
            "url": args.url,
            "tag": f"timawa-custom-{int(time.time())}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "meta": {"kind": "custom"},
        }

    print(f"\n{payload['title']}")
    print(f"{payload['body']}")
    print()
    stats = send_all(
        db, subs, payload,
        vapid_private=vapid_private, subject=subject,
        dry_run=args.dry_run, delay=args.delay, quiet=args.quiet,
    )
    print(f"\nDone: {stats['sent']} sent · {stats['gone']} gone · {stats['failed']} failed"
          + (" (dry run)" if args.dry_run else ""))
    return 0 if stats["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
