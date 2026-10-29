#!/usr/bin/env python3
"""Tests for tools/cloudinary_cleanup.py.

Run from the project root:

    python -m unittest discover -s tools/tests -v

No network, no Firestore, no Cloudinary account is needed: the tool is driven
against in-memory fakes for Firestore documents and for the Cloudinary HTTP
calls, so every branch (delete, already-gone, auth failure, retry, prefix guard,
orphan sweep, dry run) is exercised deterministically.

The cases that matter most for "assets nobody uses any more":

  * a replaced profile photo (the users/publicProfiles documents point at the
    new URL) is deleted by the orphan sweep, while the new one is kept;
  * an avatar the app queued at replacement time is deleted even on the next
    queue run, without waiting for an orphan sweep;
  * nothing is ever deleted when the reference scan is incomplete.
"""

from __future__ import annotations

import io
import sys
import types
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

import cloudinary_cleanup as cc  # noqa: E402


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #

class FakeRef:
    def __init__(self, store, coll, doc_id):
        self.store, self.coll, self.doc_id = store, coll, doc_id

    def update(self, data):
        self.store[self.coll].setdefault(self.doc_id, {}).update(data)

    def delete(self):
        self.store[self.coll].pop(self.doc_id, None)


class FakeDoc:
    def __init__(self, store, coll, doc_id, data):
        self._store, self._coll, self._id, self._data = store, coll, doc_id, data

    @property
    def id(self):
        return self._id

    def to_dict(self):
        return dict(self._data)

    @property
    def reference(self):
        return FakeRef(self._store, self._coll, self._id)


class FakeQuery:
    def __init__(self, docs):
        self._docs = docs

    def where(self, field, op, value):
        def get(d):
            return (d.to_dict() or {}).get(field)
        if op == "==":
            keep = [d for d in self._docs if get(d) == value]
        elif op == "<=":
            keep = [d for d in self._docs if get(d) is not None and get(d) <= value]
        else:  # pragma: no cover - not used by the tool
            raise AssertionError(f"unsupported op {op}")
        return FakeQuery(keep)

    def limit(self, n):
        return FakeQuery(self._docs[:n])

    def stream(self):
        return list(self._docs)


class FakeCollection:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def document(self, doc_id):  # not used by the tool, kept for symmetry
        return FakeRef(self.store, self.name, doc_id)

    def doc(self, doc_id):
        return FakeRef(self.store, self.name, doc_id)

    def _docs(self):
        return [FakeDoc(self.store, self.name, i, d)
                for i, d in self.store.get(self.name, {}).items()]

    def limit(self, n):
        return FakeQuery(self._docs()).limit(n)

    def where(self, field, op, value):
        return FakeQuery(self._docs()).where(field, op, value)

    def stream(self):
        return FakeQuery(self._docs()).stream()


class FakeDB:
    """In-memory stand-in: {collection: {doc_id: {...}}}."""

    def __init__(self, data=None, broken=()):
        self.store = {k: dict(v) for k, v in (data or {}).items()}
        self.broken = set(broken)

    def collection(self, name):
        if name in self.broken:
            raise RuntimeError("permission denied")
        return FakeCollection(self.store, name)

    def docs(self, name):
        return self.store.get(name, {})


class FakeResponse:
    def __init__(self, status_code=200, body=None, text=""):
        self.status_code = status_code
        self._body = body or {}
        self.text = text or ""

    def json(self):
        return self._body


