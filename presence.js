/* ================================================================
   presence.js · TIMAWA live member status
   ----------------------------------------------------------------
   Writes one small presence document per signed-in member and paints
   "Online / Away / Offline (last seen …)" wherever the page asks for it.

   Firestore:  presence/{uid}
     uid, name, photoURL, state ('online' | 'away'),
     lastActiveAt (server timestamp), updatedAt, clientAt, sessionId

   A member counts as ONLINE while their heartbeat is fresh and the tab
   is visible, AWAY when they are signed in but hidden/idle, and OFFLINE
   once the heartbeat goes stale (closed app, lost connection, …).

   Markup contract (any page, any component):
     data-presence-uid="<uid>"          the element is a status dot
     data-presence-uid + data-presence-dot
                                        JS appends/injects a dot into it
     data-presence-uid + data-presence-label
                                        the element receives the text label
     data-presence-uid + data-presence-manual="busy|dnd|available"
                                        a deliberate manual status wins
   ================================================================ */
(function () {
    'use strict';
    if (window.TimawaPresence) return;

    const HEARTBEAT_MS = 45000;
    const ONLINE_WINDOW_MS = 150000;   // 2.5 min without a beat = offline
    const AWAY_WINDOW_MS = 360000;     // 6 min since the last beat = offline
    const IDLE_MS = 5 * 60 * 1000;     // visible but untouched this long = away
    const CACHE_KEY = 'timawa_presence_v1';

    const state = {
        db: null,
        uid: '',
        name: '',
        photo: '',
        docs: new Map(),
        timer: null,
        ticker: null,
        lastWrite: 0,
        lastState: '',
        lastInteraction: Date.now(),
        started: false,
        booted: false,
        sessionId: Math.random().toString(36).slice(2) + Date.now().toString(36),
        unsub: null
    };
    const listeners = new Set();

    function now() { return Date.now(); }

    function readCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.docs && typeof parsed.docs === 'object') {
                Object.keys(parsed.docs).forEach(uid => state.docs.set(uid, parsed.docs[uid]));
            }
        } catch (e) { /* private mode */ }
    }

    function writeCache() {
        try {
            const docs = {};
            state.docs.forEach((v, k) => { docs[k] = v; });
            localStorage.setItem(CACHE_KEY, JSON.stringify({ t: now(), docs }));
        } catch (e) { /* private mode */ }
    }

    function ms(value) {
        if (!value) return 0;
        if (typeof value.toMillis === 'function') return value.toMillis();
        if (typeof value === 'number') return value;
        if (typeof value === 'string') { const t = Date.parse(value); return isNaN(t) ? 0 : t; }
        return 0;
    }

    function presenceAge(doc) {
        if (!doc) return Infinity;
        const server = ms(doc.lastActiveAt);
        const client = Number(doc.clientAt) || 0;
        const seen = Math.max(server, client);
        return seen ? Math.max(0, now() - seen) : Infinity;
    }

    function lastSeenText(age) {
        if (!isFinite(age) || age <= 0) return 'Offline';
        const mins = Math.floor(age / 60000);
        if (mins < 1) return 'Last seen just now';
        if (mins < 60) return `Last seen ${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `Last seen ${hrs}h ago`;
        return 'Last seen a while ago';
    }

    // Effective status: a deliberate Busy / DND survives; everything else
    // follows the live presence heartbeat.
    function statusFor(uid, manual) {
        const doc = uid ? state.docs.get(uid) : null;
        const age = presenceAge(doc);
        let base = 'offline';
        if (doc && navigator.onLine) {
            if (doc.state === 'online' && age < ONLINE_WINDOW_MS) base = 'available';
            else if (age < AWAY_WINDOW_MS) base = 'away';
        }
        if (manual === 'busy' || manual === 'dnd') base = manual;
        if (base === 'offline' && manual === 'away' && age < AWAY_WINDOW_MS) base = 'away';

        const labels = {
            available: 'Online',
            away: 'Away',
            busy: 'Busy',
            dnd: 'Do Not Disturb',
            offline: lastSeenText(age)
        };
        return {
            state: base === 'available' ? 'online' : base === 'away' ? 'away' : 'offline',
            cls: base,
            label: labels[base] || 'Offline',
            lastSeen: lastSeenText(age),
            age,
            online: base === 'available'
        };
    }

    function eventDetail(uid, manual) {
        return { uid: uid || '', status: statusFor(uid, manual) };
    }

    function emit() {
        listeners.forEach(fn => {
            try { fn(); } catch (e) { console.warn('presence listener:', e && e.message); }
        });
        decorate();
    }

    function manualFor(el) {
        return (el && el.getAttribute('data-presence-manual')) || '';
    }

    function paintDot(el, uid) {
        if (!el) return;
        const st = statusFor(uid, manualFor(el));
        el.classList.add('presence-dot');
        el.classList.remove('available', 'busy', 'away', 'dnd', 'offline', 'online');
        el.classList.add(st.cls);
        el.setAttribute('data-presence', st.state);
        el.setAttribute('title', st.label);
        el.setAttribute('aria-label', st.label);
        if (el.classList.contains('avatar-status') || el.classList.contains('status-dot')) {
            // these already have their own visual position
            el.hidden = false;
        }
    }

    function decorate(root) {
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('[data-presence-uid]').forEach(el => {
            const uid = el.getAttribute('data-presence-uid') || '';
            if (el.hasAttribute('data-presence-label')) {
                const st = statusFor(uid, manualFor(el));
                el.textContent = st.label;
                el.setAttribute('data-presence', st.state);
                el.setAttribute('title', st.label);
            }
            if (el.hasAttribute('data-presence-dot')) {
                let dot = el.querySelector(':scope > .presence-dot');
                if (!dot) {
                    dot = document.createElement('span');
                    dot.className = 'presence-dot';
                    dot.setAttribute('aria-hidden', 'true');
                    el.appendChild(dot);
                }
                paintDot(dot, uid);
            }
            if (el.classList.contains('presence-dot') || el.classList.contains('status-dot') || el.classList.contains('avatar-status')) {
                paintDot(el, uid);
            }
        });
    }

    function desiredState() {
        if (!navigator.onLine) return 'away';
        if (document.visibilityState && document.visibilityState !== 'visible') return 'away';
        if (now() - state.lastInteraction > IDLE_MS) return 'away';
        return 'online';
    }

    function heartbeat(force) {
        if (!state.uid || !state.db) return;
        const next = desiredState();
        if (!force && next === state.lastState && now() - state.lastWrite < HEARTBEAT_MS * 1.2) return;
        state.lastState = next;
        state.lastWrite = now();
        const payload = {
            uid: state.uid,
            name: state.name || '',
            photoURL: state.photo || '',
            state: next,
            clientAt: now(),
            sessionId: state.sessionId,
            lastActiveAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        // Keep the local map in step immediately (local writes resolve later).
        const local = Object.assign({}, payload, { lastActiveAt: now() });
        state.docs.set(state.uid, local);
        writeCache();
        state.db.collection('presence').doc(state.uid).set(payload, { merge: true })
            .catch(err => console.warn('presence write:', err && err.code));
    }

    function stop() {
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
        if (state.db && state.uid) {
            state.db.collection('presence').doc(state.uid).set({
                uid: state.uid, name: state.name || '', photoURL: state.photo || '',
                state: 'away', clientAt: now(), sessionId: state.sessionId,
                lastActiveAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(() => {});
        }
        state.uid = ''; state.lastState = ''; state.lastWrite = 0;
        emit();
    }

    function subscribe() {
        if (!state.db || !state.uid) return;
        if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
        state.unsub = state.db.collection('presence').limit(500).onSnapshot(snap => {
            snap.forEach(doc => {
                const d = doc.data() || {};
                state.docs.set(doc.id, Object.assign({ uid: doc.id }, d));
            });
            writeCache();
            emit();
        }, err => {
            console.warn('presence listener:', err && err.code);
        });
    }

    function start(user) {
        if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
        state.db = state.db || firebase.firestore();
        state.uid = user.uid;
        state.name = user.displayName || user.email || 'Member';
        state.photo = user.photoURL || '';
        state.lastInteraction = now();
        readCache();
        heartbeat(true);
        subscribe();
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(() => heartbeat(false), HEARTBEAT_MS);
        if (state.ticker) clearInterval(state.ticker);
        // Re-evaluate labels every 45 s so "Online" turns into "Away/Offline"
        // even when nothing new arrives from Firestore.
        state.ticker = setInterval(() => { emit(); }, 45000);
        try {
            state.db.collection('users').doc(user.uid).get().then(snap => {
                if (!snap.exists) return;
                const d = snap.data() || {};
                state.name = d.displayName || d.name || state.name;
                state.photo = d.photoURL || d.photo || state.photo;
                heartbeat(true);
            }).catch(() => {});
        } catch (e) { /* ignore */ }
    }

    function boot() {
        if (state.booted) return;
        state.booted = true;
        readCache();
        if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
        state.db = firebase.firestore();
        firebase.auth().onAuthStateChanged(user => {
            if (user) start(user); else stop();
        });
        ['pointerdown', 'keydown', 'touchstart', 'focus'].forEach(evt => {
            window.addEventListener(evt, () => {
                const wasIdle = now() - state.lastInteraction > IDLE_MS;
                state.lastInteraction = now();
                if (wasIdle && state.uid && desiredState() === 'online') heartbeat(true);
            }, { passive: true });
        });
        document.addEventListener('visibilitychange', () => {
            if (!state.uid) return;
            if (document.visibilityState === 'visible') {
                state.lastInteraction = now();
                heartbeat(true);
            } else {
                heartbeat(true);
            }
        });
        window.addEventListener('online', () => { if (state.uid) heartbeat(true); else emit(); });
        window.addEventListener('offline', emit);
        window.addEventListener('pagehide', () => {
            if (!state.uid || !state.db) return;
            try {
                state.db.collection('presence').doc(state.uid).set({
                    uid: state.uid, name: state.name || '', photoURL: state.photo || '',
                    state: 'away', clientAt: now(), sessionId: state.sessionId,
                    lastActiveAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } catch (e) { /* best effort */ }
        });
        // New cards, chat rows and modals are rendered constantly; decorate
        // them as they appear instead of asking every render path to call us.
        if ('MutationObserver' in window) {
            let scheduled = 0;
            const mo = new MutationObserver(() => {
                if (scheduled) return;
                scheduled = setTimeout(() => { scheduled = 0; decorate(); }, 80);
            });
            mo.observe(document.body, { childList: true, subtree: true });
        }
        decorate();
    }

    window.TimawaPresence = {
        init: boot,
        statusFor,
        labelFor: (uid, manual) => statusFor(uid, manual).label,
        stateFor: (uid, manual) => statusFor(uid, manual).state,
        isOnline: uid => statusFor(uid).online,
        decorate,
        refresh: () => decorate(),
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        // Pages that already know the user can avoid waiting for auth.
        identify(user) { if (user && user.uid) start(user); },
        heartbeat: () => heartbeat(true),
        version: '1.0.0'
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
