# Push sender (admin only)

Runs on your computer, not on the website. Full guide: `../PWA-PUSH-SETUP.md`.

## First time

```bash
python -m venv tools/.venv
tools/.venv/Scripts/python.exe -m pip install -r tools/requirements.txt
```

Save a Firebase service account key as `tools/service-account.json`
(Firebase console → Project settings → Service accounts → Generate new private key).

## Everyday

Live chat notifications (leave it running):

```bash
tools/.venv/Scripts/python.exe tools/push_dispatcher.py          # watches announcements
tools/.venv/Scripts/python.exe tools/push_dispatcher.py --once   # single pass
tools/.venv/Scripts/python.exe tools/push_dispatcher.py --dry-run
```

Activities (manual / scheduled):

```bash
# test
tools/.venv/Scripts/python.exe tools/send_activity_push.py --test

# one activity
tools/.venv/Scripts/python.exe tools/send_activity_push.py --event <eventId>

# reminders for what's coming up
tools/.venv/Scripts/python.exe tools/send_activity_push.py --upcoming 24

# free-form
tools/.venv/Scripts/python.exe tools/send_activity_push.py --title "Heads up" --body "Gala moved to 8 PM"
```

`python tools/generate_vapid_keys.py --force` rotates the VAPID pair (everyone
must re-enable notifications afterwards).

## iPhone / iPad

Apple only delivers these pushes to TIMAWA when it has been added to the Home
Screen (iOS 16.4+), and it rejects a VAPID `sub` whose mail domain does not exist
(`403 BadJwtToken`). The scripts therefore default `sub` to the deployed site URL.
If you prefer an inbox, set one once:

```bash
setx VAPID_SUBJECT "mailto:you@gmail.com"
```

or pass `--vapid-subject` to either script.

Files that must never be uploaded to the site: `.vapid-private.pem`,
`service-account.json`, `.venv/`.
