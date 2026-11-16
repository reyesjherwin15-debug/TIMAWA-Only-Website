/* ================================================================
   quick-snap.js — quick snaps on the dashboard.

   • a small leaning snippet sits left of Tita Tima and previews the newest snap
   • tapping it opens a card (not a full-screen takeover) with the squad's
     snaps, oldest first, each one shown for 24 hours
   • the card's top-right corner holds the collection (your own snaps, kept
     7 days in Firestore and Cloudinary) and the camera
   • tap the middle of a snap you are making to add text; it sits in the
     curved box in the top-left of the photo
   ================================================================ */
(function () {
    'use strict';

    if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
    if (window.__quickSnapLoaded) return;
    window.__quickSnapLoaded = true;

    var CFG = {
        ttlMs: 7 * 24 * 60 * 60 * 1000,      // how long the doc and its photo live
        visibleMs: 24 * 60 * 60 * 1000,      // how long it shows in the feed
        maxText: 140,
        maxSide: 1400,                       // the long edge we upload, in pixels
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
        '  <div class="qs-stage" role="dialog" aria-modal="true" aria-label="Quick snaps">',
        '    <div class="qs-head">',
        '      <button class="qs-round qs-close" id="qsClose" type="button" aria-label="Close">✕</button>',
        '      <span class="qs-chip"><i class="qs-dot"></i>Squad</span>',
        '      <div class="qs-tools">',
        '        <button class="qs-round" id="qsCollection" type="button" aria-label="Your snaps"><i class="fas fa-table-cells-large"></i></button>',
        '        <button class="qs-round" id="qsCamera" type="button" aria-label="Take a snap"><i class="fas fa-camera"></i></button>',
        '      </div>',
        '    </div>',
        '    <div class="qs-bars" id="qsBars"></div>',
        '    <div class="qs-frame" id="qsFrame">',
        '      <img class="qs-img" id="qsImg" alt="" hidden />',
        '      <video class="qs-video" id="qsVideo" playsinline muted autoplay hidden></video>',
        '      <button class="qs-zone qs-prev" id="qsPrev" type="button" aria-label="Previous snap"></button>',
        '      <button class="qs-zone qs-next" id="qsNext" type="button" aria-label="Next snap"></button>',
        '      <div class="qs-mid" id="qsMid"></div>',
        '      <div class="qs-text" id="qsText" hidden></div>',
        '      <textarea class="qs-input" id="qsInput" maxlength="140" placeholder="Add text…" hidden></textarea>',
        '      <p class="qs-hint" id="qsHint" hidden></p>',
        '      <div class="qs-cam" id="qsCam" hidden>',
        '        <button class="qs-round" id="qsFlip" type="button" aria-label="Flip camera"><i class="fas fa-rotate"></i></button>',
        '        <button class="qs-shutter" id="qsShutter" type="button" aria-label="Take the photo"></button>',
        '        <span class="qs-round qs-spacer" aria-hidden="true"></span>',
        '      </div>',
        '      <div class="qs-empty" id="qsEmpty" hidden>',
        '        <span class="qs-empty-ico"><i class="fas fa-bolt"></i></span>',
        '        <b>No snaps yet today</b>',
        '        <p>Snaps stay for 24 hours. Shoot one and it lands here.</p>',
        '        <button class="qs-btn qs-btn-post" id="qsEmptyCam" type="button">Take a snap</button>',
        '      </div>',
        '      <p class="qs-msg" id="qsMsg" hidden></p>',
        '      <div class="qs-collection" id="qsCollectionSheet" hidden>',
        '        <div class="qs-col-head">',
        '          <div><b>Your snaps</b><span>Kept 7 days</span></div>',
        '          <button class="qs-round" id="qsColClose" type="button" aria-label="Close collection"><i class="fas fa-xmark"></i></button>',
        '        </div>',
        '        <div class="qs-col-grid" id="qsColGrid"></div>',
        '      </div>',
        '    </div>',
        '    <div class="qs-foot" id="qsFoot" hidden>',
        '      <span class="qs-ava" id="qsAva"></span>',
        '      <span class="qs-who-wrap"><b id="qsWho"></b><small id="qsTime"></small></span>',
        '    </div>',
        '    <div class="qs-compose" id="qsCompose" hidden>',
        '      <button class="qs-btn qs-btn-ghost" id="qsRetake" type="button">Retake</button>',
        '      <button class="qs-btn qs-btn-post" id="qsPost" type="button">Post</button>',
        '    </div>',
        '  </div>',
        '</div>'
    ].join('');
    document.body.appendChild(host);

    var $ = function (id) { return document.getElementById(id); };
    var fab = $('qsFab'), fabImg = $('qsFabImg'), fabBadge = $('qsFabBadge');
    var view = $('qsView'), img = $('qsImg'), video = $('qsVideo');
    var mid = $('qsMid'), textEl = $('qsText'), input = $('qsInput'), hint = $('qsHint');
    var bars = $('qsBars'), foot = $('qsFoot'), ava = $('qsAva'), who = $('qsWho'), timeEl = $('qsTime');
    var cam = $('qsCam'), compose = $('qsCompose'), empty = $('qsEmpty'), msgEl = $('qsMsg');
    var colSheet = $('qsCollectionSheet'), colGrid = $('qsColGrid');

    /* ── small helpers ───────────────────────────────────────────── */

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
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        return Math.floor(s / 3600) + 'h ago';
    }

    // Cloudinary delivery URL at a sensible size; other hosts pass through.
    function sized(url, w) {
        if (!url || url.indexOf('/upload/') < 0) return url;
        return url.replace('/upload/', '/upload/w_' + w + ',c_limit,q_auto:good,f_auto/');
    }

    function toast(msg) {
        if (typeof window.showToast === 'function') {
            try { window.showToast(msg); return; } catch (e) { /* fall through */ }
        }
    }

    function showMsg(text) {
        msgEl.textContent = text || '';
        msgEl.hidden = !text;
        if (!text) return;
        setTimeout(function () { if (msgEl.textContent === text) msgEl.hidden = true; }, 3600);
    }

    function lock(on) {
        document.documentElement.style.overflow = on ? 'hidden' : '';
        document.body.classList.toggle('snap-open', on);
    }

    function stopStream() {
        if (stream) {
            stream.getTracks().forEach(function (t) { t.stop(); });
            stream = null;
        }
        if (video) video.srcObject = null;
    }

    function clearSlide() {
        if (slideTimer) { clearTimeout(slideTimer); slideTimer = null; }
    }

    function setMode(next) {
        mode = next;
        view.dataset.mode = next;
        msgEl.hidden = true;                     // an old error should not follow you into the next step
        var isCamera = next === 'camera';
        var isCompose = next === 'compose';
        var isFeed = next === 'feed';

        video.hidden = !isCamera;
        img.hidden = isCamera;
        cam.hidden = !isCamera;
        compose.hidden = !isCompose;
        bars.hidden = !isFeed;
        foot.hidden = !isFeed;
        hint.hidden = !isCompose || !!input.value;
        mid.style.pointerEvents = isCompose ? 'auto' : 'none';
        if (!isCompose) input.hidden = true;
    }

    /* ── the feed ────────────────────────────────────────────────── */

    function mapDoc(d) {
        var v = d.data() || {};
        var ms = function (t) { return t && typeof t.toMillis === 'function' ? t.toMillis() : 0; };
        return {
            id: d.id,
            imageUrl: v.imageUrl || '',
            text: v.text || '',
            authorName: v.authorName || 'Member',
            authorPhoto: v.authorPhoto || '',
            createdAt: ms(v.createdAt),
            visibleUntil: ms(v.visibleUntil),
            expiresAt: ms(v.expiresAt)
        };
    }

    // oldest → newest, skipping anything past its 24 hours
    function loadFeed() {
        return db.collection('quickSnaps').orderBy('createdAt', 'desc').limit(CFG.feedLimit).get()
            .then(function (q) {
                var now = Date.now();
                snaps = q.docs.map(mapDoc).filter(function (s) {
                    return s.imageUrl && (!s.visibleUntil || s.visibleUntil > now);
                }).sort(function (a, b) { return a.createdAt - b.createdAt; });
                return snaps;
            })
            .catch(function (err) {
                console.warn('[quick snap] feed:', err && err.code, err && err.message);
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
                void fill.offsetWidth;                       // restart the fill
                fill.style.transition = 'width ' + CFG.slideMs + 'ms linear';
                fill.style.width = '100%';
            }
        }
    }

    function showSnap(i) {
        if (!snaps.length) return;
        index = (i + snaps.length) % snaps.length;
        var s = snaps[index];

        setMode('feed');
        img.src = sized(s.imageUrl, 1080);
        textEl.textContent = s.text || '';
        textEl.hidden = !s.text;

        ava.innerHTML = s.authorPhoto
            ? '<img src="' + esc(s.authorPhoto) + '" alt="" referrerpolicy="no-referrer">'
            : esc(initials(s.authorName));
        who.textContent = s.authorName;
        timeEl.textContent = ago(s.createdAt);

        empty.hidden = true;
        if (bars.children.length !== snaps.length) paintProgress();
        markProgress();

        if (snaps.length > 1) {
            var next = new Image();
            next.src = sized(snaps[(index + 1) % snaps.length].imageUrl, 1080);
        }

        clearSlide();
        if (snaps.length > 1) {
            slideTimer = setTimeout(function () {
                if (index >= snaps.length - 1) { clearSlide(); return; }
                showSnap(index + 1);
            }, CFG.slideMs);
        }
    }

    function showEmpty() {
        clearSlide();
        setMode('feed');
        img.hidden = true;
        img.removeAttribute('src');
        textEl.hidden = true;
        empty.hidden = false;
        bars.innerHTML = '';
        foot.hidden = true;
    }

    function openViewer() {
        view.hidden = false;
        lock(true);
        paintProgress();
        if (snaps.length) showSnap(0); else showEmpty();
    }

    function closeViewer() {
        clearSlide();
        stopStream();
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;
        showCollection(false);
        view.hidden = true;
        lock(false);
        refreshFab();
    }

    /* ── the snippet ─────────────────────────────────────────────── */

    function refreshFab() {
        if (!me) { fab.classList.remove('visible'); return; }
        fab.classList.add('visible');
        db.collection('quickSnaps').orderBy('createdAt', 'desc').limit(1).get().then(function (q) {
            if (!q.empty && q.docs.length) {
                var s = mapDoc(q.docs[0]);
                if (s.imageUrl && (!s.visibleUntil || s.visibleUntil > Date.now())) return paintFab(s);
            }
            paintFab(null);
        }).catch(function () { paintFab(null); });
    }

    function paintFab(snap) {
        fabImg.innerHTML = snap
            ? '<img src="' + esc(sized(snap.imageUrl, 200)) + '" alt="" referrerpolicy="no-referrer">'
            : '<span class="qs-fab-empty"><i class="fas fa-bolt"></i></span>';
        fabBadge.hidden = !snap;
    }

    /* ── camera and compose ──────────────────────────────────────── */

    function startCamera() {
        stopStream();
        setMode('camera');
        view.dataset.facing = facing;
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;
        textEl.hidden = true;
        textEl.textContent = '';
        input.value = '';

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showMsg('This browser cannot open the camera.');
            return;
        }
        navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1600 } }
        }).then(function (s) {
            stream = s;
            video.srcObject = s;
            var started = video.play();
            if (started && started.catch) started.catch(function () {});
        }).catch(function (err) {
            console.warn('[quick snap] camera:', err && err.name);
            showMsg('No camera access. Allow the camera for this site and try again.');
        });
    }

    function shoot() {
        if (!stream || !video.videoWidth) {
            showMsg('Hold on — the camera is still waking up.');
            return;
        }
        var w = video.videoWidth, h = video.videoHeight;
        var scale = Math.min(1, CFG.maxSide / Math.max(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var ctx = canvas.getContext('2d');
        if (facing === 'user') {                     // match the mirrored preview
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(function (blob) {
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

    function upload(blob) {
        var body = new FormData();
        body.append('file', blob, 'snap.jpg');
        body.append('upload_preset', CFG.preset);
        body.append('folder', CFG.folder);
        return fetch('https://api.cloudinary.com/v1_1/' + CFG.cloud + '/image/upload', { method: 'POST', body: body })
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

        upload(pendingBlob).then(function (media) {
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
                openViewer();
                if (snaps.length) showSnap(snaps.length - 1);   // show what was just posted
                refreshFab();
            });
        }).catch(function (err) {
            busy = false;
            btn.disabled = false;
            btn.textContent = 'Post';
            console.warn('[quick snap] post:', err && err.message);
            showMsg('That did not go through. Check your connection and try again.');
        });
    }

    /* ── the collection ──────────────────────────────────────────── */

    // While the collection is up it owns the card: no bars, no author strip.
    function showCollection(open) {
        colSheet.hidden = !open;
        if (open) {
            clearSlide();
            bars.hidden = true;
            foot.hidden = true;
        } else if (mode === 'feed') {
            bars.hidden = false;
            foot.hidden = !snaps.length;
        }
    }

    function openCollection() {
        showCollection(true);
        colGrid.innerHTML = '<p class="qs-col-empty">Loading your snaps…</p>';
        if (!me) return;

        db.collection('quickSnaps').where('authorUid', '==', me.uid).limit(CFG.mineLimit).get()
            .then(function (q) {
                var now = Date.now();
                var mine = q.docs.map(mapDoc)
                    .filter(function (s) { return s.imageUrl && (!s.expiresAt || s.expiresAt > now); })
                    .sort(function (a, b) { return b.createdAt - a.createdAt; });

                if (!mine.length) {
                    colGrid.innerHTML = '<p class="qs-col-empty">Your snaps live here for 7 days.<br>Take one with the camera.</p>';
                    return;
                }
                colGrid.innerHTML = mine.map(function (s, i) {
                    return '<button class="qs-thumb" type="button" data-i="' + i + '">' +
                        '<img src="' + esc(sized(s.imageUrl, 300)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
                        '<span>' + esc(ago(s.createdAt)) + '</span></button>';
                }).join('');
                colGrid._mine = mine;
            })
            .catch(function (err) {
                console.warn('[quick snap] collection:', err && err.code, err && err.message);
                colGrid.innerHTML = '<p class="qs-col-empty">Could not load your snaps right now.</p>';
            });
    }

    function openFromCollection(i) {
        var mine = colGrid._mine || [];
        if (!mine[i]) return;
        var wanted = mine[i].id;
        snaps = mine.slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
        showCollection(false);
        var at = 0;
        for (var n = 0; n < snaps.length; n++) if (snaps[n].id === wanted) { at = n; break; }
        showSnap(at);
    }

    /* ── wiring ──────────────────────────────────────────────────── */

    function boot(user) {
        me = user || null;
        if (!me) { fab.classList.remove('visible'); return; }
        profile = {
            name: me.displayName || (me.email ? me.email.split('@')[0] : 'Member'),
            photo: me.photoURL || ''
        };
        refreshFab();
        db.collection('users').doc(me.uid).get().then(function (doc) {
            if (!doc || !doc.exists) return;
            var d = doc.data() || {};
            if (d.displayName) profile.name = d.displayName;
            if (d.photoURL) profile.photo = d.photoURL;
        }).catch(function () { /* the auth profile is enough */ });
    }

    firebase.auth().onAuthStateChanged(boot);

    fab.addEventListener('click', function () {
        if (!me) return;
        openViewer();                       // open at once; fill in when the feed lands
        loadFeed().then(function () {
            if (!view.hidden && mode === 'feed') {
                if (snaps.length) showSnap(0); else showEmpty();
            }
        });
    });

    $('qsClose').addEventListener('click', closeViewer);
    $('qsPrev').addEventListener('click', function () { clearSlide(); showSnap(index - 1); });
    $('qsNext').addEventListener('click', function () { clearSlide(); showSnap(index + 1); });
    $('qsCamera').addEventListener('click', startCamera);
    $('qsEmptyCam').addEventListener('click', startCamera);
    $('qsCollection').addEventListener('click', openCollection);
    $('qsColClose').addEventListener('click', function () { showCollection(false); });
    $('qsShutter').addEventListener('click', shoot);
    $('qsRetake').addEventListener('click', startCamera);
    $('qsPost').addEventListener('click', post);
    $('qsFlip').addEventListener('click', function () {
        facing = facing === 'user' ? 'environment' : 'user';
        startCamera();
    });

    // In compose the textarea *is* the curved box, so no second preview is drawn.
    mid.addEventListener('click', function () {
        if (mode !== 'compose') return;
        hint.hidden = true;
        input.hidden = false;
        input.focus();
    });

    input.addEventListener('input', function () {
        hint.hidden = !!input.value;
    });

    input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();                 // a caption is one line; Enter just closes it
        input.blur();
    });

    input.addEventListener('blur', function () {
        hint.hidden = !!input.value;
    });

    colGrid.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.qs-thumb');
        if (btn) openFromCollection(Number(btn.dataset.i));
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape' || view.hidden) return;
        if (!colSheet.hidden) { showCollection(false); return; }
        closeViewer();
    });

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) clearSlide();
    });

    // Keep the snippet out from under Tita Tima's panel.
    var titaPanel = document.getElementById('titaPanel');
    if (titaPanel) {
        var syncTita = function () {
            document.body.classList.toggle('tita-open', titaPanel.classList.contains('open'));
        };
        new MutationObserver(syncTita).observe(titaPanel, { attributes: true, attributeFilter: ['class'] });
        syncTita();
    }
})();
