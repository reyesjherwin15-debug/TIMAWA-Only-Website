/* ============================================================================
   TIMAWA — password reset worker (Cloudflare Workers, free plan)

   Why this exists: a browser cannot change another member's Firebase password.
   Only privileged code can, so this Worker holds the service account, verifies
   the shared reset code, and calls the Identity Toolkit Admin API.

   Endpoint
     POST  { action: "verify", email, code }              -> { ok: true }
     POST  { action: "reset",  email, code, password }    -> { ok: true }

   Errors are JSON: { ok: false, error: "bad_code" | "no_account" |
                      "weak_password" | "rate_limited" | "not_configured" |
                      "invalid_email" | "server" }

   Environment
     PROJECT_ID            timawa2
     ALLOWED_ORIGINS       https://reyesjherwin15-debug.github.io
     RESET_CODE            the shared code members type (secret)
     SERVICE_ACCOUNT_JSON  contents of tools/service-account.json (secret)
     RESET_KV              optional KV namespace for rate limiting

   The code is only ever checked here, never shipped in the page, so the site's
   source does not reveal it.
   ========================================================================== */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase';
const MIN_PASSWORD = 6;
const WINDOW_SECONDS = 3600;
const MAX_PER_IP = 12;
const MAX_PER_EMAIL = 6;

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const allowed = (env.ALLOWED_ORIGINS || 'https://reyesjherwin15-debug.github.io')
            .split(',').map((s) => s.trim()).filter(Boolean);
        const originOk = allowed.includes(origin);
        const cors = {
            'Access-Control-Allow-Origin': originOk ? origin : allowed[0] || 'null',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
            Vary: 'Origin'
        };

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (!originOk) return json({ ok: false, error: 'origin' }, 403, cors);
        if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors);

        let body;
        try {
            const raw = await request.text();
            if (raw.length > 2048) return json({ ok: false, error: 'invalid' }, 400, cors);
            body = JSON.parse(raw || '{}');
        } catch (e) {
            return json({ ok: false, error: 'invalid' }, 400, cors);
        }

        const action = String(body.action || '');
        const email = String(body.email || '').trim().toLowerCase();
        const code = String(body.code || '').trim();
        const password = String(body.password || '');

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: false, error: 'invalid_email' }, 400, cors);

        // Everything below needs the admin credentials; say so plainly instead
        // of failing with a generic 500.
        if (!env.RESET_CODE || !env.SERVICE_ACCOUNT_JSON || !env.PROJECT_ID) {
            return json({ ok: false, error: 'not_configured' }, 503, cors);
        }

        // The code is checked before anything else, so a wrong code cannot be
        // used to discover which emails have accounts.
        if (!sameCode(code, env.RESET_CODE)) {
            await count(env, 'ip:' + clientIp(request), 1);
            return json({ ok: false, error: 'bad_code' }, 401, cors);
        }

        if (action !== 'verify' && action !== 'reset') return json({ ok: false, error: 'invalid' }, 400, cors);

        if (action === 'reset' && password.length < MIN_PASSWORD) {
            return json({ ok: false, error: 'weak_password' }, 400, cors);
        }

        const ipKey = 'ip:' + clientIp(request);
        const mailKey = 'mail:' + email;
        const ipHits = await readCount(env, ipKey);
        if (ipHits >= MAX_PER_IP) return json({ ok: false, error: 'rate_limited' }, 429, cors);
        if (action === 'reset' && (await readCount(env, mailKey)) >= MAX_PER_EMAIL) {
            return json({ ok: false, error: 'rate_limited' }, 429, cors);
        }

        try {
            const token = await getAccessToken(JSON.parse(env.SERVICE_ACCOUNT_JSON));
            const uid = await findUid(token, env.PROJECT_ID, email);
            if (!uid) return json({ ok: false, error: 'no_account' }, 404, cors);

            if (action === 'verify') {
                await count(env, ipKey, 1);
                return json({ ok: true }, 200, cors);
            }

            const res = await fetch(
                'https://identitytoolkit.googleapis.com/v1/projects/' + encodeURIComponent(env.PROJECT_ID) + '/accounts:update',
                {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ localId: uid, password })
                }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                console.log('accounts:update failed', res.status, JSON.stringify(data).slice(0, 300));
                return json({ ok: false, error: 'server' }, 502, cors);
            }

            await count(env, ipKey, 1);
            await count(env, mailKey, 1);
            return json({ ok: true }, 200, cors);
        } catch (err) {
            console.log('reset worker error', err && err.message);
            return json({ ok: false, error: 'server' }, 500, cors);
        }
    }
};

/* ------------------------------------------------------------------ helpers */

function json(payload, status, cors) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors)
    });
}

function clientIp(request) {
    return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

function sameCode(given, expected) {
    const a = String(given || '');
    const b = String(expected || '');
    if (!b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/* Rate limiting: KV when bound, otherwise a best-effort per-isolate counter
   (Workers may recycle an isolate, so the KV binding is the reliable one). */
const memory = new Map();

async function readCount(env, key) {
    if (env.RESET_KV) {
        const raw = await env.RESET_KV.get(key);
        return Number(raw || 0);
    }
    const hit = memory.get(key);
    if (!hit) return 0;
    if (hit.expires < Date.now()) { memory.delete(key); return 0; }
    return hit.value;
}

async function count(env, key, by) {
    if (env.RESET_KV) {
        const next = (await readCount(env, key)) + by;
        await env.RESET_KV.put(key, String(next), { expirationTtl: WINDOW_SECONDS });
        return next;
    }
    const hit = memory.get(key);
    if (!hit || hit.expires < Date.now()) {
        memory.set(key, { value: by, expires: Date.now() + WINDOW_SECONDS * 1000 });
        return by;
    }
    hit.value += by;
    return hit.value;
}

/* ------------------------------------------------- Firebase Admin (REST) */

async function getAccessToken(sa) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
        iss: sa.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600
    };
    const enc = new TextEncoder();
    const unsigned = b64url(enc.encode(JSON.stringify(header))) + '.' + b64url(enc.encode(JSON.stringify(claims)));
    const key = await crypto.subtle.importKey(
        'pkcs8',
        pemToBytes(sa.private_key),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
    const assertion = unsigned + '.' + b64url(new Uint8Array(signature));

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.access_token) throw new Error('token: ' + (data.error_description || data.error || res.status));
    return data.access_token;
}

async function findUid(token, projectId, email) {
    const res = await fetch(
        'https://identitytoolkit.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/accounts:lookup',
        {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: [email] })
        }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('lookup: ' + res.status);
    const user = data.users && data.users[0];
    return user ? user.localId : null;
}

function pemToBytes(pem) {
    const body = String(pem || '')
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '');
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function b64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
