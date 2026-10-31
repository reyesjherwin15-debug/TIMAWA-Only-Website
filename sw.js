/* ============================================================================
   TIMAWA service worker
   ----------------------------------------------------------------------------
   • App shell caching so a member can open TIMAWA like a native app, and so a
     dropped connection shows the last page instead of the browser error page.
   • Web Push receiver: renders activity notifications while the site is closed
     and routes a tap to the right page.
   Bump CACHE_VERSION whenever the shell files change.
   ========================================================================== */

const CACHE_VERSION = 'v1.5.32';
const SHELL_CACHE = `timawa-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `timawa-runtime-${CACHE_VERSION}`;
const MAX_RUNTIME_ENTRIES = 60;

/* Small, always-needed files. Pages are cached on first visit instead of being
   precached, so installing the app does not download ~2 MB of HTML.

   The one exception is Spin & Poll: it is the page members need when there is
   no signal at all (an outing with no data), so it — and the two local files it
   cannot render without — are precached. Firebase and Font Awesome come from
   CDNs whose URLs every other page already loads into the browser cache. */
const SHELL_ASSETS = [
    './offline.html',
    './pwa.css',
    './launch.css',
    './pwa.js',
    './push-config.js',
    './presence.css',
    './presence.js',
    './squad-wheel.html',
    './theme.css',
    './theme.js',
    './mobile-nav.css',
    './mobile-nav.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/badge-72.png',
    './icons/apple-touch-icon-180.png',
    './icons/favicon-32.png',
    './icons/notif-default.png',
    './icons/notif-mention.png',
    './icons/notif-reaction.png',
    './icons/notif-chat.png',
    './icons/notif-birthday.png',
    './icons/notif-highlight.png',
    './icons/notif-story.png',
    './icons/notif-event.png',
    './icons/notif-member.png',
    './icons/notif-admin.png',
    './icons/notif-note.png',
    './icons/notif-reply.png'
];

/* -------------------------------------------------------------------------- */
/* Install / activate                                                          */
/* -------------------------------------------------------------------------- */

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // Individual failures must not abort the whole install.
        await Promise.all(SHELL_ASSETS.map(async (url) => {
            try {
                await cache.add(new Request(url, { cache: 'reload' }));
            } catch (err) {
                console.warn('[sw] could not precache', url, err);
            }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
        const names = await caches.keys();
        await Promise.all(names.map((name) => {
            if (name.startsWith('timawa-') && !keep.has(name)) return caches.delete(name);
            return Promise.resolve();
        }));
        if (self.registration.navigationPreload) {
            // Network-first navigation below, so preload would just double fetch.
            try { await self.registration.navigationPreload.disable(); } catch (_) { /* ignore */ }
        }
        await self.clients.claim();
    })());
});

/* -------------------------------------------------------------------------- */
/* Fetch                                                                       */
/* -------------------------------------------------------------------------- */

function isCacheableAsset(pathname) {
    return /\.(?:css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf)$/i.test(pathname);
}

async function trimRuntimeCache() {
    const cache = await caches.open(RUNTIME_CACHE);
    const keys = await cache.keys();
    if (keys.length <= MAX_RUNTIME_ENTRIES) return;
    await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map((k) => cache.delete(k)));
}

async function networkFirstPage(request) {
    const cache = await caches.open(RUNTIME_CACHE);
    try {
        // GitHub Pages serves HTML with max-age=600, so a plain fetch() can hand
        // back the copy from ten minutes ago — a reload then keeps showing the
        // old page and a shipped fix looks like it never arrived. Revalidate.
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh && fresh.ok) {
            cache.put(request, fresh.clone()).then(trimRuntimeCache).catch(() => {});
        }
        return fresh;
    } catch (err) {
        const exact = await caches.match(request, { ignoreSearch: true });
        if (exact) return exact;

        // Same page, different query string (?v=..., deep links).
        const url = new URL(request.url);
        const keys = await cache.keys();
        const samePage = keys.find((k) => new URL(k.url).pathname === url.pathname);
        if (samePage) {
            const hit = await cache.match(samePage);
            if (hit) return hit;
        }

        const shell = await caches.match('./offline.html');
        if (shell) return shell;

        return new Response('You are offline and this page has not been saved yet.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
        if (response && response.ok) {
            cache.put(request, response.clone()).then(trimRuntimeCache).catch(() => {});
        }
        return response;
    }).catch(() => null);

    if (cached) return cached;

    // Network first, so a new ?v= URL always gets the bytes that match it.
    const fresh = await network;
    if (fresh) return fresh;

    // Offline: fall back to the precached shell. Those copies are stored without
    // their ?v= suffix, so pwa.css?v=1.3.0 or mobile-nav.js?v=1.3.0 would miss
    // them. The shell cache is rebuilt per CACHE_VERSION, and it is checked last
    // so it can never answer for a newer filename.
    const shellCache = await caches.open(SHELL_CACHE);
    const shell = await shellCache.match(request, { ignoreSearch: true });
    if (shell) return shell;

    return new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;         // Firebase, CDNs, fonts
    if (url.pathname.endsWith('/sw.js')) return;             // never cache the worker
    if (request.headers.has('range')) return;                // media / partial content
    if (url.pathname.endsWith('/manifest.json')) return;      // keep install metadata fresh
    if (url.pathname.endsWith('/app-version.json')) return;   // always the live build

    if (request.mode === 'navigate') {
        event.respondWith(networkFirstPage(request));
        return;
    }

    if (isCacheableAsset(url.pathname)) {
        event.respondWith(staleWhileRevalidate(request));
    }
});

/* -------------------------------------------------------------------------- */
/* Web Push                                                                    */
/* -------------------------------------------------------------------------- */

/* Safari/WebKit (iOS, iPadOS, macOS) ignores or rejects several notification
   options Android relies on, and Apple's push service caps the payload at 4 KB.
   Keep the shared payload intact and trim only at display time. */
const SW_UA = (self.navigator && self.navigator.userAgent) || '';
const IS_APPLE_WEBKIT = /iphone|ipad|ipod/i.test(SW_UA) ||
    (/macintosh/i.test(SW_UA) && /safari/i.test(SW_UA) &&
     !/chrome|chromium|edg|firefox/i.test(SW_UA));

function clamp(value, max) {
    const text = typeof value === 'string' ? value : '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function appBase() {
    // A project site lives under /<repo>/, not at the domain root. Resolving
    // against `location.origin` sent taps to https://<user>.github.io/calendar.html
    // — outside the app, which is why they landed on a 404 in the browser
    // instead of opening TIMAWA. The worker's scope is the app root.
    const scope = self.registration && self.registration.scope;
    return scope || self.location.href;
}

function normalizeTarget(raw) {
    const base = appBase();
    const fallback = new URL('dashboard.html', base).href;
    if (!raw) return fallback;
    try {
        const url = new URL(raw, base);
        if (url.origin !== self.location.origin) return fallback;
        return url.href;
    } catch (_) {
        return fallback;
    }
}

function normalizeAsset(raw, fallbackPath) {
    const base = appBase();
    const fallback = new URL(fallbackPath || 'icons/notif-default.png', base).href;
    if (!raw || typeof raw !== 'string') return fallback;
    try {
        const url = new URL(raw, base);
        return /^https?:$/.test(url.protocol) ? url.href : fallback;
    } catch (_) {
        return fallback;
    }
}

// Category art for alerts that are not about one person. Kept in the worker as
// a last-resort map so older queued payloads get the modern card too.
const NOTIF_ASSETS = {
    mention: 'icons/notif-mention.png',
    reaction: 'icons/notif-reaction.png',
    chat: 'icons/notif-chat.png',
    comment: 'icons/notif-chat.png',
    birthday: 'icons/notif-birthday.png',
    highlight: 'icons/notif-highlight.png',
    story: 'icons/notif-story.png',
    event: 'icons/notif-event.png',
    member: 'icons/notif-member.png',
    admin: 'icons/notif-admin.png',
    squad: 'icons/notif-admin.png',
    note: 'icons/notif-note.png',
    reply: 'icons/notif-reply.png'
};
const IMAGE_PATH_RE = /^https?:\/\/|^(\.\/)?[\w./-]+\.(png|jpe?g|webp|gif|avif)(\?.*)?$/i;

const NOTIF_AVATAR_TYPES = new Set(['mention', 'reaction', 'chat', 'comment', 'birthday']);

function notificationIcon(data) {
    const kind = data && data.type;
    // A person-driven alert prefers the face even if an older payload also
    // carried a category badge.
    const candidates = NOTIF_AVATAR_TYPES.has(kind)
        ? [data && data.actorPhoto, data && data.icon]
        : [data && data.icon, data && data.actorPhoto];
    const candidate = candidates.find(value => typeof value === 'string' && IMAGE_PATH_RE.test(value.trim()));
    if (candidate) {
        return normalizeAsset(candidate.trim(), NOTIF_ASSETS[kind] || 'icons/notif-default.png');
    }
    return normalizeAsset(NOTIF_ASSETS[kind] || 'icons/notif-default.png', 'icons/notif-default.png');
}

async function renderNotification(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const title = clamp(data.title || 'TIMAWA', 120);
    const kind = data.type || (data.meta && data.meta.type) || '';
    const options = {
        body: clamp(data.body || 'New activity from the squad.', 400),
        // A face for mentions, reactions, DMs and birthdays; a colour-coded
        // badge for every other kind. The dispatcher already chose this, but
        // resolving it here also fixes notifications sent before this deploy.
        icon: notificationIcon(data),
        tag: data.tag || `timawa-${Date.now()}`,
        lang: 'en',
        dir: 'auto',
        // `context` binds the notification to the screen that owns it
        // (chat:<uid>, event:<id>, ann:<type>) so the page can close it as
        // soon as the member arrives there, even without tapping.
        data: Object.assign({
            url: normalizeTarget(data.url),
            context: data.context || (data.meta && data.meta.context) || '',
            type: kind
        }, data.meta || {})
    };
    // Actions, vibrate, badge, image and timestamp are Android/Chrome extras.
    // Safari on iOS renders only title, body, tag, data and the app icon, so
    // passing them there is pointless at best.
    if (!IS_APPLE_WEBKIT) {
        // Threaded notifications: with a tag + renotify, Android alerts again
        // when a later message replaces the card instead of staying silent.
        options.renotify = true;
        options.badge = normalizeAsset(data.badge || 'icons/badge-72.png', 'icons/badge-72.png');
        options.timestamp = data.timestamp ? (Date.parse(data.timestamp) || Date.now()) : Date.now();
        options.vibrate = kind === 'birthday' ? [80, 60, 80, 60, 140] : [90, 50, 90];
        const primaryAction = kind === 'birthday' ? 'Greet'
            : kind === 'chat' ? 'Reply'
            : kind === 'mention' ? 'View'
            : kind === 'reaction' ? 'See it'
            : 'Open';
        options.actions = [
            { action: 'open', title: primaryAction },
            { action: 'close', title: 'Dismiss' }
        ];
        if (IMAGE_PATH_RE.test(String(data.image || '').trim())) {
            options.image = normalizeAsset(data.image, 'icons/icon-512.png');
        }
    }
    return self.registration.showNotification(title, options);
}

self.addEventListener('push', (event) => {
    event.waitUntil((async () => {
        let payload = {};
        if (event.data) {
            try {
                payload = event.data.json();
            } catch (_) {
                try { payload = { body: event.data.text() }; } catch (__) { payload = {}; }
            }
        }
        try {
            await renderNotification(payload);
        } catch (err) {
            // Permission can be revoked between subscription and delivery.
            console.warn('[sw] push could not be displayed', err);
        }
    })());
});

self.addEventListener('notificationclick', (event) => {
    const notification = event.notification;
    const action = event.action;
    notification.close();
    if (action === 'close') return;

    const target = normalizeTarget(notification.data && notification.data.url);

    event.waitUntil((async () => {
        let windows = [];
        try {
            windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        } catch (_) {
            // Older WebKit ignores (or rejects) the options object.
            windows = [];
        }
        const scopePath = new URL(appBase()).pathname;
        for (const client of windows) {
            const clientUrl = new URL(client.url);
            if (clientUrl.origin !== self.location.origin) continue;
            if (!clientUrl.pathname.startsWith(scopePath)) continue;

            // iOS standalone apps have exactly one window, and WebKit rejects
            // client.navigate() in some versions. Focus first, then try the
            // route change, and let the page finish it if the worker cannot.
            try { await client.focus(); } catch (_) { /* keep going */ }

            // Warm tap on the same page: ask the running app to switch screens
            // itself. Reloading here replayed the entire boot (members, chat
            // list, feature flag), which is why a chat tap used to land on the
            // dashboard and sit there.
            let handledInPlace = false;
            try {
                const clientUrl = new URL(client.url);
                const targetUrl = new URL(target);
                if (clientUrl.origin === targetUrl.origin &&
                    clientUrl.pathname === targetUrl.pathname) {
                    const channel = new MessageChannel();
                    const ack = new Promise((resolve) => {
                        const timer = setTimeout(() => resolve(false), 600);
                        channel.port1.onmessage = (e) => {
                            clearTimeout(timer);
                            resolve(!!(e.data && e.data.handled));
                        };
                    });
                    client.postMessage({ type: 'PUSH_OPEN_URL', url: target, probe: true }, [channel.port2]);
                    handledInPlace = await ack;
                }
            } catch (_) { handledInPlace = false; }
            if (handledInPlace) return;

            let navigated = false;
            if ('navigate' in client) {
                try {
                    await client.navigate(target);
                    navigated = true;
                } catch (_) { navigated = false; }
            }
            try {
                client.postMessage({ type: navigated ? 'PUSH_NAVIGATED' : 'PUSH_OPEN_URL', url: target });
            } catch (_) { /* window went away */ }
            return;
        }
        try {
            if (self.clients && typeof self.clients.openWindow === 'function') {
                await self.clients.openWindow(target);
            }
        } catch (err) {
            console.warn('[sw] could not open the notification target', err);
        }
    })());
});

/* A browser may rotate or drop a subscription (app updated, keys rotated). */
self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
        let subscription = event.newSubscription || null;
        if (!subscription && event.oldSubscription) {
            try {
                subscription = await self.registration.pushManager.subscribe(event.oldSubscription.options);
            } catch (_) { subscription = null; }
        }
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        windows.forEach((client) => {
            client.postMessage({
                type: 'PUSH_SUBSCRIPTION_CHANGED',
                subscription: subscription ? subscription.toJSON() : null
            });
        });
    })());
});

/* -------------------------------------------------------------------------- */
/* Messages from the page (debugging + update handshake)                       */
/* -------------------------------------------------------------------------- */

async function reply(port, message) {
    if (port) port.postMessage(message);
}

self.addEventListener('message', (event) => {
    const data = event.data || {};
    const port = event.ports && event.ports[0];

    if (data.type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }

    if (data.type === 'TEST_PUSH') {
        event.waitUntil((async () => {
            try {
                await renderNotification(data.payload || {});
                await reply(port, { ok: true });
            } catch (err) {
                await reply(port, { ok: false, error: String(err && err.message || err) });
            }
        })());
        return;
    }

    if (data.type === 'CACHE_STATUS') {
        event.waitUntil((async () => {
            const shell = await caches.open(SHELL_CACHE);
            const runtime = await caches.open(RUNTIME_CACHE);
            await reply(port, {
                version: CACHE_VERSION,
                shell: (await shell.keys()).length,
                runtime: (await runtime.keys()).length
            });
        })());
    }
});