class FakeRequests(types.ModuleType):
    """Records every Cloudinary call and answers from a scripted queue."""

    def __init__(self, destroy_results=None, list_pages=None):
        super().__init__("requests")
        # The tool imports `requests` lazily inside each function; installing the
        # fake in sys.modules here is what makes that import resolve to us.
        sys.modules["requests"] = self
        global REQ
        REQ = self
        self.destroy_results = list(destroy_results or [])
        self.list_pages = list(list_pages or [])
        self.posts = []
        self.gets = []

    def post(self, url, data=None, timeout=None):
        self.posts.append({"url": url, "data": dict(data or {})})
        if not self.destroy_results:
            return FakeResponse(200, {"result": "ok"})
        nxt = self.destroy_results.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def get(self, url, params=None, auth=None, timeout=None):
        self.gets.append({"url": url, "params": dict(params or {}), "auth": auth})
        if not self.list_pages:
            return FakeResponse(200, {"resources": []})
        nxt = self.list_pages.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def args(**over):
    ns = types.SimpleNamespace(
        mode="queue", apply=True, dry_run=False, prefix="t-imawa/",
        allow_outside_prefix=False, max_delete=300, list_limit=2000,
        scan_limit=5000, min_age_hours=24.0, service_account=None,
    )
    for k, v in over.items():
        setattr(ns, k, v)
    return ns


def cloud(name, created_hours_ago=48, resource_type="image"):
    stamp = datetime.now(timezone.utc) - timedelta(hours=created_hours_ago)
    return {"public_id": name, "resource_type": resource_type,
            "created_at": stamp.isoformat().replace("+00:00", "Z")}


URL = "https://res.cloudinary.com/ooq99nlw/image/upload/v1712/{}.jpg"


REQ = None


def use_requests(req):
    """Put the fake in place of the real module for the tool's lazy import."""
    global REQ
    REQ = req
    sys.modules["requests"] = req
    return req


def quiet(fn, *a, **kw):
    with redirect_stdout(io.StringIO()):
        return fn(*a, **kw)


# --------------------------------------------------------------------------- #
# URL / signature / reference collection
# --------------------------------------------------------------------------- #

class PublicIdParsing(unittest.TestCase):
    def test_plain_upload_url(self):
        self.assertEqual(
            cc.public_id_from_url(URL.format("t-imawa/stories/abc123")),
            "t-imawa/stories/abc123")

    def test_transformation_prefix_is_skipped(self):
        url = ("https://res.cloudinary.com/ooq99nlw/image/upload/"
               "w_120,h_120,c_fill,g_face,q_auto:good,f_auto/v1712/t-imawa/profiles/pic.jpg")
        self.assertEqual(cc.public_id_from_url(url), "t-imawa/profiles/pic")

    def test_dots_inside_the_path_are_kept(self):
        # Dots belong to the id; only the trailing file extension goes away.
        url = "https://res.cloudinary.com/x/image/upload/v1/t-imawa/2024.05.01/banner.png"
        self.assertEqual(cc.public_id_from_url(url), "t-imawa/2024.05.01/banner")

    def test_non_upload_and_non_string(self):
        self.assertEqual(cc.public_id_from_url("https://example.com/a.jpg"), "")
        self.assertEqual(cc.public_id_from_url(None), "")
        self.assertEqual(cc.public_id_from_url(""), "")

    def test_video_url(self):
        url = "https://res.cloudinary.com/ooq99nlw/video/upload/v1712/t-imawa/stories/clip.mp4"
        self.assertEqual(cc.public_id_from_url(url), "t-imawa/stories/clip")


class Signing(unittest.TestCase):
    def test_signature_is_sorted_and_secret_suffixed(self):
        import hashlib
        params = {"public_id": "t-imawa/x", "invalidate": "true", "timestamp": "1700000000"}
        expect = hashlib.sha1(
            ("invalidate=true&public_id=t-imawa/x&timestamp=1700000000" + "s3cr3t").encode()
        ).hexdigest()
        self.assertEqual(cc._signature(params, "s3cr3t"), expect)

    def test_empty_values_are_dropped(self):
        self.assertEqual(cc._signature({"a": "1", "b": ""}, "k"),
                         cc._signature({"a": "1"}, "k"))


