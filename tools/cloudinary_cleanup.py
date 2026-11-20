#!/usr/bin/env python3
"""Delete Cloudinary media the app no longer uses.

Why this exists
---------------
The browser cannot delete Cloudinary assets. `/image/destroy` returns
401 "Unknown API key" without a signature, and Cloudinary refuses to hand out
delete tokens for *unsigned* uploads (which is what every page on this site
uses):

    Return delete token parameter is not allowed when using unsigned upload.

So the app writes the public IDs to Firestore when a highlight, a single photo
or a story is deleted, and this script — running in GitHub Actions, where the
API key lives in repository secrets — does the actual removal.

Two sources of work
-------------------
  queue    `mediaCleanupQueue` documents written by the app. Exact IDs, written
           at the moment content is deleted, so nothing is guessed.
  orphans  Assets under `t-imawa/` that no document references any more (stories
           that expired while nobody had the site open, interrupted uploads) and
           are older than --min-age-hours.

Usage
-----
    python tools/cloudinary_cleanup.py --mode queue              # dry run (default)
    python tools/cloudinary_cleanup.py --mode both --apply --max-delete 300

Environment
-----------
    CLOUDINARY_CLOUD_NAME   (default ooq99nlw)
    CLOUDINARY_API_KEY      required
    CLOUDINARY_API_SECRET   required
    service account         --service-account path, or GOOGLE_APPLICATION_CREDENTIALS
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SA = ROOT / "tools" / "service-account.json"

QUEUE = "mediaCleanupQueue"
CLOUD = os.environ.get("CLOUDINARY_CLOUD_NAME", "ooq99nlw")
PREFIX = "t-imawa/"
MAX_ATTEMPTS = 5

# A QuickSnap's private archive lasts seven days (quick-snap.js CFG.keepMs); the
# document carries the same deadline in `purgeAt`. Documents written before that
# field existed fall back to createdAt + KEEP_DAYS below.
KEEP_DAYS = 7

# Set when Cloudinary rejects the API key/secret. A 401 is never about one file
# — it is the whole account — so the run stops instead of burning every queued
# item's five attempts and parking them as `failed` until someone notices.
AUTH_REJECTED = False

# Every collection that can point at a Cloudinary file. The orphan sweep only
# deletes what is NOT referenced here, so a missing collection would mean
# deleting live media (member avatars, item photos) — keep this list complete.
MEDIA_COLLECTIONS = (
    "highlights",
    "stories",
    "notes",
    "announcements",
    "events",
    "users",
    "publicProfiles",
    "coffeeShops",
    "favoritePlaces",
    "thingsToDo",
    "chatMessages",
    "freedomNotes",
    "quickSnaps",
)


def log(*parts) -> None:
    print(*parts, flush=True)


# --------------------------------------------------------------------------- #
# Cloudinary
# --------------------------------------------------------------------------- #

def _signature(params: dict[str, str], secret: str) -> str:
    """Cloudinary signature: sha1 of the sorted k=v pairs, then the secret."""
    payload = "&".join(f"{k}={params[k]}" for k in sorted(params) if params[k] not in (None, ""))
    return hashlib.sha1((payload + secret).encode("utf-8")).hexdigest()


def public_id_from_url(url: str) -> str:
    """`.../upload/v1712/t-imawa/stories/ab_c.jpg` -> `t-imawa/stories/ab_c`."""
    if not isinstance(url, str) or "/upload/" not in url:
        return ""
    rest = url.split("/upload/", 1)[1]
    # A delivery transformation may sit in front of the version/folder.
    parts = rest.split("/")
    while parts and (re.fullmatch(r"v\d+", parts[0]) or _looks_like_transformation(parts[0])):
        parts = parts[1:]
    path = "/".join(parts)
    return re.sub(r"\.[A-Za-z0-9]+$", "", path)


def _looks_like_transformation(segment: str) -> bool:
    if not segment or "/" in segment:
        return False
    # w_480,q_auto,f_auto / so_0,w_480,h_854,c_fill,f_jpg / e_blur:300
    return "," in segment or bool(re.fullmatch(r"[a-z]{1,3}_[A-Za-z0-9._:%-]+", segment))


def _credentials_rejected(message: str) -> bool:
    """True when Cloudinary answered 401/403 rather than a per-asset problem."""
    return message.startswith("auth rejected")


def _mark_auth_rejected(step: str) -> None:
    global AUTH_REJECTED
    AUTH_REJECTED = True
    log(f"::error::Cloudinary rejected the API credentials during '{step}' — "
        "stopping so no queued item is marked failed by a bad secret.")


def destroy(public_id: str, resource_type: str, key: str, secret: str,
            dry_run: bool) -> tuple[bool, str]:
    """Delete one asset. Returns (ok, message)."""
    if dry_run:
        return True, "would delete"
    import requests

    params = {
        "public_id": public_id,
        "invalidate": "true",
        "timestamp": str(int(time.time())),
    }
    data = dict(params)
    data["api_key"] = key
    data["signature"] = _signature(params, secret)
    rtype = "video" if resource_type == "video" else "image"
    try:
        res = requests.post(
            f"https://api.cloudinary.com/v1_1/{CLOUD}/{rtype}/destroy",
            data=data, timeout=30,
        )
        body = {}
        try:
            body = res.json()
        except Exception:  # noqa: BLE001
            body = {}
        result = body.get("result", "")
        if result == "ok":
            return True, "deleted"
        if result == "not found":
            return True, "already gone"
        if res.status_code in (401, 403):
            return False, f"auth rejected ({body.get('error', {}).get('message', res.status_code)})"
        return False, f"{res.status_code} {result or body.get('error', {}).get('message', '')}".strip()
    except Exception as exc:  # noqa: BLE001
        return False, f"network error: {exc}"


def list_resources(resource_type: str, key: str, secret: str,
                   prefix: str, limit: int) -> list[dict]:
    """Every asset under `prefix` (paged). Empty list on failure."""
    import requests

    out: list[dict] = []
    cursor = ""
    while len(out) < limit:
        params = {"prefix": prefix, "max_results": 500, "type": "upload"}
        if cursor:
            params["next_cursor"] = cursor
        try:
            res = requests.get(
                f"https://api.cloudinary.com/v1_1/{CLOUD}/resources/{resource_type}",
                params=params, auth=(key, secret), timeout=30,
            )
        except Exception as exc:  # noqa: BLE001
            log(f"  ! could not list {resource_type}: {exc}")
            break
        if res.status_code != 200:
            log(f"  ! list {resource_type} failed: {res.status_code} {res.text[:160]}")
            break
        body = res.json() or {}
        out.extend(body.get("resources") or [])
        cursor = body.get("next_cursor") or ""
        if not cursor:
            break
    return out[:limit]


# --------------------------------------------------------------------------- #
# Firestore
# --------------------------------------------------------------------------- #

def init_firestore(service_account: Path | None):
    import firebase_admin
    from firebase_admin import credentials, firestore

    if service_account and service_account.exists():
        cred = credentials.Certificate(str(service_account))
    else:
        cred = credentials.ApplicationDefault()
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def _collect_media(value, ids: set[str], depth: int = 0) -> None:
    if depth > 4:
        return
    if isinstance(value, str):
        if value.startswith("http"):
            pid = public_id_from_url(value)
            if pid:
                ids.add(pid)
        elif PREFIX in value and " " not in value:
            ids.add(value)               # a bare public id field
    elif isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, str) and k in ("publicId", "public_id", "mediaPublicId",
                                            "imagePublicId", "thumbPublicId"):
                ids.add(v)
            else:
                _collect_media(v, ids, depth + 1)
    elif isinstance(value, (list, tuple)):
        for v in value[:60]:
            _collect_media(v, ids, depth + 1)


class _ScanTooLarge(Exception):
    """A collection is bigger than --scan-limit, so the scan is incomplete."""


def referenced_ids(db, limit: int) -> set[str]:
    """Every Cloudinary public id any live document still points at.

    The whole collection is streamed, not a capped page: a capped scan is an
    incomplete reference list (media referenced only by documents past the cap
    would look like orphans). --scan-limit is a safety rail — inside it the scan
    is complete, and past it the scan stops before spending the reads. It used
    to cap at 5000 documents and refuse to run, which meant one large collection
    (chat, for example) silently stopped the queue and the sweep for good.

    Raises if a collection cannot be read: an incomplete reference list would
    look like a pile of orphans, and the sweep would delete live media.
    """
    ids: set[str] = set()
    for name in MEDIA_COLLECTIONS:
        seen = 0
        try:
            for doc in db.collection(name).stream():
                seen += 1
                if seen > limit:
                    raise _ScanTooLarge(
                        f"{name} has more than {limit} documents — raise --scan-limit"
                    )
                _collect_media(doc.to_dict() or {}, ids)
        except _ScanTooLarge:
            raise
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"could not scan {name}: {exc}") from exc
    return ids


# --------------------------------------------------------------------------- #
# Work
# --------------------------------------------------------------------------- #

def drain_queue(db, key: str, secret: str, args) -> tuple[int, int]:
    done = failed = 0
    try:
        docs = list(db.collection(QUEUE).where("status", "==", "pending")
                    .limit(args.max_delete).stream())
    except Exception as exc:  # noqa: BLE001
        log(f"  ! could not read {QUEUE}: {exc}")
        return 0, 0

    if not docs:
        log("queue: empty")
        return 0, 0

    # A queued id is only deleted when nothing points at it *now*. A profile
    # picture can be queued by mistake — an earlier build queued the picture that
    # was still in use on every save — and deleting it turns every page's avatar
    # into a broken image. This is the same reference scan the orphan sweep uses,
    # and a failed scan keeps everything.
    try:
        live = referenced_ids(db, args.scan_limit)
    except Exception as exc:  # noqa: BLE001
        log(f"queue: nothing deleted — reference scan failed ({exc})")
        log("::warning::refusing to delete queued media without a complete reference scan")
        return 0, 0

    log(f"queue: {len(docs)} pending asset(s)")
    for doc in docs:
        item = doc.to_dict() or {}
        pid = (item.get("publicId") or "").strip()
        rtype = item.get("resourceType") or "image"
        attempts = int(item.get("attempts") or 0)

        if not pid:
            doc.reference.delete()
            continue
        if not pid.startswith(args.prefix) and not args.allow_outside_prefix:
            log(f"  - skip {pid} (outside {args.prefix})")
            doc.reference.update({"status": "failed",
                                  "lastError": f"outside {args.prefix}"})
            failed += 1
            continue

        if pid in live:
            log(f"  - keep {pid} (still referenced)")
            if not args.dry_run:
                doc.reference.delete()     # the request is stale, the file is not
            continue

        ok, msg = destroy(pid, rtype, key, secret, args.dry_run)
        if ok:
            log(f"  ✓ {pid} — {msg}")
            if not args.dry_run:
                doc.reference.delete()
            done += 1
        elif _credentials_rejected(msg):
            # Leave the document exactly as it was: the file is still there and
            # must be deleted once the secret is corrected.
            log(f"  ✗ {pid} — {msg}")
            _mark_auth_rejected("queue")
            return done, failed
        else:
            attempts += 1
            log(f"  ✗ {pid} — {msg}")
            if not args.dry_run:
                doc.reference.update({
                    "status": "pending" if attempts < MAX_ATTEMPTS else "failed",
                    "attempts": attempts,
                    "lastError": msg,
                    "lastAttemptAt": datetime.now(timezone.utc),
                })
            failed += 1
    return done, failed


# --------------------------------------------------------------------------- #
# Expired content

# Collections whose documents carry an expiry, plus the subcollections that hang
# off them (Firestore does not remove those when the parent goes).
EXPIRING = (
    ("stories", "expiresAt", ("reactions", "views")),
    ("highlights", "expiresAt", ()),
    ("announcements", "expiresAt", ()),
    ("freedomNotes", "expiresAt", ("comments", "reactions")),
    ("quickSnaps", "purgeAt", ("reactions",)),
)


def _as_datetime(value):
    """A Firestore Timestamp, a plain datetime, or None."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    for attr in ("to_datetime", "timestamp"):
        fn = getattr(value, attr, None)
        if not callable(fn):
            continue
        try:
            got = fn()
        except Exception:  # noqa: BLE001
            continue
        if isinstance(got, datetime):
            return got if got.tzinfo else got.replace(tzinfo=timezone.utc)
        if isinstance(got, (int, float)):
            return datetime.fromtimestamp(got, timezone.utc)
    return None


