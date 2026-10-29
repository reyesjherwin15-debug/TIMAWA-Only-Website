/* ============================================================================
   TIMAWA — PWA + push runtime (shared by every page)
   ----------------------------------------------------------------------------
   Drop-in: registers the service worker, adds the "install app" banner, and
   wires the notification card in profile.html (#pwaNotifToggle and friends).

   Public API:
     window.TIMAWA_PWA.enablePush()   -> { ok, reason }
     window.TIMAWA_PWA.disablePush()  -> { ok, reason }
     window.TIMAWA_PWA.pushState()    -> 'needs-install' | 'unsupported' |
                                        'unconfigured' | 'signed-out' |
                                        'denied' | 'enabled' | 'off'
     window.TIMAWA_PWA.promptInstall()
     window.TIMAWA_PWA.testNotification()

   iOS notes (Safari/WebKit):
   • Web Push exists only inside a web app added to the Home Screen (iOS 16.4+).
     In a normal Safari tab `window.Notification` is not even defined, so the
     runtime reports 'needs-install' instead of "unsupported"/"blocked".
   • The install prompt never fires on iOS; the banner and the profile card show
     the manual Share → Add to Home Screen instructions instead.
   • Safari does not reliably fire `pushsubscriptionchange`, so the subscription
     is re-saved on every launch and whenever the app returns from the background.
   ========================================================================== */

