# Cloudinary cleanup

Deleted highlights, removed photos and deleted stories now free their Cloudinary
storage automatically. No more opening the Cloudinary console to delete files by
hand.

## Why a workflow and not the page

The browser cannot delete Cloudinary assets:

| Attempt | Result |
|---|---|
| `POST /image/destroy` with `public_id` only (unsigned) | **401 `{"error":{"message":"Unknown API key"}}`** |
| `POST /image/upload` with `return_delete_token=true` | **400** "Return delete token parameter is not allowed when using unsigned upload" |
| `POST /delete_by_token` with a real token | works — but a token is only issued to *signed* uploads |

Every page on this site uploads with the unsigned `t-imawa` preset, so no page
can ever hold a delete token, and the destroy endpoint needs a signature made
with the API secret. Putting that secret in `admin.html` would let anyone who
opens the page delete or replace squad media.

So the app **queues** the public IDs, and a GitHub Actions job — where the
secret belongs — deletes them. This also fixes the old behaviour: `dashboard.html`
used to call `/image/destroy` unsigned, which always failed silently, so every
deleted highlight stayed in the account forever.

## What happens when content is deleted

| Action | Where | Queue document |
|---|---|---|
| Delete a highlight | `admin.html` (single, batch, "Delete Expired", auto-cleanup) | `source: 'highlight'` |
| Delete one photo from a highlight | `dashboard.html` gallery | `source: 'highlight'` |
| Delete a highlight from the app | `dashboard.html` | `source: 'highlight'` |
| Delete a story (admin) | `admin.html` moderation | `source: 'story'` |
| Admin sweep of expired stories | `admin.html` | `source: 'story'` |
| Delete your own story | `stories.js` | `source: 'story'` |
| Auto-delete your expired stories | `stories.js` | `source: 'story'` |
| Replace your profile photo | `profile.html` | `source: 'profile'` |
| Admin replaces/clears a member's photo | `admin.html` | `source: 'profile'` |
| Admin replaces their own photo | `admin_profile.html` | `source: 'profile'` |
| Delete a member (admin) | `admin.html` | `source: 'profile'` |

Each entry is one document in `mediaCleanupQueue`:

```json
{
  "publicId": "t-imawa/stories/abc123",
  "resourceType": "image",        // or "video"
  "source": "story",
  "sourceId": "storyDocId",
  "status": "pending",            // pending → deleted on success, or failed
  "attempts": 0,
  "requestedBy": "uid",
  "requestedAt": "<server timestamp>"
}
```

The document ID is the sanitised public ID, so deleting the same content twice
does not pile up duplicates.

## Setup (once)

1. **Cloudinary dashboard → Settings → API Keys.** Copy the API key and secret.
2. **GitHub → Settings → Secrets and variables → Actions → New repository
   secret**, twice:
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
3. Done. `SERVICE_ACCOUNT_JSON` is already set up for the push dispatcher and is
   reused here.

The workflow [`.github/workflows/cloudinary-cleanup.yml`](.github/workflows/cloudinary-cleanup.yml)
runs on two schedules and also has a **Run workflow** button:

| When | Mode | What it does |
|---|---|---|
| every hour (`:23`) | `queue` | removes expired documents, then deletes exactly what the app queued |
| daily, 03:47 UTC | `both` | the same, **plus** an orphan sweep |

Every run starts with the expired step (see below), whatever the mode.

### Expired content is removed, not just hidden

Expiry used to hide a story or highlight without removing anything: the
document stayed in Firestore with its `mediaUrl` intact. The orphan sweep then
counted that file as still in use and kept it — so an expired story could hold
its photo forever, invisible to everyone.

Every run now starts by deleting documents whose `expiresAt` has passed in
`stories`, `highlights` and `announcements` (plus a story's `reactions` and
`views` subcollections), and then deleting the media those documents were
holding. A file is still kept if anything else references it, so a story quoted
in a chat never loses its media. Turn the step off with `--no-purge-expired`.

### Why the daily sweep matters

The queue only knows about content that was deleted *through the app*. Anything
else stays in the account until something sweeps it:

* a profile photo that was **replaced** (the new URL is the only one any document
  references — the old file is simply unreferenced);
* a story that expired while nobody had the site open (the expired step removes
  its document and media; the sweep catches anything an older build left behind);
* uploads interrupted mid-way, and posts deleted from an older page version that
  did not know about the queue.

The sweep lists everything under `t-imawa/`, subtracts every id any document
still references (`highlights`, `stories`, `notes`, `announcements`, `events`,
`users`, `publicProfiles`, `coffeeShops`, `favoritePlaces`, `thingsToDo`,
`chatMessages`), and deletes what is left **only if** it is older than
`min_age_hours` (24 by default, so an in-flight upload is never touched). If any
of those collections cannot be read it refuses to delete anything at all — an
incomplete picture would look exactly like a pile of orphans.

| Input | Meaning |
|---|---|
| `mode` | `queue` (default) — only what the app queued; `orphans` — files no document references; `both` |
| `apply` | on = delete for real, off = dry run that only lists |
| `purge_expired` | on (default) = also remove expired stories/highlights/announcements and their media |
| `min_age_hours` | orphan files must be at least this old (default 24) — protects uploads whose document is still being written |

## The admin panel

Admin → **Stories** has a **Cloudinary storage** card:

- **N queued** — files waiting for the next run.
- **N files in use** — media the loaded highlights and stories still reference.
- **Queue expired stories** — sweeps expired/removed stories and queues their
  media immediately.
- A short list of the most recent queue entries, with status and attempt count.

Deleting a highlight or story in the panel now reports
"… N photos queued for Cloudinary cleanup" instead of silently leaking.

## Running it locally

```bash
tools/.venv/Scripts/python.exe tools/cloudinary_cleanup.py --mode queue
# --apply to actually delete; without a service account it only reports
```

```bash
python tools/cloudinary_cleanup.py --mode orphans --apply --min-age-hours 48
```

Safety rails:

- only IDs under `t-imawa/` are touched (`--prefix`, `--allow-outside-prefix` to
  override deliberately);
- at most `--max-delete` (300) per run;
- orphan sweep skips anything younger than `--min-age-hours`;
- failures are retried up to 5 times, then marked `failed` and left in the queue
  for inspection;
- the expired step only deletes documents already past `expiresAt`, and keeps
  any media another document still references.

## Tests

The worker has a test suite that needs no credentials, no network and no
Cloudinary account — Firestore and the Cloudinary HTTP calls are faked:

```bash
python -m unittest discover -s tools/tests -v
```

It covers the URL → public-id parsing, the request signature, every queue
outcome (deleted, already gone, auth rejected, retried then `failed`, wrong
folder, dry run), and the orphan sweep (replaced avatar deleted while the new
one is kept, fresh uploads protected by `min_age_hours`, referenced assets kept,
refuses to run on an incomplete scan, `max_delete` cap), and the expired step
(expired story and its media removed, active or expiry-less documents kept, dry
run touches nothing, referenced media kept, subcollections removed).

## Optional: tighter rules

Today `mediaCleanupQueue` is covered by the blanket "any signed-in member may
write" rule, which is enough for the app to queue deletions. If you want it
admin-only, add `mediaCleanupQueue` to the exclusions in the blanket rule and a
dedicated block, then `firebase deploy --only firestore:rules`. The cleanup job
uses the Admin SDK, so it is unaffected either way.