class ReferenceScan(unittest.TestCase):
    def test_collects_urls_bare_ids_and_nested_shapes(self):
        ids = set()
        cc._collect_media({
            "photoURL": URL.format("t-imawa/profiles/a"),
            "imagePublicIds": ["t-imawa/highlights/b"],
            "nested": {"mediaPublicId": "t-imawa/stories/c"},
            "list": [{"thumbPublicId": "t-imawa/thumbs/d"}],
            "notMedia": "hello world",
            "external": "https://example.com/x.jpg",
        }, ids)
        self.assertEqual(ids, {"t-imawa/profiles/a", "t-imawa/highlights/b",
                               "t-imawa/stories/c", "t-imawa/thumbs/d"})

    def test_depth_limit(self):
        deep = {"k": {"k": {"k": {"k": {"k": {"k": "t-imawa/deep"}}}}}}
        ids = set()
        cc._collect_media(deep, ids)
        self.assertEqual(ids, set())

    def test_scan_reads_every_media_collection(self):
        db = FakeDB({"users": {"u1": {"photoURL": URL.format("t-imawa/profiles/1")}},
                     "highlights": {"h1": {"imagePublicIds": ["t-imawa/highlights/1"]}}})
        ids = quiet(cc.referenced_ids, db, 100)
        self.assertIn("t-imawa/profiles/1", ids)
        self.assertIn("t-imawa/highlights/1", ids)

    def test_scan_failure_raises_so_the_sweep_cannot_misjudge(self):
        db = FakeDB({}, broken=("users",))
        with self.assertRaises(RuntimeError):
            quiet(cc.referenced_ids, db, 100)


# --------------------------------------------------------------------------- #
# Queue drain
# --------------------------------------------------------------------------- #

class QueueDrain(unittest.TestCase):
    def test_deletes_on_ok_and_removes_the_document(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "t-imawa/stories/1",
                                                  "status": "pending", "attempts": 0}}})
        req = FakeRequests(destroy_results=[FakeResponse(200, {"result": "ok"})])
        use_requests(req)
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (1, 0))
        self.assertEqual(db.docs("mediaCleanupQueue"), {})
        self.assertEqual(req.posts[0]["data"]["api_key"], "k")
        self.assertIn("signature", req.posts[0]["data"])
        self.assertTrue(req.posts[0]["data"]["invalidate"] == "true")

    def test_already_gone_counts_as_done(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "t-imawa/x", "status": "pending"}}})
        req = FakeRequests(destroy_results=[FakeResponse(200, {"result": "not found"})])
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (1, 0))
        self.assertEqual(db.docs("mediaCleanupQueue"), {})

    def test_auth_failure_retries_then_marks_failed(self):
        items = {"d1": {"publicId": "t-imawa/x", "status": "pending", "attempts": 4}}
        db = FakeDB({"mediaCleanupQueue": items})
        req = FakeRequests(destroy_results=[
            FakeResponse(401, {"error": {"message": "Unknown API key"}})])
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (0, 1))
        doc = db.docs("mediaCleanupQueue")["d1"]
        self.assertEqual(doc["status"], "failed")      # fifth strike
        self.assertEqual(doc["attempts"], 5)
        self.assertIn("auth rejected", doc["lastError"])

    def test_failure_below_limit_stays_pending(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "t-imawa/x",
                                                  "status": "pending", "attempts": 0}}})
        req = FakeRequests(destroy_results=[FakeResponse(500, {}, "boom")])
        quiet(cc.drain_queue, db, "k", "s", args())
        doc = db.docs("mediaCleanupQueue")["d1"]
        self.assertEqual(doc["status"], "pending")
        self.assertEqual(doc["attempts"], 1)

    def test_network_exception_is_a_failure_not_a_crash(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "t-imawa/x", "status": "pending"}}})
        req = FakeRequests(destroy_results=[RuntimeError("timeout")])
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (0, 1))
        self.assertIn("network error", db.docs("mediaCleanupQueue")["d1"]["lastError"])

    def test_outside_prefix_is_never_deleted(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "other/secret", "status": "pending"}}})
        req = FakeRequests()
        use_requests(req)
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (0, 1))
        self.assertEqual(req.posts, [])
        self.assertEqual(db.docs("mediaCleanupQueue")["d1"]["status"], "failed")

    def test_allow_outside_prefix_opt_in(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "legacy/x", "status": "pending"}}})
        req = FakeRequests()
        use_requests(req)
        quiet(cc.drain_queue, db, "k", "s", args(allow_outside_prefix=True))
        self.assertEqual(len(req.posts), 1)
        self.assertEqual(db.docs("mediaCleanupQueue"), {})

    def test_empty_public_id_document_is_dropped(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "  ", "status": "pending"}}})
        req = FakeRequests()
        use_requests(req)
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (0, 0))
        self.assertEqual(req.posts, [])
        self.assertEqual(db.docs("mediaCleanupQueue"), {})

    def test_dry_run_deletes_nothing_and_keeps_the_document(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "t-imawa/x", "status": "pending"}}})
        req = FakeRequests()
        use_requests(req)
        done, failed = quiet(cc.drain_queue, db, "k", "s", args(dry_run=True))
        self.assertEqual((done, failed), (1, 0))
        self.assertEqual(req.posts, [])
        self.assertIn("d1", db.docs("mediaCleanupQueue"))

    def test_video_resource_type_uses_the_video_endpoint(self):
        db = FakeDB({"mediaCleanupQueue": {"d1": {"publicId": "t-imawa/stories/v",
                                                  "resourceType": "video", "status": "pending"}}})
        req = FakeRequests()
        use_requests(req)
        quiet(cc.drain_queue, db, "k", "s", args())
        self.assertIn("/video/destroy", req.posts[0]["url"])

    def test_empty_queue_is_a_no_op(self):
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, FakeDB({}), "k", "s", args())
        self.assertEqual((done, failed), (0, 0))