def purge_expired(db, key: str, secret: str, args) -> tuple[int, int, int]:
    """Delete documents whose expiry has passed, then the media they held.

    Expiry on its own only hides content: the document stays in Firestore with
    its mediaUrl intact, so the orphan sweep counts the file as referenced and
    keeps it forever. Deleting the document here closes that loop — once it is
    gone the file is unreferenced, and this run reclaims the storage.

    Returns (documents_deleted, assets_deleted, assets_failed).
    """
    now = datetime.now(timezone.utc)
    subs_of = {name: subs for name, _field, subs in EXPIRING}
    doomed: list[tuple[str, str, dict]] = []

    for name, field, _subs in EXPIRING:
        try:
            docs = list(db.collection(name).where(field, "<=", now)
                        .limit(args.max_delete).stream())
        except Exception as exc:  # noqa: BLE001
            log(f"expired: could not scan {name}: {exc}")
            continue
        if docs:
            log(f"expired: {len(docs)} {name} document(s) past their {field}")
        for doc in docs:
            doomed.append((name, doc.id, doc.to_dict() or {}))

    # QuickSnaps written before `purgeAt` existed: Firestore never matches a
    # missing field in a `<=` filter, so those documents were never purged and,
    # because they still referenced their image, the orphan sweep kept the file
    # too — the archive's seven days never ended. Give them the same deadline,
    # measured from createdAt, and only when the document has no future purgeAt
    # of its own.
    seen = {doc_id for name, doc_id, _data in doomed if name == "quickSnaps"}
    try:
        legacy = list(db.collection("quickSnaps")
                      .where("createdAt", "<=", now - timedelta(days=KEEP_DAYS))
                      .limit(args.max_delete).stream())
    except Exception as exc:  # noqa: BLE001
        log(f"expired: could not scan quickSnaps.createdAt: {exc}")
        legacy = []
    for doc in legacy:
        if doc.id in seen:
            continue
        data = doc.to_dict() or {}
        purge_at = _as_datetime(data.get("purgeAt"))
        if purge_at is not None and purge_at > now:
            continue                    # an explicit purgeAt always wins
        log(f"expired: quickSnaps/{doc.id} has no purgeAt — using createdAt + {KEEP_DAYS}d")
        doomed.append(("quickSnaps", doc.id, data))
        seen.add(doc.id)

    if not doomed:
        log("expired: nothing past its expiry")
        return 0, 0, 0

    # What those documents were holding, and with which resource type.
    held: dict[str, str] = {}
    for _name, _id, data in doomed:
        ids: set[str] = set()
        _collect_media(data, ids)
        rtype = "video" if data.get("mediaType") == "video" else "image"
        for pid in ids:
            held.setdefault(pid, rtype)

    if args.dry_run:
        log(f"expired: would delete {len(doomed)} document(s) and free "
            f"{len(held)} asset(s) — run with --apply to remove them")
        return len(doomed), 0, 0

    deleted = 0
    for name, doc_id, _data in doomed:
        ref = db.collection(name).document(doc_id)
        for sub in subs_of.get(name, ()):
            try:
                for child in ref.collection(sub).limit(200).stream():
                    child.reference.delete()
            except Exception:  # noqa: BLE001
                pass                    # subcollections are best effort
        try:
            ref.delete()
            deleted += 1
        except Exception as exc:  # noqa: BLE001
            log(f"  ! could not delete {name}/{doc_id}: {exc}")
    log(f"expired: removed {deleted} document(s); their media is unreferenced now")

    if not held:
        return deleted, 0, 0

    # Only the files nothing else points at (a story quoted in a chat, a reused
    # public id) — the same guarantee the orphan sweep gives.
    try:
        live = referenced_ids(db, args.scan_limit)
    except Exception as exc:  # noqa: BLE001
        log(f"expired: media kept — reference scan failed ({exc})")
        return deleted, 0, 0

    done = failed = 0
    for pid in sorted(held):
        if done + failed >= args.max_delete:
            log(f"expired: stopping at --max-delete {args.max_delete}")
            break
        if pid in live:
            log(f"  - keep {pid} (still referenced)")
            continue
        if not pid.startswith(args.prefix) and not args.allow_outside_prefix:
            log(f"  - skip {pid} (outside {args.prefix})")
            continue
        ok, msg = destroy(pid, held[pid], key, secret, False)
        log(f"  {'✓' if ok else '✗'} {pid} — {msg}")
        if not ok and _credentials_rejected(msg):
            _mark_auth_rejected("expired")
            break                       # the documents are gone; media waits for the fix
        done += 1 if ok else 0
        failed += 0 if ok else 1
        if ok:
            time.sleep(0.05)            # stay well inside rate limits
    return deleted, done, failed


