# Password reset with a code — setup

Members click **Forgot password?** on the sign-in screen, enter their email plus the
squad reset code, and then choose a new password. The old password is replaced
immediately and the member is signed in.

A browser cannot change another member's Firebase password, so the change is done by
a small Cloudflare Worker ([reset-worker.js](reset-worker.js)) that holds the
service account and calls the Firebase Admin API. The reset code is checked **only
in the Worker** — it is never in the page source.

```
login.html  ──POST { action:"verify" | "reset", email, code, password }──▶  Worker
                                                                             │
                                              Firebase Admin API  ◀──────────┘
```

---

## 1. Create the Worker (free plan)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Worker**.
2. Name it something like `timawa-reset`, **Deploy**.
3. **Edit code**, delete the starter, paste the whole of [reset-worker.js](reset-worker.js), **Deploy**.
4. Copy the URL: `https://timawa-reset.<your-subdomain>.workers.dev`.

## 2. Add its settings

Worker → **Settings → Variables and Secrets**:

| Name | Type | Value |
|---|---|---|
| `PROJECT_ID` | Text | `timawa2` |
| `ALLOWED_ORIGINS` | Text | `https://reyesjherwin15-debug.github.io` |
| `RESET_CODE` | **Secret** | the code members will type (e.g. `AWAMIT_RESET`) |
| `SERVICE_ACCOUNT_JSON` | **Secret** | the full contents of `tools/service-account.json` |

Notes

- `ALLOWED_ORIGINS` is a comma-separated list. To test from your computer add
  `,http://127.0.0.1:8787`.
- The service account needs the **Firebase Authentication Admin** role (the one in
  `tools/` already has it — it is the same account the push dispatcher uses).
- Change the code any time by editing `RESET_CODE`; no redeploy of the site needed.

## 3. Optional but recommended: rate limiting that survives restarts

Workers may recycle, so the built-in counter is best-effort. For a hard limit:

1. **Storage & Databases → KV → Create namespace** (`timawa_reset_limits`).
2. Worker → **Settings → Bindings → Add → KV namespace**, name it `RESET_KV`,
   pick the namespace.

Limits are already in the code: 12 attempts per hour per IP, 6 resets per hour per
account.

## 4. Point the site at the Worker

Open [reset-config.js](reset-config.js) and paste the URL:

```js
window.TIMAWA_RESET = {
    endpoint: 'https://timawa-reset.<your-subdomain>.workers.dev'
};
```

Until this is filled in, the dialog answers "Password reset is not set up yet" —
nothing breaks.

## 5. Upload

`login.html`, `reset-config.js`, `sw.js`, `app-version.json` (the Worker lives on
Cloudflare, not in the repo).

The service worker precaches `reset-config.js`, so bumping `CACHE_VERSION` in
[sw.js](sw.js) is what makes a changed endpoint reach phones. If you edit the
endpoint later, bump that version again.

## 6. Test

1. Open `login.html` → **Forgot password?**
2. Wrong code → *"That reset code is not correct."*
3. Right code → the new-password card appears with the email shown.
4. Save → the password is replaced, the member is signed in and lands on the
   dashboard (or the admin panel).

---

## What is protected, and what is not

- The reset code and the service account are **Worker secrets**. They are not in the
  repository, not in the page, and not in this document.
- The code is shared, so anyone who learns it can reset any member's password.
  Rotation = edit `RESET_CODE`. Per-IP and per-account limits blunt guessing and
  mass resets.
- The Worker refuses requests from origins not in `ALLOWED_ORIGINS`, and rejects a
  wrong code **before** it looks at the email, so it cannot be used to enumerate
  which addresses have accounts.
- The new password is validated server-side (minimum 6 characters, matching sign-up)
  and the client never stores it.

If the shared code ever leaks, change `RESET_CODE` immediately; no deploy of the
site is required.
