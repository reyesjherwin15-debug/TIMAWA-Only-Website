#!/usr/bin/env python3
"""Live push dispatcher — turns Firestore announcements into web push.

Run it once and leave it up:

    tools/.venv/Scripts/python.exe tools/push_dispatcher.py
    tools/.venv/Scripts/python.exe tools/push_dispatcher.py --once   # one pass, then exit

The app never sends push itself (the browser must not hold the VAPID private
key). Instead each screen writes a flag on the announcement it creates:

    pushPending: true        "this one is worth a system notification"
    pushUrl / pushContext    where tapping it should land, and which screen
                             owns it so the page can resolve it on arrival

This script watches for those flags, applies the read-state rules, sends, and
clears the flag again.

Rules implemented here (see PWA-PUSH-SETUP.md)
  1. every flagged event  -> a notification, read or unread
     (messages, mentions, reactions, highlights/posts, admin announcements)
  2. consecutive events in the same conversation THREAD: the payload tag comes
     from `pushContext`, so the device replaces the previous notification
     instead of stacking one per message
  3. `readBy` is no longer a gate — opening the screen still closes the
     notification (the page does that), but it never suppresses a new one
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_KEY = ROOT / "tools" / ".vapid-private.pem"
DEFAULT_SA = ROOT / "tools" / "service-account.json"

# One source of truth for the VAPID contact (and the 403 explanation): the
# sender module. Kept at import time so --help shows the real default.
try:
    from send_activity_push import DEFAULT_SUBJECT, normalize_subject  # noqa: E402
except ImportError:  # imported as `tools.push_dispatcher` instead of run as a script
    from tools.send_activity_push import DEFAULT_SUBJECT, normalize_subject  # noqa: E402
COLLECTION = "pushSubscriptions"
ANNOUNCEMENTS = "announcements"

# Guards against a burst of MODIFIED events double-sending the same doc.
_handled: dict[str, float] = {}
_DEDUPE_WINDOW_S = 8.0


def log(*parts) -> None:
    print(*parts, flush=True)


# --------------------------------------------------------------------------- #
# Payload + subscription helpers (same shapes as send_activity_push.py)
# --------------------------------------------------------------------------- #

def build_payload(doc_id: str, item: dict, default_url: str = "dashboard.html") -> dict:
    ann_type = item.get("type") or "ann"
    context = item.get("pushContext") or f"ann:{ann_type}"
    url = item.get("pushUrl") or item.get("link") or default_url
    title = (item.get("title") or "TIMAWA").strip()
    body = (item.get("message") or "").strip() or "Open TIMAWA to see it."

    # THREADING: a conversation-scoped context (chat:<uid>, mention:squad, ...)
    # becomes the tag, so the next event replaces this notification on the
    # device. Admin broadcasts (ann:*) stay one-per-document instead of all
    # collapsing into a single card.
    if context and not context.startswith("ann:"):
        tag = f"timawa_{context}"
    else:
        tag = f"ann_{ann_type}_{doc_id}"

    # "· 3 new" on threaded chat notifications.
    count = item.get("pushCount")
    if isinstance(count, int) and count > 1:
        body = f"{body} · {count} new"

    return {
        "title": title,
        "body": body if len(body) <= 160 else body[:157] + "...",
        "icon": "icons/icon-192.png",
        "badge": "icons/badge-72.png",
        "url": url,
        "tag": tag,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "meta": {"context": context, "announcementId": doc_id, "type": ann_type},
    }


def load_subscriptions(db, uid: str | None, limit: int = 500, exclude_uid: str | None = None):
    """(reference, subscription) pairs. uid=None broadcasts to everyone;
    exclude_uid skips one member (the person who created the activity)."""
    from send_activity_push import COLLECTION as COL  # same collection

    subs = []
    for doc in db.collection(COL).where("enabled", "==", True).limit(limit).stream():
        data = doc.to_dict() or {}
        if uid and data.get("uid") != uid:
            continue
        if exclude_uid and data.get("uid") == exclude_uid:
            continue
        keys = data.get("keys") or {}
        endpoint = data.get("endpoint")
        if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
            continue
        subs.append((doc.reference, {
            "endpoint": endpoint,
            "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
        }))
    return subs


# --------------------------------------------------------------------------- #
# Decision
# --------------------------------------------------------------------------- #

def decide(item: dict, receiver_uid: str | None) -> tuple[bool, str]:
    """(should_send, why). Mirrors the rules in PWA-PUSH-SETUP.md.

    receiver_uid is the announcement's targetUid (None = broadcast).

    Read state is deliberately NOT considered: a member who already opened the
    app still gets the next message (threaded on the same tag). The page closes
    the notification when they reach the screen it belongs to."""
    if not item.get("pushPending"):
        return False, "not flagged"

    # Never ping someone about their own message. The DM announcement carries
    # referenceId `dm_<senderUid>`; the page also guards this, this is belt
    # and braces for announcements written by other code paths.
    if item.get("type") == "chat":
        reference = item.get("referenceId") or ""
        sender_uid = reference[3:] if reference.startswith("dm_") else ""
        if sender_uid and sender_uid == receiver_uid:
            return False, "sender is the receiver"

    return True, "ok"


def handle(ref, item: dict, *, db, vapid_private, subject: str,
           dry_run: bool, now: float) -> None:
    doc_id = ref.id
    target_uid = item.get("targetUid") or None

    should, why = decide(item, target_uid)
    if not should:
        if item.get("pushPending"):
            try:
                ref.update({"pushPending": False,
                            "pushSkippedAt": datetime.now(timezone.utc),
                            "pushSkipReason": why})
                log(f"[{doc_id}] skipped: {why}")
            except Exception as exc:  # noqa: BLE001
                log(f"[{doc_id}] could not clear flag: {exc}")
        return

    # Re-read right before sending: readBy may have changed since the snapshot.
    try:
        fresh = ref.get().to_dict() or {}
    except Exception as exc:  # noqa: BLE001
        log(f"[{doc_id}] re-read failed ({exc}); sending from snapshot")
        fresh = item

    should, why = decide(fresh, target_uid)
    if not should:
        log(f"[{doc_id}] skipped at send time: {why}")
        try:
            ref.update({"pushPending": False,
                        "pushSkippedAt": datetime.now(timezone.utc),
                        "pushSkipReason": why})
        except Exception:
            pass
        return

    payload = build_payload(doc_id, fresh)
    log(f"\n[{doc_id}] {payload['title']}")
    log(f"          {payload['body']}  ->  {payload['url']}  (context {payload['meta']['context']})")

    if dry_run:
        log("[dry-run] not sent")
        return

    from send_activity_push import send_all

    subs = load_subscriptions(db, target_uid, exclude_uid=fresh.get("actorUid"))
    if not subs:
        log(f"          no subscriptions for {'everyone' if not target_uid else target_uid}")
        ref.update({"pushPending": False,
                    "pushSkippedAt": datetime.now(timezone.utc),
                    "pushSkipReason": "no subscribers"})
        return

    stats = send_all(db, subs, payload,
                     vapid_private=vapid_private, subject=subject,
                     dry_run=False, delay=0.03, quiet=False)
    log(f"          {stats['sent']} sent · {stats['gone']} gone · {stats['failed']} failed")

    try:
        ref.update({
            "pushPending": False,
            "pushSentAt": datetime.now(timezone.utc),
            "pushResult": stats,
        })
    except Exception as exc:  # noqa: BLE001
        log(f"          could not clear flag: {exc}")


# --------------------------------------------------------------------------- #
# Watch
# --------------------------------------------------------------------------- #

def run_once(db, **kwargs) -> int:
    processed = 0
    for doc in db.collection(ANNOUNCEMENTS).where("pushPending", "==", True).limit(100).stream():
        handle(doc.reference, doc.to_dict() or {}, db=db, **kwargs)
        processed += 1
    if not processed:
        log("No pending notifications.")
    return processed


def main() -> int:
    parser = argparse.ArgumentParser(description="Dispatch TIMAWA web push from announcements")
    parser.add_argument("--once", action="store_true", help="process pending docs and exit")
    parser.add_argument("--dry-run", action="store_true", help="show what would be sent")
    parser.add_argument("--vapid-private", default=str(DEFAULT_KEY))
    parser.add_argument("--vapid-subject", default=DEFAULT_SUBJECT)
    parser.add_argument("--service-account", default=None)
    args = parser.parse_args()

    vapid_private = Path(args.vapid_private)
    if not vapid_private.exists():
        print(f"Missing VAPID private key: {vapid_private}\nRun: python tools/generate_vapid_keys.py")
        return 2

    sa = Path(args.service_account) if args.service_account else DEFAULT_SA
    from send_activity_push import init_firestore
    db = init_firestore(sa)

    kwargs = dict(vapid_private=vapid_private,
                  subject=normalize_subject(args.vapid_subject),
                  dry_run=args.dry_run, now=time.time())

    if args.once:
        run_once(db, **kwargs)
        return 0

    print("Watching `announcements` for pushPending == true … (Ctrl+C to stop)")

    def on_snapshot(snap, changes, read_time):  # noqa: ANN001
        for change in changes:
            if change.type.name not in ("ADDED", "MODIFIED"):
                continue
            doc = change.document
            item = doc.to_dict() or {}
            last = _handled.get(doc.reference.id, 0)
            if time.time() - last < _DEDUPE_WINDOW_S:
                continue
            _handled[doc.reference.id] = time.time()
            try:
                handle(doc.reference, item, db=db, **kwargs)
            except Exception as exc:  # noqa: BLE001
                print(f"[{doc.reference.id}] dispatch error: {exc}", flush=True)

    db.collection(ANNOUNCEMENTS).where("pushPending", "==", True).on_snapshot(on_snapshot)

    stop = threading.Event()
    try:
        while not stop.wait(timeout=30):
            pass
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())