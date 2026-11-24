#!/usr/bin/env python3
"""End-to-end tests for the deletion half of the Cloudinary automation.

Each test starts with the document a page writes when content is deleted or
replaced, and ends with (a) a correctly signed Cloudinary destroy call and
(b) the queue document going away. If any link in that chain breaks, the file is
never deleted — which is the bug the whole tool exists to prevent.

Run from the project root:

    python -m unittest discover -s tools/tests -v
"""

from __future__ import annotations

import sys
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from io import StringIO
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent))     # tools/
sys.path.insert(0, str(TESTS))            # the shared fakes

import cloudinary_cleanup as cc  # noqa: E402
from test_cloudinary_cleanup import (  # noqa: E402
    FakeDB, FakeRequests, FakeResponse, URL, args, cloud, quiet, use_requests,
)


class DeletionPipelineEndToEnd(unittest.TestCase):
    """Every path below starts with a document the site writes when content is
    deleted or replaced, and ends with a signed destroy call plus the queue
    document disappearing."""

    def _assert_signed(self, req, secret="s"):
        for post in req.posts:
            data = post["data"]
            expected = cc._signature({
                "public_id": data["public_id"],
                "invalidate": data["invalidate"],
                "timestamp": data["timestamp"],
            }, secret)
            self.assertEqual(data["signature"], expected,
                             "bad signature for %s" % data["public_id"])
            self.assertEqual(data["invalidate"], "true")

    def test_highlight_expiry_on_the_home_page_frees_every_photo(self):
        # index.html deleteHighlight(): exact ids when the document had them,
        # URL-derived ids otherwise. Both land in the queue.
        db = FakeDB({"mediaCleanupQueue": {
            "t-imawa_highlights_a": {"publicId": "t-imawa/highlights/a",
                                     "resourceType": "image", "source": "highlight",
                                     "sourceId": "h1", "status": "pending", "attempts": 0},
            "t-imawa_highlights_b": {"publicId": "t-imawa/highlights/b",
                                     "resourceType": "image", "source": "highlight",
                                     "sourceId": "h1", "status": "pending", "attempts": 0},
        }})
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (2, 0))
        self.assertEqual(sorted(p["data"]["public_id"] for p in req.posts),
                         ["t-imawa/highlights/a", "t-imawa/highlights/b"])
        self._assert_signed(req)
        self.assertEqual(db.docs("mediaCleanupQueue"), {})

    def test_item_delete_frees_one_photo(self):
        # admin.html deleteItem(): {source: 'item'} for coffee/places/activities.
        db = FakeDB({"mediaCleanupQueue": {
            "t-imawa_items_cafe": {"publicId": "t-imawa/items/cafe",
                                   "resourceType": "image", "source": "item",
                                   "sourceId": "c1", "status": "pending", "attempts": 0},
        }})
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (1, 0))
        self.assertEqual([p["data"]["public_id"] for p in req.posts],
                         ["t-imawa/items/cafe"])
        self._assert_signed(req)
        self.assertEqual(db.docs("mediaCleanupQueue"), {})

    def test_item_photo_replace_deletes_only_the_old_file(self):
        # admin.html saveItem(): the old id is queued; the document now points at
        # the new file, so the reference scan protects it.
        old = "t-imawa/items/cafe"
        new = "t-imawa/items/cafe-new"
        db = FakeDB({
            "coffeeShops": {"c1": {"imageUrl": URL.format(new)}},
            "mediaCleanupQueue": {"t-imawa_items_cafe": {
                "publicId": old, "resourceType": "image", "source": "item",
                "sourceId": "c1", "status": "pending", "attempts": 0}},
        })
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (1, 0))
        self.assertEqual([p["data"]["public_id"] for p in req.posts], [old])

    def test_failed_story_publish_frees_image_and_video(self):
        # stories-composer.js discardUploads(): one document per upload, typed.
        db = FakeDB({"mediaCleanupQueue": {
            "t-imawa_stories_pic": {"publicId": "t-imawa/stories/pic",
                                    "resourceType": "image", "source": "story",
                                    "status": "pending", "attempts": 0},
            "t-imawa_stories_clip": {"publicId": "t-imawa/stories/clip",
                                     "resourceType": "video", "source": "story",
                                     "status": "pending", "attempts": 0},
        }})
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, db, "k", "s", args())
        self.assertEqual((done, failed), (2, 0))
        urls = {p["data"]["public_id"]: p["url"] for p in req.posts}
        self.assertIn("/image/destroy", urls["t-imawa/stories/pic"])
        self.assertIn("/video/destroy", urls["t-imawa/stories/clip"])
        self.assertEqual(db.docs("mediaCleanupQueue"), {})

    def test_expired_quicksnap_is_purged_by_purge_at(self):
        # quickSnaps hide after expiresAt but are only deleted after purgeAt.
        db = FakeDB({
            "quickSnaps": {"q1": {
                "imageUrl": URL.format("t-imawa/quicksnaps/q1"),
                "imagePublicId": "t-imawa/quicksnaps/q1",
                "expiresAt": datetime.now(timezone.utc) - timedelta(days=4),
                "purgeAt": datetime.now(timezone.utc) - timedelta(days=1),
            }},
            "quickSnaps/q1/reactions": {"u1": {"emoji": "x"}},
        })
        req = FakeRequests()
        docs, done, failed = quiet(cc.purge_expired, db, "k", "s", args())
        self.assertEqual((docs, done, failed), (1, 1, 0))
        self.assertEqual(db.docs("quickSnaps"), {})
        self.assertEqual(db.docs("quickSnaps/q1/reactions"), {})
        self.assertEqual([p["data"]["public_id"] for p in req.posts],
                         ["t-imawa/quicksnaps/q1"])

    def test_archived_snap_without_purge_at_is_purged_after_seven_days(self):
        # Snaps written before `purgeAt` existed never matched the purgeAt
        # filter, so their document and Cloudinary file stayed forever.
        db = FakeDB({"quickSnaps": {"legacy": {
            "imageUrl": URL.format("t-imawa/quicksnaps/legacy"),
            "imagePublicId": "t-imawa/quicksnaps/legacy",
            "createdAt": datetime.now(timezone.utc) - timedelta(days=8),
        }}})
        req = FakeRequests()
        docs, done, failed = quiet(cc.purge_expired, db, "k", "s", args())
        self.assertEqual((docs, done, failed), (1, 1, 0))
        self.assertEqual(db.docs("quickSnaps"), {})
        self.assertEqual([p["data"]["public_id"] for p in req.posts],
                         ["t-imawa/quicksnaps/legacy"])

    def test_archived_snap_without_purge_at_inside_seven_days_is_kept(self):
        # The seven-day archive is a promise: nothing is deleted before it.
        db = FakeDB({"quickSnaps": {"fresh": {
            "imageUrl": URL.format("t-imawa/quicksnaps/fresh"),
            "createdAt": datetime.now(timezone.utc) - timedelta(days=3),
        }}})
        req = FakeRequests()
        docs, done, failed = quiet(cc.purge_expired, db, "k", "s", args())
        self.assertEqual((docs, done, failed), (0, 0, 0))
        self.assertIn("fresh", db.docs("quickSnaps"))
        self.assertEqual(req.posts, [])

    def test_still_hidden_but_not_due_quicksnap_is_kept(self):
        db = FakeDB({"quickSnaps": {"q1": {
            "imageUrl": URL.format("t-imawa/quicksnaps/q1"),
            "expiresAt": datetime.now(timezone.utc) - timedelta(days=4),
            "purgeAt": datetime.now(timezone.utc) + timedelta(days=3),
        }}})
        req = FakeRequests()
        docs, done, failed = quiet(cc.purge_expired, db, "k", "s", args())
        self.assertEqual((docs, done, failed), (0, 0, 0))
        self.assertIn("q1", db.docs("quickSnaps"))
        self.assertEqual(req.posts, [])