(function () {
    'use strict';

    const CONFIG = Object.assign({
        vapidPublicKey: '',
        collection: 'pushSubscriptions',
        defaultUrl: 'calendar.html',
        installDismissKey: 'timawa.pwa.installDismissedAt',
        optOutKey: 'timawa.push.optOut'
    }, window.TIMAWA_PUSH || {});

    const SW_URL = 'sw.js';
    const SCOPED = new URL('./', window.location.href).href;

    function detectStandalone() {
        try {
            if (window.matchMedia &&
                (window.matchMedia('(display-mode: standalone)').matches ||
                 window.matchMedia('(display-mode: fullscreen)').matches)) {
                return true;
            }
        } catch (_) { /* very old browser */ }
        // iOS Safari's own flag — the reliable signal before iOS 16.4.
        return window.navigator.standalone === true;
    }

    const IS_STANDALONE = detectStandalone();
    // iPadOS 13+ reports a desktop (Macintosh) user agent, so the touch count
    // has to be part of the check or iPads would be treated as desktops.
    const IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
    // iOS Safari hides the Notification/PushManager APIs in a normal tab; they
    // only appear once the site runs as a home-screen web app.
    const IS_IOS_TAB = IS_IOS && !IS_STANDALONE;

    let registration = null;
    let installPromptEvent = null;
    let bannerTimer = null;

    /* ------------------------------------------------------------------ */
    /* Small helpers                                                       */
    /* ------------------------------------------------------------------ */

    const state = {
        ready: false,
        registration: null,
        lastError: ''
    };

    function log(...args) {
        // Quiet in production, still visible for debugging.
        if (window.console && console.info) console.info('[TIMAWA PWA]', ...args);
    }

    function warn(...args) {
        if (window.console && console.warn) console.warn('[TIMAWA PWA]', ...args);
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') {
            try { window.showToast(message, type || 'info'); return; } catch (_) { /* ignore */ }
        }
        log(message);
    }

    function renderChoice(title, message, choices) {
        const old = document.getElementById('timawaModeChoice');
        if (old) old.remove();
        const overlay = document.createElement('div');
        overlay.id = 'timawaModeChoice';
        overlay.className = 'pwa-mode-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'timawaModeTitle');
        const card = document.createElement('section');
        card.className = 'pwa-mode-card';
        const heading = document.createElement('h2'); heading.id = 'timawaModeTitle'; heading.textContent = title;
        const copy = document.createElement('p'); copy.textContent = message;
        const actions = document.createElement('div'); actions.className = 'pwa-mode-actions';
        choices.forEach(choice => {
            const button = document.createElement('button');
            button.type = 'button'; button.className = choice.secondary ? 'secondary' : '';
            button.textContent = choice.label;
            button.addEventListener('click', () => { overlay.remove(); choice.run(); });
            actions.appendChild(button);
        });
        card.append(heading, copy, actions); overlay.appendChild(card); document.body.appendChild(overlay);
        const first = actions.querySelector('button'); if (first) first.focus({ preventScroll: true });
        return overlay;
    }

    /* ------------------------------------------------------------------ */
    /* Reachability                                                        */
    /* ------------------------------------------------------------------ */

    /* navigator.onLine only reports whether a network interface is up. A phone
       on Wi-Fi with no internet, a captive portal, or a dead mobile-data session
       all still report true — which is exactly why the offline card never showed
       and the loading screen sat there. So ask the server for a tiny file the
       service worker never intercepts (manifest.json is skipped in sw.js). */
    const netState = { online: navigator.onLine !== false, checkedAt: 0, pending: null };

    function probeNetwork(timeoutMs) {
        if (netState.pending) return netState.pending;
        const ms = timeoutMs || 2500;
        netState.pending = new Promise((resolve) => {
            let settled = false;
            let timer = null;
            let abortTimer = null;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (abortTimer) clearTimeout(abortTimer);
                netState.online = ok;
                netState.checkedAt = Date.now();
                netState.pending = null;
                resolve(ok);
            };
            timer = setTimeout(() => finish(false), ms);
            let signal;
            if (typeof AbortController === 'function') {
                const ctrl = new AbortController();
                signal = ctrl.signal;
                abortTimer = setTimeout(() => { try { ctrl.abort(); } catch (_) { /* ignore */ } }, ms);
            }
            fetch('manifest.json?netcheck=' + Date.now(), { cache: 'no-store', signal })
                .then((res) => finish(!!res && res.ok))
                .catch(() => finish(false));
        });
        return netState.pending;
    }

    function isOffline() {
        return netState.online === false;
    }

    async function showOfflineChoice(options) {
        options = options || {};
        let offline = options.assumeOffline === true;
        if (!offline) {
            const reachable = navigator.onLine === false ? false : await probeNetwork();
            offline = !reachable;
        }
        if (!offline) {
            if (typeof options.onContinue === 'function') options.onContinue();
            return false;
        }
        renderChoice('No internet connection', 'Would you like to continue offline? Previously visited pages and Firestore data may be available from this device’s cache.', [
            { label: 'Continue offline', run: () => { try { sessionStorage.setItem('timawa.offline-mode', '1'); sessionStorage.removeItem('timawa.offline-choice-dismissed'); } catch (_) {} if (options.onContinue) options.onContinue(); } },
            { label: 'Wait for connection', secondary: true, run: () => { try { sessionStorage.setItem('timawa.offline-choice-dismissed', '1'); } catch (_) {} if (options.onContinue) options.onContinue(); } }
        ]);
        return true;
    }

    function showConnectionChoice() {
        try { if (sessionStorage.getItem('timawa.online-choice-dismissed') === '1') return false; } catch (_) { /* storage unavailable */ }
        const wasOffline = (() => { try { return sessionStorage.getItem('timawa.offline-mode') === '1'; } catch (_) { return false; } })();
        if (!wasOffline) return false;
        renderChoice('Connection restored', 'TIMAWA is back online. Switch to online mode and refresh your saved activity now?', [
            { label: 'Switch to online', run: () => { try { sessionStorage.removeItem('timawa.offline-mode'); sessionStorage.removeItem('timawa.online-choice-dismissed'); } catch (_) {} location.reload(); } },
            { label: 'Stay here', secondary: true, run: () => { try { sessionStorage.setItem('timawa.online-choice-dismissed', '1'); } catch (_) {} } }
        ]);
        return true;
    }

    const PUSH_NUDGE_KEY = 'timawa.push.nudge-dismissed-at';

    /* The one prompt a member sees when they open the app.
       Deliberately answers three different situations, because "nothing pops"
       usually means one of them was silently skipped before:
         • iPhone in a Safari tab  → there is no Notification API at all, so the
           only useful ask is "add it to your Home Screen".
         • permission blocked      → tell them where the switch lives instead of
           staying quiet forever.
         • permission untouched    → ask, once per session, snoozed 14 days if
           they decline.
       Pass force=true to show it outside that schedule (profile / debug). */
    function maybeShowPushNudge(user, force) {
        if (!configured()) return false;
        if (!force && !user) return false;
        const card = document.getElementById('pwaNotifToggle');
        if (card && !force) return false; // Profile has a persistent, non-modal opt-in card.

        let dismissedAt = 0;
        try { dismissedAt = Number(localStorage.getItem(PUSH_NUDGE_KEY) || 0); } catch (_) {}
        if (!force) {
            if (dismissedAt && Date.now() - dismissedAt < 14 * 86400000) return false;
            let shown = '';
            try { shown = sessionStorage.getItem('timawa.push.nudge-shown') || ''; } catch (_) {}
            if (shown === '1') return false;
        }
        const snooze = () => { try { localStorage.setItem(PUSH_NUDGE_KEY, String(Date.now())); } catch (_) { /* ignore */ } };

        if (IS_IOS_TAB) {
            try { sessionStorage.setItem('timawa.push.nudge-shown', '1'); } catch (_) { /* ignore */ }
            renderChoice('Get TIMAWA notifications', 'On iPhone, notifications only work from the installed app. Tap the Share button → “Add to Home Screen”, then open TIMAWA from its new icon and allow notifications when asked.', [
                { label: 'Got it', run: snooze },
                { label: 'Remind me later', secondary: true, run: snooze }
            ]);
            return true;
        }
        if (!pushSupported()) return false;

        const permission = Notification.permission;
        if (permission === 'granted') {
            // Already allowed: make sure this device really is subscribed so a
            // granted-but-silent device fixes itself without asking again.
            syncSilently(true);
            return false;
        }

        try { sessionStorage.setItem('timawa.push.nudge-shown', '1'); } catch (_) { /* ignore */ }

        if (permission === 'denied') {
            renderChoice('Notifications are blocked', 'TIMAWA cannot alert you about messages, mentions or reactions because notifications are blocked for this site. You can re-enable them in your browser or phone settings.', [
                { label: 'Got it', run: snooze },
                { label: 'How to fix it', secondary: true, run: () => { try { location.assign('profile.html#notifications'); } catch (_) { /* ignore */ } } }
            ]);
            return true;
        }

        renderChoice('Stay in the loop', 'Allow TIMAWA notifications to receive member messages, mentions, reactions and other activity alerts. You can change this later in your profile.', [
            { label: 'Enable notifications', run: () => enablePush() },
            { label: 'Not now', secondary: true, run: snooze }
        ]);
        return true;
    }

    function markPushNudgeDismissed() {
        try { localStorage.setItem(PUSH_NUDGE_KEY, String(Date.now())); } catch (_) {}
    }

    function currentUser() {
        try {
            if (typeof auth !== 'undefined' && auth && auth.currentUser) return auth.currentUser;
        } catch (_) { /* auth not on this page yet */ }
        return null;
    }

    function firestoreHandle() {
        try {
            if (typeof db !== 'undefined' && db) return db;
        } catch (_) { /* not ready */ }
        return null;
    }

    function serverTimestamp() {
        try {
            if (typeof firebase !== 'undefined' && firebase.firestore &&
                firebase.firestore.FieldValue) {
                return firebase.firestore.FieldValue.serverTimestamp();
            }
        } catch (_) { /* ignore */ }
        return new Date();
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
        return out;
    }

    /* Safari (iOS and macOS) rejects a BufferSource that is a view into a
       larger buffer, and older WebKit only accepts ArrayBuffer. Hand over a
       clean, exactly-sized ArrayBuffer — Chrome and Firefox accept it too. */
    function applicationServerKeyBuffer() {
        const bytes = urlBase64ToUint8Array(CONFIG.vapidPublicKey);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    async function sha256Hex(value) {
        if (window.crypto && crypto.subtle && window.TextEncoder) {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
            return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
        // Very old browsers: still deterministic enough for a document id.
        let hash = 0;
        for (let i = 0; i < value.length; i += 1) {
            hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
        }
        return 'h' + Math.abs(hash).toString(16);
    }

    function secureContextOk() {
        return window.isSecureContext === true ||
            location.protocol === 'https:' ||
            ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    }

    /* ------------------------------------------------------------------ */
    /* Service worker                                                      */
    /* ------------------------------------------------------------------ */

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            warn('service workers are not supported here');
            return null;
        }
        if (!secureContextOk()) {
            log('service worker needs https (or localhost) — skipped on', location.protocol);
            return null;
        }
        try {
            const reg = await navigator.serviceWorker.register(SW_URL, { scope: './' });
            state.registration = reg;
            registration = reg;
            log('service worker registered', reg.scope);

            reg.addEventListener('updatefound', () => {
                const installing = reg.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                        log('new version ready');
                    }
                });
            });

            // Don't let a slow (or stuck) first install block the PWA cards:
            // iOS can take several seconds to activate the worker.
            await Promise.race([
                navigator.serviceWorker.ready,
                new Promise((resolve) => setTimeout(resolve, 4000))
            ]);
            return reg;
        } catch (err) {
            warn('service worker registration failed', err);
            return null;
        }
    }

    function listenForWorkerMessages() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type === 'PUSH_SUBSCRIPTION_CHANGED') {
                if (data.subscription) {
                    saveSubscription(data.subscription).catch((err) => warn('re-save failed', err));
                }
            }
            if (data.type === 'PUSH_NAVIGATED') {
                log('opened from notification:', data.url);
            }
            if (data.type === 'PUSH_OPEN_URL' && data.url) {
                // iOS WebKit cannot always run client.navigate() from the worker,
                // so the page finishes the deep link itself.
                try {
                    const target = new URL(data.url, location.href);
                    if (target.origin === location.origin && target.href !== location.href) {
                        location.assign(target.href);
                    }
                } catch (err) { warn('deep link failed', err); }
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Subscriptions <-> Firestore                                         */
    /* ------------------------------------------------------------------ */

    function configured() {
        return typeof CONFIG.vapidPublicKey === 'string' && CONFIG.vapidPublicKey.length > 30;
    }

    function pushSupported() {
        return 'serviceWorker' in navigator && 'PushManager' in window &&
            'Notification' in window;
    }

    async function getSubscription() {
        const reg = registration || (navigator.serviceWorker
            ? await navigator.serviceWorker.getRegistration(SCOPED)
            : null);
        if (!reg || !reg.pushManager) return null;
        try {
            return await reg.pushManager.getSubscription();
        } catch (err) {
            warn('getSubscription failed', err);
            return null;
        }
    }

    function subscriptionDocId(endpoint) {
        return sha256Hex(endpoint);
    }

    async function saveSubscription(subscription) {
        const store = firestoreHandle();
        const user = currentUser();
        if (!store || !user) {
            state.lastError = 'no-auth';
            return false;
        }
        if (!subscription || !subscription.endpoint) return false;

        const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
        const keys = json.keys || {};
        const docId = await subscriptionDocId(json.endpoint);

        const payload = {
            uid: user.uid,
            endpoint: json.endpoint,
            keys: { p256dh: keys.p256dh || '', auth: keys.auth || '' },
            ua: navigator.userAgent,
            platform: (navigator.userAgentData && navigator.userAgentData.platform) ||
                navigator.platform || '',
            language: navigator.language || '',
            timezone: (() => {
                try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
                catch (_) { return ''; }
            })(),
            enabled: true,
            updatedAt: serverTimestamp()
        };

        try {
            // No read-first check: a first-time subscription has no document yet,
            // and the security rule can only authorise a read once it exists.
            // `merge` keeps one row per device and works for create and update.
            const ref = store.collection(CONFIG.collection).doc(docId);
            await ref.set(payload, { merge: true });
            state.lastError = '';
            log('subscription saved', docId.slice(0, 12));
            return true;
        } catch (err) {
            state.lastError = String(err && err.code || err);
            warn('could not save subscription', err);
            return false;
        }
    }

    async function deleteSubscriptionDoc(subscription) {
        const store = firestoreHandle();
        if (!store || !subscription || !subscription.endpoint) return;
        try {
            const docId = await subscriptionDocId(subscription.endpoint);
            await store.collection(CONFIG.collection).doc(docId).delete();
            log('subscription removed');
        } catch (err) {
            warn('could not delete subscription', err);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Enable / disable                                                    */
    /* ------------------------------------------------------------------ */

    async function enablePush() {
        if (IS_IOS_TAB) {
            // There is no API to enable here — the member has to install first.
            showInstallBanner(true);
            toast('On iPhone, add TIMAWA to your Home Screen first — notifications only work from the installed app.', 'info');
            return { ok: false, reason: 'needs-install' };
        }
        if (!pushSupported()) {
            return { ok: false, reason: 'unsupported' };
        }
        if (!configured()) {
            toast('Push is not configured on this site yet.', 'warn');
            return { ok: false, reason: 'unconfigured' };
        }
        if (!currentUser()) {
            toast('Sign in first to turn on notifications.', 'warn');
            return { ok: false, reason: 'signed-out' };
        }

        try { localStorage.removeItem(CONFIG.optOutKey); } catch (_) { /* ignore */ }
        markPushNudgeDismissed();

        // Must be requested straight from the click, before any await.
        let permission = Notification.permission;
        if (permission === 'default') {
            permission = await Notification.requestPermission();
        }
        if (permission !== 'granted') {
            renderNotificationCard();
            toast(permission === 'denied'
                ? (IS_IOS
                    ? 'Notifications are turned off for TIMAWA. Open Settings → Notifications → TIMAWA and allow them.'
                    : 'Notifications are blocked for this site in your browser settings.')
                : 'Notifications were not allowed.', 'warn');
            return { ok: false, reason: permission };
        }

        const reg = registration || await registerServiceWorker();
        if (!reg || !reg.pushManager) {
            renderNotificationCard();
            return { ok: false, reason: 'no-worker' };
        }

        let subscription = await getSubscription();
        try {
            if (!subscription) {
                subscription = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: applicationServerKeyBuffer()
                });
            }
        } catch (err) {
            warn('subscribe failed', err);
            renderNotificationCard();
            const message = err && err.name === 'NotSupportedError' && IS_IOS
                ? 'Notifications on iPhone only work after TIMAWA is added to your Home Screen.'
                : 'Could not turn on notifications: ' + (err && err.message || err);
            toast(message, 'error');
            return { ok: false, reason: 'subscribe-failed' };
        }

        const saved = await saveSubscription(subscription);
        renderNotificationCard();
        if (!saved) {
            toast('Notifications are on for this device, but could not be saved to your account.', 'warn');
            return { ok: true, reason: 'unsaved' };
        }
        toast('Notifications are on — you will hear about new activities.', 'success');
        return { ok: true };
    }

    async function disablePush() {
        try { localStorage.setItem(CONFIG.optOutKey, '1'); } catch (_) { /* ignore */ }
        const subscription = await getSubscription();
        if (subscription) {
            await deleteSubscriptionDoc(subscription);
            try { await subscription.unsubscribe(); } catch (err) { warn('unsubscribe failed', err); }
        }
        renderNotificationCard();
        toast('Notifications are off for this device.', 'info');
        return { ok: true };
    }

    async function pushState() {
        // Checked before pushSupported(): on iPhone Safari has no push API in a
        // tab, and reporting that as "unsupported" would hide the real fix.
        if (IS_IOS_TAB) return 'needs-install';
        if (!pushSupported()) return 'unsupported';
        if (!configured()) return 'unconfigured';
        if (!currentUser()) return 'signed-out';
        if (Notification.permission === 'denied') return 'denied';
        if (Notification.permission === 'granted') {
            const sub = await getSubscription();
            return sub ? 'enabled' : 'off';
        }
        return 'off';
    }

    /* Keeps the stored subscription in sync without asking for permission again.
       This is what covers iOS: Safari does not reliably fire
       `pushsubscriptionchange`, so the endpoint is re-saved whenever the app is
       opened or resumed from the background. */
    let lastSyncAt = 0;
    const SYNC_INTERVAL_MS = 5 * 60 * 1000;

    async function syncSilently(force) {
        if (IS_IOS_TAB) return;                       // no push API in a Safari tab
        if (!pushSupported() || !configured() || !currentUser()) return;
        if (Notification.permission !== 'granted') return;
        let optedOut = false;
        try { optedOut = localStorage.getItem(CONFIG.optOutKey) === '1'; } catch (_) { /* ignore */ }
        if (optedOut) return;
        if (!force && Date.now() - lastSyncAt < SYNC_INTERVAL_MS) {
            // A missing subscription is always worth fixing, even inside the
            // throttle window — iOS can drop one while the app is suspended.
            const current = await getSubscription();
            if (current) return;
        }
        lastSyncAt = Date.now();

        const reg = registration || await registerServiceWorker();
        if (!reg || !reg.pushManager) return;

        let subscription = await getSubscription();
        if (!subscription) {
            try {
                subscription = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: applicationServerKeyBuffer()
                });
            } catch (err) {
                warn('silent re-subscribe failed', err);
                return;
            }
        }
        await saveSubscription(subscription);
    }

    /* ------------------------------------------------------------------ */
    /* Notification card (profile.html)                                    */
    /* ------------------------------------------------------------------ */        async function renderNotificationCard() {
        const button = document.getElementById('pwaNotifToggle');
        if (!button) return;

        const statusEl = document.getElementById('pwaNotifStatus');
        const dot = document.getElementById('pwaNotifDot');
        const hintEl = document.getElementById('pwaNotifHint');
        const labelEl = document.getElementById('pwaNotifLabel');

        const set = (text, hint, tone, action) => {
            if (statusEl) statusEl.textContent = text;
            if (hintEl) hintEl.innerHTML = hint;
            if (labelEl) labelEl.textContent = action.label;
            if (dot) {
                dot.dataset.tone = tone;
            }
            button.disabled = !!action.disabled;
            button.dataset.mode = action.mode || 'toggle';
            const icon = button.querySelector('i');
            if (icon) icon.className = 'fas ' + (action.icon || 'fa-bell');
        };

        const current = await pushState();
        state.pushState = current;

        // Only offer the self-test once this device is actually subscribed — it
        // proves the phone half (permission + service worker) without a sender.
        const testBtn = document.getElementById('pwaNotifTest');
        if (testBtn) testBtn.style.display = current === 'enabled' ? '' : 'none';

        if (current === 'needs-install') {
            // iPhone/iPad: push only exists inside the home-screen app, so the
            // action offers the install steps instead of a dead switch.
            set('Available in the installed app.',
                '<i class="fas fa-circle-info"></i> iPhone and iPad only deliver TIMAWA notifications when it is added to the Home Screen from <b>Safari</b>. Tap <b>How to install</b>.',
                'off', { label: 'How to install', icon: 'fa-mobile-screen-button', mode: 'install-help' });
            return;
        }
        if (current === 'unsupported') {
            set('Not supported in this browser.',
                IS_IOS
                    ? '<i class="fas fa-circle-info"></i> Notifications need iOS 16.4 or later, opened from the TIMAWA icon on your Home Screen.'
                    : '<i class="fas fa-circle-info"></i> This browser does not support web push. Try Chrome, Edge or Firefox.',
                'off', { label: 'Unavailable', icon: 'fa-ban', disabled: true, mode: 'none' });
            return;
        }
        if (current === 'unconfigured') {
            set('Setup needed.',
                '<i class="fas fa-circle-info"></i> Add your VAPID public key to <b>push-config.js</b> to turn this on.',
                'off', { label: 'Unavailable', icon: 'fa-wrench', disabled: true, mode: 'none' });
            return;
        }
        if (current === 'signed-out') {
            set('Sign in to enable.',
                '<i class="fas fa-circle-info"></i> Notifications follow your account, so sign in first.',
                'off', { label: 'Enable notifications', icon: 'fa-bell', disabled: true, mode: 'none' });
            return;
        }
        if (current === 'denied') {
            set(IS_IOS ? 'Turned off in iOS Settings.' : 'Blocked by the browser.',
                IS_IOS
                    ? '<i class="fas fa-circle-info"></i> Open <b>Settings → Notifications → TIMAWA</b>, allow notifications, then reopen the app.'
                    : '<i class="fas fa-circle-info"></i> Open your browser site settings for TIMAWA and allow notifications, then reload.',
                'off', { label: IS_IOS ? 'Off' : 'Blocked', icon: 'fa-bell-slash', disabled: true, mode: 'none' });
            return;
        }
        if (current === 'enabled') {
            set('On for this device.',
                '<i class="fas fa-circle-check"></i> You will get activity alerts even when TIMAWA is closed.',
                'on', { label: 'Turn off', icon: 'fa-bell-slash', mode: 'off' });
            return;
        }

        set('Off.', IS_IOS && !IS_STANDALONE
            ? '<i class="fas fa-circle-info"></i> On iPhone, add TIMAWA to your home screen, then enable notifications inside the installed app.'
            : '<i class="fas fa-circle-info"></i> Get pinged when the squad adds an activity — no need to keep the site open.',
        'off', { label: 'Enable notifications', icon: 'fa-bell', mode: 'on' });
    }

    function wireNotificationCard() {
        const button = document.getElementById('pwaNotifToggle');
        if (!button) return;

        button.addEventListener('click', async () => {
            if (button.dataset.mode === 'install-help') {
                showInstallBanner(true);
                toast('In Safari, tap Share, then “Add to Home Screen”.', 'info');
                return;
            }
            if (button.dataset.mode === 'on') {
                button.disabled = true;
                await enablePush();
                button.disabled = false;
                return;
            }
            if (button.dataset.mode === 'off') {
                button.disabled = true;
                await disablePush();
                button.disabled = false;
            }
        });

        const testBtn = document.getElementById('pwaNotifTest');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                testBtn.disabled = true;
                const shown = await testNotification();
                testBtn.disabled = false;
                toast(shown
                    ? 'Notification sent — check your notification shade.'
                    : 'The device did not confirm the notification. Check the app’s notification permission.',
                    shown ? 'success' : 'error');
            });
        }

        renderNotificationCard();
    }

    /* ------------------------------------------------------------------ */
    /* Install banner                                                      */
    /* ------------------------------------------------------------------ */

    function bannerDismissed() {
        let raw = null;
        try { raw = localStorage.getItem(CONFIG.installDismissKey); } catch (_) { /* ignore */ }
        if (!raw) return false;
        const dismissedAt = Number(raw);
        if (!dismissedAt) return false;
        const days = (Date.now() - dismissedAt) / 86400000;
        return days < 30;
    }

    /* The X only hides the banner for this page load — reloading brings it back,
       so an accidental tap is never permanent. Passing permanent=true writes the
       30-day opt-out, which we do only once the app has actually been installed. */
    function dismissBanner(node, permanent) {
        if (permanent) {
            try { localStorage.setItem(CONFIG.installDismissKey, String(Date.now())); } catch (_) { /* ignore */ }
        }
        if (node && node.parentNode) {
            node.dataset.hidden = 'true';
            setTimeout(() => node.remove(), 260);
        }
    }

    async function runInstallPrompt() {
        const evt = installPromptEvent;
        if (!evt) return false;
        installPromptEvent = null;
        try {
            evt.prompt();
            // Chrome resolves userChoice when the native dialog is answered, but
            // some browsers never resolve it (or resolve only on dismissal),
            // which would leave the button stuck. Race it against a timeout.
            const choice = await Promise.race([
                evt.userChoice,
                new Promise((resolve) => setTimeout(
                    () => resolve({ outcome: 'dismissed', reason: 'timeout' }), 12000))
            ]);
            return !!(choice && choice.outcome === 'accepted');
        } catch (err) {
            warn('install failed', err);
            return false;
        }
    }

    const INSTALL_COPY = 'Add it to your home screen — opens full screen, works offline.';
    const IOS_COPY = 'In Safari, tap Share → “Add to Home Screen”. Open TIMAWA from the new icon for notifications.';

    function buildBanner(text, actionLabel, onAction) {
        if (document.getElementById('pwaInstallBanner')) return null;
        const banner = document.createElement('div');
        banner.id = 'pwaInstallBanner';
        banner.className = 'pwa-banner';
        banner.innerHTML = [
            '<div class="pwa-banner__art"><img src="icons/icon-192.png?v=3" alt="" width="44" height="44" /></div>',
            '<div class="pwa-banner__copy">',
            '<strong>Install TIMAWA</strong>',
            '<span></span>',
            '</div>',
            '<button type="button" class="pwa-banner__action"></button>',
            '<button type="button" class="pwa-banner__close" aria-label="Dismiss">',
            '<i class="fas fa-xmark"></i>',
            '</button>'
        ].join('');
        banner.querySelector('.pwa-banner__copy span').textContent = text;
        const action = banner.querySelector('.pwa-banner__action');
        action.textContent = actionLabel;
        action.addEventListener('click', onAction);
        banner.querySelector('.pwa-banner__close').addEventListener('click', () => dismissBanner(banner, false));
        document.body.appendChild(banner);
        requestAnimationFrame(() => { banner.dataset.visible = 'true'; });
        return banner;
    }

    /* Bring the banner back on demand (also the public re-show helper).
       force=true ignores a dismissed banner — used by the "How to install"
       button, where the member is explicitly asking for the steps. */
    function showInstallBanner(force) {
        if (IS_STANDALONE) return false;
        if (!force && bannerDismissed()) return false;
        const existing = document.getElementById('pwaInstallBanner');
        if (existing) {
            if (!force) return true;   // already on screen
            existing.remove();         // restart the animation on a forced re-show
        }
        clearTimeout(bannerTimer);
        const node = buildBanner(IS_IOS ? IOS_COPY : INSTALL_COPY,
            IS_IOS || installPromptEvent ? (IS_IOS ? 'Got it' : 'Install') : 'Got it',
            async () => {
                const banner = document.getElementById('pwaInstallBanner');
                if (IS_IOS) { dismissBanner(banner, false); return; }
                const accepted = await runInstallPrompt();
                dismissBanner(banner, accepted);
            });
        if (node) log('install banner shown');
        return !!node;
    }

    function setupInstallBanner() {
        // Older builds wrote a 30-day "don't show again" flag when X was tapped,
        // which is why a refresh never brought the banner back. The X now only
        // hides it for this visit, so clear any leftover flag — unless the app
        // is already installed, where suppressing it still makes sense.
        if (!IS_STANDALONE) {
            try { localStorage.removeItem(CONFIG.installDismissKey); } catch (_) { /* ignore */ }
        }
        if (IS_STANDALONE || bannerDismissed()) return;

        window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            installPromptEvent = event;
            renderInstallCard();
            if (IS_STANDALONE || bannerDismissed()) return;
            clearTimeout(bannerTimer);
            bannerTimer = setTimeout(() => showInstallBanner(), 4000);
        });

        window.addEventListener('appinstalled', () => {
            installPromptEvent = null;
            dismissBanner(document.getElementById('pwaInstallBanner'), true);
            renderInstallCard();
        });

        // iOS never fires beforeinstallprompt — show the manual instructions once.
        if (IS_IOS) {
            bannerTimer = setTimeout(() => showInstallBanner(), 6000);
        }
    }

    async function promptInstall() {
        if (installPromptEvent) {
            installPromptEvent.prompt();
            try { await installPromptEvent.userChoice; } catch (_) { /* ignore */ }
            installPromptEvent = null;
            return true;
        }
        return false;
    }

    /* The address-bar colour is already owned by theme.js (it tracks the page
       background, including dark mode), so this file deliberately does not
       touch <meta name="theme-color"> — two writers would just fight. */

    /* ------------------------------------------------------------------ */
    /* Install card (profile.html, #pwaInstallBtn)                         */
    /* ------------------------------------------------------------------ */

    function installCardState() {
        if (IS_STANDALONE) return 'installed';
        if (IS_IOS) return 'ios';
        if (installPromptEvent) return 'ready';
        return 'hint';
    }

    function renderInstallCard() {
        const button = document.getElementById('pwaInstallBtn');
        if (!button) return;

        const statusEl = document.getElementById('pwaInstallStatus');
        const dot = document.getElementById('pwaInstallDot');
        const labelEl = document.getElementById('pwaInstallLabel');
        const hintEl = document.getElementById('pwaInstallHint');

        const paint = (status, tone, label, icon, mode) => {
            if (statusEl) statusEl.textContent = status;
            if (labelEl) labelEl.textContent = label;
            if (dot) dot.dataset.tone = tone;
            const iconEl = button.querySelector('i');
            if (iconEl) iconEl.className = 'fas ' + icon;
            button.dataset.mode = mode;
        };

        const state = installCardState();

        if (state === 'installed') {
            paint('Installed on this device.', 'on', 'Already installed', 'fa-circle-check', 'installed');
            button.disabled = true;
            if (hintEl) {
                hintEl.innerHTML =
                    '<i class="fas fa-circle-info"></i> Open it from your home screen for the fastest way in.';
            }
            return;
        }

        button.disabled = false;
        if (state === 'ios') {
            paint('Not installed yet.', 'off', 'How to install', 'fa-mobile-screen-button', 'ios');
            if (hintEl) {
                hintEl.innerHTML =
                    '<i class="fas fa-circle-info"></i> Open TIMAWA in <b>Safari</b>, tap <b>Share</b> → '
                    + '<b>Add to Home Screen</b>, then open it from the new icon. Notifications need iOS 16.4 or later.';
            }
        } else if (state === 'ready') {
            paint('Ready to install.', 'off', 'Install TIMAWA', 'fa-download', 'install');
            if (hintEl) {
                hintEl.innerHTML =
                    '<i class="fas fa-circle-info"></i> Your browser will ask you to confirm the install.';
            }
        } else {
            paint('Not installed yet.', 'off', 'Install TIMAWA', 'fa-download', 'install');
            if (hintEl) {
                hintEl.innerHTML =
                    '<i class="fas fa-circle-info"></i> If nothing happens on tap, open your browser menu → <b>Install app</b>.';
            }
        }
    }

    async function wireInstallCard() {
        const button = document.getElementById('pwaInstallBtn');
        if (!button) return;

        button.addEventListener('click', async () => {
            const mode = button.dataset.mode;
            if (mode === 'installed') return;

            if (mode === 'ios') {
                showInstallBanner(true);
                toast('In Safari, tap Share, then “Add to Home Screen”.', 'info');
                return;
            }

            button.disabled = true;
            const accepted = await runInstallPrompt();
            button.disabled = false;

            if (accepted || IS_STANDALONE) {
                renderInstallCard();
                return;
            }

            // No deferred prompt (yet, or blocked): fall back to instructions.
            showInstallBanner();
            toast('If nothing happened, open your browser menu → Install app.', 'info');
            renderInstallCard();
        });

        renderInstallCard();
    }

    /* Close OS notifications whose context matches a prefix. Used so that
       opening the screen a notification belongs to (chat, calendar, bell)
       resolves it — even when the member never tapped the notification.

       Contexts written by the sender:
         chat:<uid>   chat:<group>   event:<eventId>   ann:<type>

       Returns the number of notifications closed. */
    async function clearNotifications(contextPrefix) {
        if (!contextPrefix || !('serviceWorker' in navigator) || !('Notification' in window)) return 0;
        if (Notification.permission !== 'granted') return 0;
        try {
            const reg = registration || await navigator.serviceWorker.ready;
            // Safari only gained getNotifications() recently; never let its
            // absence break the page that is trying to resolve a notification.
            if (!reg || typeof reg.getNotifications !== 'function') return 0;
            const list = await reg.getNotifications();
            let closed = 0;
            list.forEach((notification) => {
                const data = notification.data || {};
                const context = data.context || '';
                if (context === contextPrefix || context.indexOf(contextPrefix) === 0) {
                    notification.close();
                    closed += 1;
                }
            });
            if (closed) log('cleared', closed, 'notification(s) for', contextPrefix);
            return closed;
        } catch (err) {
            warn('clearNotifications failed', err);
            return 0;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Debug helper                                                        */
    /* ------------------------------------------------------------------ */

    async function testNotification() {
        const reg = registration || await navigator.serviceWorker.ready;
        if (!reg || !reg.active) return false;
        return new Promise((resolve) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => resolve(false), 3000);
            channel.port1.onmessage = (event) => {
                clearTimeout(timer);
                if (!event.data || !event.data.ok) warn('test notification failed', event.data);
                resolve(!!(event.data && event.data.ok));
            };
            reg.active.postMessage({
                type: 'TEST_PUSH',
                payload: {
                    title: 'TIMAWA test notification',
                    body: 'If you can see this, push notifications are working on this device.',
                    url: CONFIG.defaultUrl
                }
            }, [channel.port2]);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Boot                                                                */
    /* ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ */
    /* Splash                                                              */
    /* ------------------------------------------------------------------ */

    /* Replaces the generic spinner in #loadingOverlay with the branded mark.
       The overlay keeps its id and its .active class, so every page's
       showLoadingOverlay()/hideLoadingOverlay() keeps working untouched — only
       its contents and its enter/leave motion are different. */
    function decorateSplash() {
        const overlay = document.getElementById('loadingOverlay');
        if (!overlay || overlay.dataset.timawaSplash === '1') return;
        overlay.dataset.timawaSplash = '1';
        const oldLabel = document.getElementById('loadingText');
        const labelText = (oldLabel && oldLabel.textContent) || 'Loading TIMAWA…';
        overlay.classList.add('t-splash');
        overlay.innerHTML =
            '<div class="t-splash-stage">' +
                '<div class="t-splash-mark" aria-hidden="true"><span class="t-splash-ring"></span><b>T</b></div>' +
                '<div class="t-splash-word" aria-hidden="true">TIMAWA</div>' +
                '<div class="t-splash-sub" aria-hidden="true">Squad Hub</div>' +
                '<div class="t-splash-bar" aria-hidden="true"><i></i></div>' +
                '<div class="loading-text" id="loadingText" role="status"></div>' +
            '</div>';
        const label = document.getElementById('loadingText');
        if (label) label.textContent = labelText;
    }

    async function boot() {
        decorateSplash();
        listenForWorkerMessages();
        setupInstallBanner();

        await registerServiceWorker();
        wireNotificationCard();
        wireInstallCard();

        // iOS suspends home-screen apps instead of closing them: permission can
        // change in Settings, and a subscription can be dropped while away.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            renderNotificationCard();
            renderInstallCard();
            syncSilently();
        });
        // Restored from the back/forward cache — same refresh, plus the banner
        // and cards may predate a change made in another tab.
        window.addEventListener('pageshow', (event) => {
            if (!event.persisted) return;
            renderNotificationCard();
            renderInstallCard();
            syncSilently();
        });
        window.addEventListener('online', () => {
            try { sessionStorage.removeItem('timawa.online-choice-dismissed'); } catch (_) {}
            showConnectionChoice();
        });

        try {
            if (typeof auth !== 'undefined' && auth && auth.onAuthStateChanged) {
                auth.onAuthStateChanged((user) => {
                    renderNotificationCard();
                    syncSilently();
                    // Let the splash finish first: the permission card should be
                    // the first thing a member sees, not a modal behind a loader.
                    setTimeout(() => maybeShowPushNudge(user), 1100);
                });
            }
        } catch (_) { /* page without auth */ }

        await syncSilently();
        state.ready = true;
        // Second chance for the prompt: covers a session restored before this
        // script attached its listener, and pages that sign in late.
        setTimeout(() => { try { maybeShowPushNudge(currentUser()); } catch (_) { /* ignore */ } }, 1500);
    }

    window.TIMAWA_PWA = {
        enablePush,
        disablePush,
        pushState,
        showOfflineChoice,
        showConnectionChoice,
        probeNetwork,
        isOffline,
        promptInstall,
        showInstallBanner,
        showNotificationNudge: maybeShowPushNudge,
        decorateSplash,
        clearNotifications,
        testNotification,
        syncSilently,
        refreshNotificationCard: renderNotificationCard,
        refreshInstallCard: renderInstallCard,
        get registration() { return registration; },
        /* iOS debug helpers — used by the docs' verification steps. */
        get isIOS() { return IS_IOS; },
        get isStandalone() { return IS_STANDALONE; }
    };

    // This script is deferred, so by the time it runs the overlay markup exists:
    // decorate it before the browser paints the generic spinner.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { decorateSplash(); boot(); });
    } else {
        decorateSplash();
        boot();
    }
})();