# --------------------------------------------------------------------------- #
# Orphan sweep — the path that frees REPLACED profile photos
# --------------------------------------------------------------------------- #

class OrphanSweep(unittest.TestCase):
    def _db_with_avatar(self, url=URL.format("t-imawa/profiles/new")):
        return FakeDB({
            "users": {"u1": {"photoURL": url}},
            "publicProfiles": {"u1": {"photoURL": url}},
        })

    def test_replaced_profile_photo_is_deleted_and_the_new_one_kept(self):
        db = self._db_with_avatar()
        # The account holds the old avatar and the new one.
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("t-imawa/profiles/old", 72),
            cloud("t-imawa/profiles/new", 1),
        ]})])
        done, failed = quiet(cc.sweep_orphans, db, "k", "s", args())
        self.assertEqual((done, failed), (1, 0))
        deleted = [p["data"]["public_id"] for p in REQ.posts]
        self.assertEqual(deleted, ["t-imawa/profiles/old"])

    def test_fresh_orphan_is_protected_by_min_age(self):
        db = self._db_with_avatar()
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("t-imawa/profiles/just-uploaded", 0.2),   # document still in flight
        ]})])
        done, failed = quiet(cc.sweep_orphans, db, "k", "s", args())
        self.assertEqual((done, failed), (0, 0))
        self.assertEqual(REQ.posts, [])

    def test_asset_still_referenced_by_any_collection_is_kept(self):
        db = self._db_with_avatar(URL.format("t-imawa/profiles/new"))
        db.store["chatMessages"] = {"m1": {"imageUrl": URL.format("t-imawa/chat/kept")}}
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("t-imawa/chat/kept", 100),
            cloud("t-imawa/profiles/old", 100),
        ]})])
        done, _ = quiet(cc.sweep_orphans, db, "k", "s", args())
        self.assertEqual(done, 1)
        self.assertEqual([p["data"]["public_id"] for p in REQ.posts],
                         ["t-imawa/profiles/old"])

    def test_aborts_without_deleting_when_the_reference_scan_fails(self):
        db = FakeDB({}, broken=("users",))
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("t-imawa/profiles/old", 100)]})])
        use_requests(req)
        done, failed = quiet(cc.sweep_orphans, db, "k", "s", args())
        self.assertEqual((done, failed), (0, 0))
        self.assertEqual(req.gets, [])      # never even listed
        self.assertEqual(req.posts, [])

    def test_assets_outside_the_app_prefix_are_ignored(self):
        db = self._db_with_avatar()
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("some-other-app/hero", 200),
        ]})])
        done, _ = quiet(cc.sweep_orphans, db, "k", "s", args())
        self.assertEqual(done, 0)
        self.assertEqual(REQ.posts, [])

    def test_max_delete_caps_the_run(self):
        db = self._db_with_avatar()
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud(f"t-imawa/profiles/old{i}", 100) for i in range(10)
        ]})])
        done, _ = quiet(cc.sweep_orphans, db, "k", "s", args(max_delete=3))
        self.assertEqual(done, 3)
        self.assertEqual(len(REQ.posts), 3)

    def test_dry_run_lists_but_deletes_nothing(self):
        db = self._db_with_avatar()
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("t-imawa/profiles/old", 100)]})])
        done, _ = quiet(cc.sweep_orphans, db, "k", "s", args(dry_run=True))
        self.assertEqual(done, 1)
        self.assertEqual(REQ.posts, [])

    def test_video_assets_are_listed_too(self):
        db = self._db_with_avatar()
        req = FakeRequests(list_pages=[
            FakeResponse(200, {"resources": []}),                                   # images
            FakeResponse(200, {"resources": [cloud("t-imawa/stories/expired", 90, "video")]}),
        ])
        quiet(cc.sweep_orphans, db, "k", "s", args())
        self.assertEqual([g["url"].rsplit("/", 1)[-1] for g in REQ.gets],
                         ["image", "video"])
        self.assertIn("/video/destroy", REQ.posts[0]["url"])


