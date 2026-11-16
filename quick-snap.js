/* ================================================================
   quick-snap.js — quick snaps on the dashboard.

   • a small leaning snippet sits left of Tita Tima and shows the newest snap
   • tapping it opens the squad's snaps, oldest first, 24 hours each
   • the collection icon shows your own snaps (kept 7 days in Firestore and
     Cloudinary), the camera icon shoots a new one
   • tap the middle of a snap you are making to add text; it sits in the
     curved box in the top-left of the photo
   ================================================================ */
(function () {
    'use strict';

    if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
    if (window.__quickSnapLoaded) return;
    window.__quickSnapLoaded = true;

    var CFG = {
        ttlMs: 7 * 24 * 60 * 60 * 1000,      // how long the doc and photo live
        visibleMs: 24 * 60 * 60 * 1000,      // how long it shows in the feed
        maxText: 140,
        cloud: 'ooq99nlw',
        preset: 't-imawa',
        folder: 't-imawa/quicksnaps',
        slideMs: 5000,
        feedLimit: 40,
        mineLimit: 60
    };

    var db = firebase.app().firestore();
    var me = null;
    var profile = { name: 'Member', photo: '' };
    var snaps = [];
    var index = 0;
    var mode = 'feed';
    var stream = null;
    var facing = 'user';
    var slideTimer = null;
    var pendingBlob = null;
    var pendingURL = null;
    var busy = false;

    /* ── the DOM ─────────────────────────────────────────────────── */

    var host = document.createElement('div');
    host.innerHTML = [
        '<button class="qs-fab" id="qsFab" type="button" aria-label="Open quick snaps">',
        '  <span class="qs-fab-img" id="qsFabImg"></span>',
        '  <span class="qs-fab-badge" id="qsFabBadge" hidden></span>',
        '</button>',
        '<div class="qs-view" id="qsView" hidden data-mode="feed" data-facing="user">',
        '  <div class="qs-stage">',
        '    <img class="qs-img" id="qsImg" alt="" hidden />',
        '    <video class="qs-video" id="qsVideo" playsinline muted autoplay hidden></video>',
        '    <div class="qs-mid" id="qsMid"></div>',
        '    <div class="qs-top">',
        '      <div class="qs-bars" id="qsBars"></div>',
        '      <div class="qs-head"><span class="qs-ava" id="qsAva"></span>',
        '        <span class="qs-who" id="qsWho"></span><span class="qs-time" id="qsTime"></span></div>',
        '    </div>',
        '    <div class="qs-text" id="qsText" hidden></div>',
        '    <textarea class="qs-input" id="qsInput" maxlength="140" placeholder="Add text…" hidden></textarea>',
        '    <div class="qs-tools">',
        '      <button class="qs-icon" id="qsCollection" type="button" aria-label="Your snaps"><i class="fas fa-table-cells-large"></i></button>',
        '      <button class="qs-icon" id="qsCamera" type="button" aria-label="Take a snap"><i class="fas fa-camera"></i></button>',
        '    </div>',
        '    <button class="qs-close" id="qsClose" type="button" aria-label="Close">✕</button>',
        '    <button class="qs-zone qs-prev" id="qsPrev" type="button" aria-label="Previous snap"></button>',
        '    <button class="qs-zone qs-next" id="qsNext" type="button" aria-label="Next snap"></button>',
        '    <p class="qs-hint" id="qsHint" hidden></p>',
        '    <div class="qs-cam" id="qsCam" hidden>',
        '      <button class="qs-round" id="qsFlip" type="button" aria-label="Flip camera"><i class="fas fa-rotate"></i></button>',
        '      <button class="qs-shutter" id="qsShutter" type="button" aria-label="Take the photo"></button>',
        '      <span class="qs-round" aria-hidden="true"></span>',
        '    </div>',
        '    <div class="qs-compose" id="qsCompose" hidden>',
        '      <button class="qs-btn qs-btn-ghost" id="qsRetake" type="button">Retake</button>',
        '      <button class="qs-btn qs-btn-post" id="qsPost" type="button">Post</button>',
        '    </div>',
        '    <p class="qs-empty" id="qsEmpty" hidden>No snaps in the last 24 hours.<br>Tap the camera to start.</p>',
        '    <p class="qs-msg" id="qsMsg" hidden></p>',
        '    <div class="qs-collection" id="qsCollectionSheet" hidden>',
        '      <div class="qs-col-head"><div><b>Your snaps</b><br><span>Kept 7 days</span></div>',
        '        <button class="qs-icon" id="qsColClose" type="button" aria-label="Close collection"><i class="fas fa-xmark"></i></button>',
        '      </div>',
        '      <div class="qs-col-grid" id="qsColGrid"></div>',
        '    </div>',
        '  </div>',
        '</div>'
    ].join('');
    document.body.appendChild(host);

    var $ = function (id) { return document.getElementById(id); };
    var fab = $('qsFab'), fabImg = $('qsFabImg'), fabBadge = $('qsFabBadge');
    var view = $('qsView'), img = $('qsImg'), video = $('qsVideo');
    var mid = $('qsMid'), textEl = $('qsText'), input = $('qsInput'), hint = $('qsHint');
    var bars = $('qsBars'), ava = $('qsAva'), who = $('qsWho'), timeEl = $('qsTime');
    var cam = $('qsCam'), compose = $('qsCompose'), empty = $('qsEmpty'), msgEl = $('qsMsg');
    var colSheet = $('qsCollectionSheet'), colGrid = $('qsColGrid');

    /* ── helpers ─────────────────────────────────────────────────── */

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function initials(name) {
        var p = String(name || 'M').trim().split(/\s+/);
        return ((p[0] || 'M')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
    }

    function ago(ms) {
        var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (s < 60) return 'now';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        return Math.floor(s / 3600) + 'h';
    }

    function sized(url, w) {
        if (!url || url.indexOf('/upload/') < 0) return url;
        return url.replace('/upload/', '/upload/w_' + w + ',c_limit,q_auto:good,f_auto/');
    }

    function toast(msg) {
        if (typeof window.showToast === 'function') { try { window.showToast(msg); return; } catch (e) {} }
    }

    function showMsg(text) {
        msgEl.textContent = text || '';
        msgEl.hidden = !text;
        if (text) setTimeout(function () { if (msgEl.textContent === text) msgEl.hidden = true; }, 3600);
    }

    function lock(on) {
        document.documentElement.style.overflow = on ? 'hidden' : '';
        document.body.classList.toggle('snap-open', on);
    }

    function stopStream() {
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
        if (video) video.srcObject = null;
    }

    function clearSlide() {
        if (slideTimer) { clearTimeout(slideTimer); slideTimer = null; }
    }

    function setMode(next) {
        mode = next;
        view.dataset.mode = next;
        var isCamera = next === 'camera';
        var isCompose = next === 'compose';
        video.hidden = !isCamera;
        img.hidden = isCamera;
        cam.hidden = !isCamera;
        compose.hidden = !isCompose;
        hint.hidden = !isCompose;
        mid.style.display = isCompose ? 'block' : 'none';
        if (!isCompose) { input.hidden = true; }
        if (isCamera) { hint.hidden = true; }
    }

    /* ── feed ────────────────────────────────────────────────────── */

    function mapDoc(d) {
        var v = d.data() || {};
        return {
            id: d.id,
            imageUrl: v.imageUrl || '',
            text: v.text || '',
            authorUid: v.authorUid || '',
            authorName: v.authorName || 'Member',
            authorPhoto: v.authorPhoto || '',
            createdAt: v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : 0,
            visibleUntil: v.visibleUntil && v.visibleUntil.toMillis ? v.visibleUntil.toMillis() : 0,
            expiresAt: v.expiresAt && v.expiresAt.toMillis ? v.expiresAt.toMillis() : 0
        };
    }

    function loadFeed() {
        return db.collection('quickSnaps').orderBy('createdAt', 'desc').limit(CFG.feedLimit).get()
            .then(function (q) {
                var now = Date.now();
                var list = q.docs.map(mapDoc).filter(function (s) {
                    return s.imageUrl && (!s.visibleUntil || s.visibleUntil > now);
                });
                list.sort(function (a, b) { return a.createdAt - b.createdAt; });   // oldest → newest
                snaps = list;
                return snaps;
            })
            .catch(function (err) {
                console.warn('[quick snap] feed', err && err.code, err && err.message);
                snaps = [];
                return snaps;
            });
    }

    function paintProgress() {
        bars.innerHTML = snaps.map(function () { return '<span class="qs-seg"><i></i></span>'; }).join('');
    }

    function markProgress() {
        var segs = bars.children;
        for (var i = 0; i < segs.length; i++) {
            var fill = segs[i].firstChild;
            if (!fill) continue;
            fill.style.transition = 'none';
            fill.style.width = i < index ? '100%' : '0%';
            if (i === index) {
                void fill.offsetWidth;
                fill.style.transition = 'width ' + CFG.slideMs + 'ms linear';
                fill.style.width = '100%';
            }
        }
    }

    function showSnap(i, restart) {
        if (!snaps.length) return;
        index = (i + snaps.length) % snaps.length;
        var s = snaps[index];

        setMode('feed');
        img.src = sized(s.imageUrl, 1000);
        img.hidden = false;
        textEl.textContent = s.text || '';
        textEl.hidden = !s.text;

        ava.innerHTML = s.authorPhoto
            ? '<img src="' + esc(s.authorPhoto) + '" alt="" referrerpolicy="no-referrer">'
            : esc(initials(s.authorName));
        who.textContent = s.authorName;
        timeEl.textContent = '· ' + ago(s.createdAt);

        empty.hidden = true;
        if (bars.children.length !== snaps.length) paintProgress();
        markProgress();

        // warm the next picture before it is needed
        if (snaps.length > 1) {
            var n = new Image();
            n.src = sized(snaps[(index + 1) % snaps.length].imageUrl, 1000);
        }

        clearSlide();
        if (restart !== false && mode === 'feed' && snaps.length > 1) {
            slideTimer = setTimeout(function () {
                if (index >= snaps.length - 1) { clearSlide(); return; }
                showSnap(index + 1);
            }, CFG.slideMs);
        }
    }

    function openViewer(startAt) {
        view.hidden = false;
        lock(true);
        setMode('feed');
        if (snaps.length) {
            showSnap(typeof startAt === 'number' ? startAt : 0);
        } else {
            img.hidden = true;
            empty.hidden = false;
            paintProgress();
        }
    }

    function closeViewer() {
        clearSlide();
        stopStream();
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;
        colSheet.hidden = true;
        view.hidden = true;
        lock(false);
        refreshFab();
    }

    /* ── the snippet on the dashboard ────────────────────────────── */

    function refreshFab() {
        if (!me) { fab.classList.remove('visible'); return; }
        fab.classList.add('visible');
        db.collection('quickSnaps').orderBy('createdAt', 'desc').limit(1).get().then(function (q) {
            if (q.empty) { paintFab(null); return; }
            var s = mapDoc(q.docs[0]);
            var live = s.imageUrl && (!s.visibleUntil || s.visibleUntil > Date.now());
            paintFab(live ? s : null);
        }).catch(function () { paintFab(null); });
    }

    function paintFab(snap) {
        fabImg.innerHTML = snap
            ? '<img class="qs-fab-img" src="' + esc(sized(snap.imageUrl, 200)) + '" alt="" referrerpolicy="no-referrer">'
            : '<span class="qs-fab-empty"><i class="fas fa-bolt"></i></span>';
        fabBadge.hidden = !snap;
    }

    /* ── camera + compose ───────────────────────────────────────── */

    function startCamera() {
        stopStream();
        setMode('camera');
        input.hidden = true;
        textEl.hidden = true;
        textEl.textContent = '';
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showMsg('This browser cannot open the camera.');
            return;
        }
        navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1600 } }
        }).then(function (s) {
            stream = s;
            view.dataset.facing = facing;
            video.srcObject = s;
            var p = video.play();
            if (p && p.catch) p.catch(function () {});
        }).catch(function (err) {
            console.warn('[quick snap] camera', err);
            showMsg('No camera access. Check the browser permission and try again.');
        });
    }

    function shoot() {
        if (!stream || !video.videoWidth) { showMsg('Hold on — the camera is still waking up.'); return; }
        var w = video.videoWidth, h = video.videoHeight;
        var scale = Math.min(1, 1400 / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        var ctx = c.getContext('2d');
        if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(video, 0, 0, c.width, c.height);
        c.toBlob(function (blob) {
            if (!blob) { showMsg('That snap did not save — try again.'); return; }
            pendingBlob = blob;
            pendingURL = URL.createObjectURL(blob);
            stopStream();
            setMode('compose');
            img.src = pendingURL;
            img.hidden = false;
            textEl.hidden = true;
            textEl.textContent = '';
            input.value = '';
            input.hidden = true;
            hint.textContent = 'Tap the middle to add text';
        }, 'image/jpeg', 0.9);
    }

    function uploadBlob(blob) {
        var fd = new FormData();
        fd.append('file', blob, 'snap.jpg');
        fd.append('upload_preset', CFG.preset);
        fd.append('folder', CFG.folder);
        return fetch('https://api.cloudinary.com/v1_1/' + CFG.cloud + '/image/upload', { method: 'POST', body: fd })
            .then(function (r) {
                return r.json().then(function (j) {
                    if (!r.ok) throw new Error((j.error && j.error.message) || 'Upload failed');
                    return { url: j.secure_url, publicId: j.public_id };
                });
            });
    }

    function post() {
        if (busy) return;
        if (!pendingBlob) { startCamera(); return; }
        if (!me) { showMsg('Sign in to post a snap.'); return; }

        busy = true;
        var btn = $('qsPost');
        btn.disabled = true;
        btn.textContent = 'Posting…';
        var caption = (input.value || '').trim().slice(0, CFG.maxText);

        uploadBlob(pendingBlob).then(function (media) {
            var now = new Date();
            return db.collection('quickSnaps').add({
                imageUrl: media.url,
                imagePublicId: media.publicId,
                text: caption,
                authorUid: me.uid,
                authorName: profile.name,
                authorPhoto: profile.photo,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                visibleUntil: firebase.firestore.Timestamp.fromDate(new Date(now.getTime() + CFG.visibleMs)),
                expiresAt: firebase.firestore.Timestamp.fromDate(new Date(now.getTime() + CFG.ttlMs))
            });
        }).then(function () {
            busy = false;
            btn.disabled = false;
            btn.textContent = 'Post';
            if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
            pendingBlob = null;
            toast('Snap posted — it shows for 24 hours.');
            return loadFeed().then(function () {
                openViewer(snaps.length ? snaps.length - 1 : 0);
                refreshFab();
            });
        }).catch(function (err) {
            busy = false;
            btn.disabled = false;
            btn.textContent = 'Post';
            console.warn('[quick snap] post', err);
            showMsg('That did not go through. Check your connection and try again.');
        });
    }

    /* ── the collection ─────────────────────────────────────────── */

    function openCollection() {
        clearSlide();
        colSheet.hidden = false;
        colGrid.innerHTML = '<p class="qs-col-empty">Loading your snaps…</p>';
        if (!me) return;
        db.collection('quickSnaps').where('authorUid', '==', me.uid).limit(CFG.mineLimit).get()
            .then(function (q) {
                var now = Date.now();
                var list = q.docs.map(mapDoc)
                    .filter(function (s) { return s.imageUrl && (!s.expiresAt || s.expiresAt > now); })
                    .sort(function (a, b) { return b.createdAt - a.createdAt; });
                if (!list.length) {
                    colGrid.innerHTML = '<p class="qs-col-empty">Your snaps live here for 7 days.<br>Take one with the camera.</p>';
                    return;
                }
                colGrid.innerHTML = list.map(function (s, i) {
                    return '<button class="qs-thumb" type="button" data-i="' + i + '">' +
                        '<img src="' + esc(sized(s.imageUrl, 300)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
                        '<span>' + ago(s.createdAt) + '</span></button>';
                }).join('');
                colGrid.dataset.list = '';
                colGrid._list = list;
            })
            .catch(function (err) {
                console.warn('[quick snap] collection', err && err.code, err && err.message);
                colGrid.innerHTML = '<p class="qs-col-empty">Could not load your snaps right now.</p>';
            });
    }

    function openCollectionSnap(i) {
        var list = colGrid._list || [];
        if (!list[i]) return;
        snaps = list.slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
        colSheet.hidden = true;
        var at = snaps.findIndex(function (s) { return s.id === list[i].id; });
        showSnap(at < 0 ? 0 : at);
    }

    /* ── wiring ──────────────────────────────────────────────────── */

    function boot(u) {
        me = u || null;
        if (!me) { fab.classList.remove('visible'); return; }
        fab.classList.add('visible');
        profile = { name: me.displayName || (me.email ? me.email.split('@')[0] : 'Member'), photo: me.photoURL || '' };
        db.collection('users').doc(me.uid).get().then(function (doc) {
            if (!doc.exists) return;
            var d = doc.data() || {};
            if (d.displayName) profile.name = d.displayName;
            if (d.photoURL) profile.photo = d.photoURL;
        }).catch(function () {});
        refreshFab();
    }

    firebase.auth().onAuthStateChanged(boot);

    fab.addEventListener('click', function () {
        if (!me) return;
        // load first so the viewer never flashes an older list
        loadFeed().then(function () {
            openViewer(0);                          // the list is ordered oldest → newest
            if (!snaps.length) { empty.hidden = false; img.hidden = true; paintProgress(); }
        });
    });

    $('qsClose').addEventListener('click', closeViewer);
    $('qsPrev').addEventListener('click', function () { clearSlide(); showSnap(index - 1); });
    $('qsNext').addEventListener('click', function () { clearSlide(); showSnap(index + 1); });
    $('qsCamera').addEventListener('click', startCamera);
    $('qsCollection').addEventListener('click', openCollection);
    $('qsColClose').addEventListener('click', function () { colSheet.hidden = true; });
    $('qsShutter').addEventListener('click', shoot);
    $('qsFlip').addEventListener('click', function () {
        facing = facing === 'user' ? 'environment' : 'user';
        startCamera();
    });
    $('qsRetake').addEventListener('click', startCamera);
    $('qsPost').addEventListener('click', post);

    mid.addEventListener('click', function () {
        if (mode !== 'compose') return;
        hint.hidden = true;
        textEl.hidden = false;
        textEl.textContent = input.value || '';
        input.hidden = false;
        input.focus();
    });

    input.addEventListener('input', function () {
        textEl.textContent = input.value;
        textEl.hidden = !input.value;
    });

    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); hint.hidden = true; }
    });

    input.addEventListener('blur', function () {
        if (!input.value) { textEl.hidden = true; hint.hidden = false; }
    });

    colGrid.addEventListener('click', function (ev) {
        var b = ev.target.closest('.qs-thumb');
        if (b) openCollectionSnap(Number(b.dataset.i));
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && !view.hidden) {
            if (!colSheet.hidden) { colSheet.hidden = true; return; }
            closeViewer();
        }
    });

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) clearSlide();
    });

    // Keep the snippet out from under Tita Tima's panel.
    var titaPanel = document.getElementById('titaPanel');
    if (titaPanel) {
        var syncTita = function () { document.body.classList.toggle('tita-open', titaPanel.classList.contains('open')); };
        new MutationObserver(syncTita).observe(titaPanel, { attributes: true, attributeFilter: ['class'] });
        syncTita();
    }
})();