class ScanSafetyRail(unittest.TestCase):
    """A scan that cannot see every document must never delete anything."""

    def test_queue_run_deletes_nothing_past_scan_limit(self):
        db = FakeDB({
            "users": {"u%d" % i: {"photoURL": URL.format("t-imawa/profiles/%d" % i)}
                      for i in range(3)},
            "mediaCleanupQueue": {"d1": {"publicId": "t-imawa/profiles/0",
                                         "status": "pending", "attempts": 0}},
        })
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, db, "k", "s", args(scan_limit=2))
        self.assertEqual((done, failed), (0, 0))
        self.assertEqual(req.posts, [])
        self.assertIn("d1", db.docs("mediaCleanupQueue"))

    def test_orphan_sweep_never_lists_when_the_scan_is_incomplete(self):
        db = FakeDB({"users": {"u%d" % i: {} for i in range(3)}})
        req = use_requests(FakeRequests(list_pages=[FakeResponse(200, {"resources": [
            cloud("t-imawa/profiles/orphan", 100)]})]))
        done, failed = quiet(cc.sweep_orphans, db, "k", "s", args(scan_limit=2))
        self.assertEqual((done, failed), (0, 0))
        self.assertEqual(req.gets, [])
        self.assertEqual(req.posts, [])

    def test_exactly_at_the_limit_is_still_complete(self):
        db = FakeDB({
            "users": {"u1": {"photoURL": URL.format("t-imawa/profiles/live")}},
            "mediaCleanupQueue": {"d1": {"publicId": "t-imawa/profiles/old",
                                         "status": "pending", "attempts": 0}},
        })
        req = FakeRequests()
        done, failed = quiet(cc.drain_queue, db, "k", "s", args(scan_limit=1))
        self.assertEqual((done, failed), (1, 0))
        self.assertEqual([p["data"]["public_id"] for p in req.posts],
                         ["t-imawa/profiles/old"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