# --------------------------------------------------------------------------- #
# End-to-end: the two paths a replaced avatar can travel
# --------------------------------------------------------------------------- #

class ProfileReplacementEndToEnd(unittest.TestCase):
    def test_queued_replacement_is_deleted_on_the_next_queue_run(self):
        """profile.html queues the old public id the moment it is replaced."""
        db = FakeDB({
            "users": {"u1": {"photoURL": URL.format("t-imawa/profiles/new")}},
            "mediaCleanupQueue": {
                "t-imawa_profiles_old": {
                    "publicId": "t-imawa/profiles/old", "resourceType": "image",
                    "source": "profile", "sourceId": "u1",
                    "status": "pending", "attempts": 0,
                }
            },
        })
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (1, 0))
        self.assertEqual([p["data"]["public_id"] for p in REQ.posts],
                         ["t-imawa/profiles/old"])
        self.assertEqual(db.docs("mediaCleanupQueue"), {})

    def test_sweep_catches_a_replacement_the_app_never_queued(self):
        """Old rows, cleared browser data, or a save from a page without the
        queue: the avatar is unreferenced, so the orphan sweep frees it."""
        db = FakeDB({
            "users": {"u1": {"photoURL": URL.format("t-imawa/profiles/replaced")}},
            "publicProfiles": {"u1": {"photoURL": URL.format("t-imawa/profiles/replaced")}},
            "highlights": {"h1": {"imageURLs": [URL.format("t-imawa/highlights/live")],
                                  "imagePublicIds": ["t-imawa/highlights/live"]}},
        })
        req = FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("t-imawa/profiles/from-2023", 20000),
            cloud("t-imawa/profiles/replaced", 5),
            cloud("t-imawa/highlights/live", 30),
        ]})])
        done, _ = quiet(cc.sweep_orphans, db, "k", "s", args())
        self.assertEqual(done, 1)
        self.assertEqual([p["data"]["public_id"] for p in REQ.posts],
                         ["t-imawa/profiles/from-2023"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