def sweep_orphans(db, key: str, secret: str, args) -> tuple[int, int]:
    try:
        live = referenced_ids(db, args.scan_limit)
    except Exception as exc:  # noqa: BLE001
        log(f"orphans: aborted — {exc}")
        log("::warning::refusing to delete anything without a complete reference scan")
        return 0, 0
    log(f"orphans: {len(live)} referenced asset(s) across "
        f"{len(MEDIA_COLLECTIONS)} collections")

    now = time.time()
    cutoff = now - (args.min_age_hours * 3600)
    candidates: list[dict] = []

    for rtype in ("image", "video"):
        for res in list_resources(rtype, key, secret, args.prefix, args.list_limit):
            pid = res.get("public_id") or ""
            if not pid.startswith(args.prefix):
                continue
            if pid in live:
                continue
            created = res.get("created_at") or ""
            try:
                stamp = datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
            except Exception:  # noqa: BLE001
                stamp = 0
            if stamp and stamp > cutoff:
                continue                      # too new: the doc may still be in flight
            candidates.append({"public_id": pid, "resource_type": rtype})

    candidates = candidates[: args.max_delete]
    if not candidates:
        log("orphans: none")
        return 0, 0

    log(f"orphans: {len(candidates)} unreferenced asset(s) older than "
        f"{args.min_age_hours}h")
    done = failed = 0
    for c in candidates:
        ok, msg = destroy(c["public_id"], c["resource_type"], key, secret, args.dry_run)
        log(f"  {'✓' if ok else '✗'} {c['public_id']} — {msg}")
        if not ok and _credentials_rejected(msg):
            _mark_auth_rejected("orphans")
            break                             # nothing more can be deleted this run
        done += 1 if ok else 0
        failed += 0 if ok else 1
        if not args.dry_run:
            time.sleep(0.05)                  # stay well inside rate limits
    return done, failed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["queue", "orphans", "both"], default="queue")
    ap.add_argument("--apply", action="store_true",
                    help="actually delete (default is a dry run)")
    ap.add_argument("--service-account", type=Path, default=DEFAULT_SA)
    ap.add_argument("--prefix", default=PREFIX,
                    help="only touch assets under this Cloudinary folder")
    ap.add_argument("--allow-outside-prefix", action="store_true")
    ap.add_argument("--max-delete", type=int, default=300)
    ap.add_argument("--list-limit", type=int, default=2000)
    ap.add_argument("--scan-limit", type=int, default=20000,
                    help="maximum documents scanned per collection before the "
                         "reference scan refuses to run (raise it as the app grows)")
    ap.add_argument("--min-age-hours", type=float, default=24.0,
                    help="orphans must be at least this old (upload in flight guard)")
    ap.add_argument("--purge-expired", action=argparse.BooleanOptionalAction, default=True,
                    help="delete stories/highlights/announcements past expiresAt, "
                         "then the media they were holding (--no-purge-expired to skip)")
    args = ap.parse_args()
    args.dry_run = not args.apply

    key = os.environ.get("CLOUDINARY_API_KEY", "").strip()
    secret = os.environ.get("CLOUDINARY_API_SECRET", "").strip()
    if not args.dry_run and (not key or not secret):
        log("::error::CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not set")
        return 2
    if args.dry_run and (not key or not secret):
        log("note: no Cloudinary credentials — listing and deletion are simulated")

    log(f"cloud={CLOUD} mode={args.mode} "
        f"{'DRY RUN' if args.dry_run else 'APPLY'} prefix={args.prefix}")

    # The queue needs Firestore even in dry-run (it reports what it would do).
    db = None
    try:
        db = init_firestore(args.service_account)
    except Exception as exc:  # noqa: BLE001
        log(f"::warning::Firestore unavailable ({exc}); queue step skipped")

    total_done = total_failed = 0
    expired_docs = 0

    # Runs in every mode: an expired document is dead weight in Firestore and
    # pins its media for as long as it exists.
    if db is not None and args.purge_expired:
        expired_docs, done, failed = purge_expired(db, key, secret, args)
        total_done += done
        total_failed += failed

    if db is not None and args.mode in ("queue", "both"):
        done, failed = drain_queue(db, key, secret, args)
        total_done += done
        total_failed += failed

    if args.mode in ("orphans", "both") and not AUTH_REJECTED:
        if not key or not secret:
            log("orphans: skipped (needs credentials to list the account)")
        else:
            done, failed = sweep_orphans(db, key, secret, args)
            total_done += done
            total_failed += failed

    log(f"\nexpired documents {'that would be removed' if args.dry_run else 'removed'}: "
        f"{expired_docs}")
    log(f"{'would delete' if args.dry_run else 'deleted'}: {total_done} · "
        f"failed: {total_failed}")
    if AUTH_REJECTED:
        log("::error::Cloudinary rejected the API credentials, so nothing else was "
            "deleted. Set CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET to the current "
            "pair (Cloudinary dashboard -> Settings -> API Keys). Queued files were "
            "left in place and the next run deletes them.")
        return 1
    if total_failed:
        log("::warning::some assets could not be deleted — see the lines above")
    return 0


if __name__ == "__main__":
    sys.exit(main())
