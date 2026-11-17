/* ================================================================
   quick-snap.js — QuickSnap, the camera-first snapshot for the whole squad.

   Tap the tucked-away snippet beside Tita and the card zooms open. If someone
   has a snap up, that is what you see, with the member who posted it and the
   time underneath; if nothing is up, the camera opens so you can be the one
   who posts. Everyone signed in can see every snap for 24 hours.

   Data model
     quickSnaps/{id}          author, image, caption, status,
                              createdAt, expiresAt, purgeAt
     quickSnaps/{id}/reactions/{uid}   one emoji per member
     The author keeps a private 7-day archive of what they posted.

   Access rules live in firestore.rules: only signed-in members may read an
   active, unexpired snap. The hourly cleanup worker deletes documents past
   purgeAt and their Cloudinary files.
   ================================================================ */
(function () {
    'use strict';

    if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
    if (window.__quickSnapLoaded) return;
    window.__quickSnapLoaded = true;

    var CFG = {
        ttlMs: 24 * 60 * 60 * 1000,          // how long a snap stays up
        keepMs: 7 * 24 * 60 * 60 * 1000,     // how long the author keeps it
        maxText: 140,
        maxSide: 1400,                       // long edge of the uploaded photo
        cloud: 'ooq99nlw',
        preset: 't-imawa',
        folder: 't-imawa/quicksnaps',
        feedLimit: 30,
        archiveLimit: 60,
        undoMs: 6000
    };

    var EMOJI = ['❤️', '😂', '😮', '😢', '👍'];

    var db = firebase.app().firestore();
    var me = null;
    var profile = { name: 'Member', photo: '' };
    var snaps = [];           // every live snap, newest first
    var archive = [];         // snaps I posted
    var mode = 'camera';
    var backTo = 'camera';
    var current = null;       // the snap on screen
    var stream = null;
    var facing = 'user';
    var pendingBlob = null;
    var pendingURL = null;
    var busy = false;
    var undo = null;          // { timer, run }

    /* ── the DOM ─────────────────────────────────────────────────── */

    var host = document.createElement('div');
    host.innerHTML = [
        // the snippet: half tucked into the right edge, above Tita Tima
        '<button class="qs-fab" id="qsFab" type="button" title="QuickSnap" aria-label="Open QuickSnap">',
        '  <span class="qs-fab-img" id="qsFabImg"></span>',
        '  <span class="qs-fab-badge" id="qsFabBadge" hidden></span>',
        '</button>',

        '<div class="qs-view" id="qsView" hidden data-mode="camera" data-facing="user">',
        '  <div class="qs-stage" role="dialog" aria-modal="true" aria-label="QuickSnap">',

        '    <div class="qs-head">',
        '      <button class="qs-round" id="qsBack" type="button" aria-label="Back" hidden><i class="fas fa-chevron-left"></i></button>',
        '      <button class="qs-round qs-close" id="qsClose" type="button" aria-label="Close QuickSnap">✕</button>',
        '      <div class="qs-tabs" role="tablist" aria-label="Snap mode">',
        '        <button class="qs-tab" type="button" role="tab" tabindex="-1" aria-disabled="true" title="Posting stays where it is">Post</button>',
        '        <button class="qs-tab is-on" type="button" role="tab" aria-selected="true">Quick Snap</button>',
        '        <button class="qs-tab" type="button" role="tab" tabindex="-1" aria-disabled="true" title="Stories stay where they are">Story</button>',
        '      </div>',
        '      <div class="qs-tools">',
        '        <button class="qs-round" id="qsMakeSnap" type="button" title="Take your own snap" aria-label="Take your own snap" hidden><i class="fas fa-camera"></i></button>',
        '        <button class="qs-round" id="qsFlip" type="button" title="Flip camera" aria-label="Flip camera"><i class="fas fa-rotate"></i></button>',
        '        <button class="qs-round" id="qsRetake" type="button" title="Retake" aria-label="Retake the photo" hidden><i class="fas fa-rotate-left"></i></button>',
        '      </div>',
        '    </div>',

        '    <div class="qs-body">',

        // camera
        '      <section class="qs-screen" id="qsCameraScreen" aria-label="Take a snap">',
        '        <div class="qs-frame">',
        '          <video class="qs-video" id="qsVideo" playsinline muted autoplay hidden></video>',
        '          <img class="qs-img" id="qsPreview" alt="" hidden />',
        '          <span class="qs-frame-flag" id="qsFrameFlag" hidden><i class="fas fa-check"></i> Captured</span>',
        '          <textarea class="qs-caption-box" id="qsCaptionInput" rows="1" maxlength="140" placeholder="Add a caption…" aria-label="Caption" hidden></textarea>',
        '          <p class="qs-frame-hint" id="qsHint" hidden></p>',
        '        </div>',
        '        <div class="qs-sendline">',
        '          <p id="qsSendLine">Everyone can see your snap for 24 hours</p>',
        '          <button class="qs-select-friends" id="qsTakeSnap" type="button">Tap the shutter to take it <i class="fas fa-chevron-right"></i></button>',
        '        </div>',
        '        <div class="qs-dock">',
        '          <button class="qs-dock-main" id="qsShutter" type="button" aria-label="Take the photo"><i class="fas fa-camera" id="qsShutterIcon"></i></button>',
        '          <button class="qs-dock-side qs-dock-snaps" id="qsSnapsBtn" type="button" aria-label="See the latest snap"><i class="fas fa-images"></i><span class="qs-dock-num" id="qsSnapsNum" hidden></span></button>',
        '          <button class="qs-dock-side qs-dock-archive" id="qsArchiveBtn" type="button" aria-label="Your archive"><i class="fas fa-layer-group"></i></button>',
        '        </div>',
        '      </section>',

        // the snap on screen
        '      <section class="qs-screen" id="qsViewer" aria-label="Snap" hidden>',
        '        <div class="qs-shot">',
        '          <img class="qs-img" id="qsImg" alt="" hidden />',
        '          <div class="qs-caption" id="qsCaption" hidden></div>',
        '        </div>',
        '        <div class="qs-who" id="qsWhoRow">',
        '          <span class="qs-ava" id="qsAva"></span>',
        '          <span class="qs-who-wrap"><b id="qsWho"></b><small id="qsWhen"></small></span>',
        '          <span class="qs-seen-count" id="qsSeenCount"></span>',
        '        </div>',
        '        <div class="qs-actions" id="qsActions">',
        '          <div class="qs-reactions" id="qsReactions"></div>',
        '          <button class="qs-btn qs-btn-ghost" id="qsReplyBtn" type="button"><i class="fas fa-reply"></i> Reply</button>',
        '        </div>',
        '        <div class="qs-reply" id="qsReply" hidden>',
        '          <input class="qs-reply-input" id="qsReplyInput" type="text" maxlength="280" placeholder="Reply privately…" />',
        '          <button class="qs-btn qs-btn-post" id="qsReplySend" type="button">Send</button>',
        '        </div>',
        '        <div class="qs-owner-tools" id="qsOwnerTools" hidden>',
        '          <button class="qs-btn qs-btn-ghost qs-danger" id="qsDelete" type="button"><i class="fas fa-trash-can"></i> Delete</button>',
        '        </div>',
        '      </section>',

        // archive
        '      <section class="qs-screen" id="qsArchiveScreen" aria-label="Your archive" hidden>',
        '        <div class="qs-inbox-head"><b>Your archive</b><span>7 days</span></div>',
        '        <div class="qs-archive-grid" id="qsArchiveGrid"></div>',
        '        <div class="qs-empty" id="qsArchiveEmpty" hidden>',
        '          <span class="qs-empty-ico"><i class="fas fa-layer-group"></i></span>',
        '          <b>Nothing posted yet</b>',
        '          <p>Snaps you post stay here for 7 days, even after they leave the squad feed.</p>',
        '        </div>',
        '      </section>',

        '      <p class="qs-msg" id="qsMsg" hidden></p>',
        '    </div>',
        '  </div>',
        '</div>',
        '<div class="qs-toast" id="qsToast" hidden><span id="qsToastText"></span><button type="button" id="qsUndo">Undo</button></div>'
    ].join('');
    document.body.appendChild(host);

    var $ = function (id) { return document.getElementById(id); };
    var fab = $('qsFab'), fabImg = $('qsFabImg'), fabBadge = $('qsFabBadge');
    var view = $('qsView');
    var screens = { camera: $('qsCameraScreen'), viewer: $('qsViewer'), archive: $('qsArchiveScreen') };
    var img = $('qsImg'), caption = $('qsCaption');
    var ava = $('qsAva'), who = $('qsWho'), when = $('qsWhen'), seenCount = $('qsSeenCount');
    var video = $('qsVideo'), preview = $('qsPreview'), captionInput = $('qsCaptionInput');
    var hint = $('qsHint'), frameFlag = $('qsFrameFlag'), sendLine = $('qsSendLine');
    var shutter = $('qsShutter'), shutterIcon = $('qsShutterIcon');
    var archiveGrid = $('qsArchiveGrid'), archiveEmpty = $('qsArchiveEmpty');
    var msgEl = $('qsMsg');
    var toast = $('qsToast'), toastText = $('qsToastText');
    var backBtn = $('qsBack'), retake = $('qsRetake');

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
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }

    function sized(url, w) {
        if (!url || url.indexOf('/upload/') < 0) return url;
        return url.replace('/upload/', '/upload/w_' + w + ',c_limit,q_auto:good,f_auto/');
    }

    function ms(t) { return t && typeof t.toMillis === 'function' ? t.toMillis() : 0; }

    function toastWithUndo(text, onUndo) {
        toastText.textContent = text;
        toast.hidden = false;
        clearTimeout(undo && undo.timer);
        undo = {
            timer: setTimeout(function () { toast.hidden = true; undo = null; }, CFG.undoMs),
            run: onUndo
        };
    }

    function showMsg(text) {
        msgEl.textContent = text || '';
        msgEl.hidden = !text;
        if (text) setTimeout(function () { if (msgEl.textContent === text) msgEl.hidden = true; }, 3800);
    }

    function lock(on) {
        document.documentElement.style.overflow = on ? 'hidden' : '';
        document.body.classList.toggle('snap-open', on);
    }

    function stopStream() {
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
        if (video) video.srcObject = null;
    }

    function setMode(next) {
        mode = next;
        view.dataset.mode = next;
        Object.keys(screens).forEach(function (k) { screens[k].hidden = k !== next; });
        msgEl.hidden = true;
        backBtn.hidden = next === 'camera';
        $('qsMakeSnap').hidden = next === 'camera';
        if (next !== 'camera') { stopStream(); $('qsFlip').hidden = true; retake.hidden = true; }
        if (next === 'camera') {
            $('qsFlip').hidden = !preview.hidden;
            retake.hidden = preview.hidden;
        }
    }

    function setShotState(hasShot) {
        shutter.classList.toggle('is-send', hasShot);
        shutterIcon.className = hasShot ? 'fas fa-paper-plane' : 'fas fa-camera';
        shutter.setAttribute('aria-label', hasShot ? 'Post this snap' : 'Take the photo');
        $('qsFlip').hidden = hasShot;
        retake.hidden = !hasShot;
        captionInput.hidden = !hasShot;
        frameFlag.hidden = !hasShot;
        sendLine.textContent = hasShot ? 'Everyone can see your snap for 24 hours' : 'Frame it, then tap the shutter';
        $('qsTakeSnap').firstChild.textContent = hasShot ? 'Tap the arrow to post it ' : 'Tap the shutter to take it ';
    }

    function refreshDock() {
        var n = snaps.length;
        $('qsSnapsNum').hidden = !n;
        $('qsSnapsNum').textContent = n > 9 ? '9+' : String(n);
        fabBadge.hidden = true;
    }

    /* ── data ────────────────────────────────────────────────────── */

    function mapSnap(d) {
        var v = d.data() || {};
        return {
            id: d.id,
            ownerUid: v.ownerUid || '',
            ownerName: v.ownerName || 'Member',
            ownerPhoto: v.ownerPhoto || '',
            imageUrl: v.imageUrl || '',
            text: v.text || '',
            createdAt: ms(v.createdAt),
            expiresAt: ms(v.expiresAt),
            purgeAt: ms(v.purgeAt)
        };
    }

    async function loadSnaps() {
        if (!me) return [];
        try {
            // one equality filter, sorted here, so no composite index is needed
            var q = await db.collection('quickSnaps').where('status', '==', 'active')
                .limit(CFG.feedLimit).get();
            var now = Date.now();
            snaps = q.docs.map(mapSnap).filter(function (s) {
                return s.imageUrl && s.expiresAt > now;
            }).sort(function (a, b) { return b.createdAt - a.createdAt; });
        } catch (err) {
            console.warn('[quicksnap] feed:', err && err.code, err && err.message);
            snaps = [];
        }
        refreshDock();
        renderRibbon();
        return snaps;
    }

    async function loadArchive() {
        if (!me) return [];
        try {
            var q = await db.collection('quickSnaps').where('ownerUid', '==', me.uid).limit(CFG.archiveLimit).get();
            archive = q.docs.map(mapSnap)
                .filter(function (s) { return s.imageUrl; })
                .sort(function (a, b) { return b.createdAt - a.createdAt; });
        } catch (err) {
            console.warn('[quicksnap] archive:', err && err.code, err && err.message);
            archive = [];
        }
        return archive;
    }

    async function refreshFab() {
        refreshDock();
        if (!me) { fab.classList.remove('visible'); return; }
        fab.classList.add('visible');
        if (snaps.length) {
            fabImg.innerHTML = '<img src="' + esc(sized(snaps[0].imageUrl, 200)) + '" alt="" referrerpolicy="no-referrer">';
        } else {
            fabImg.innerHTML = '<span class="qs-fab-empty"><i class="fas fa-bolt"></i></span>';
        }
    }

    /* ── viewer ──────────────────────────────────────────────────── */

    function openViewer(snap, ownerView) {
        backTo = mode === 'archive' ? 'archive' : 'camera';
        current = snap;
        setMode('viewer');
        img.src = sized(snap.imageUrl, 1080);
        img.hidden = false;
        caption.textContent = snap.text || '';
        caption.hidden = !snap.text;
        ava.innerHTML = snap.ownerPhoto
            ? '<img src="' + esc(snap.ownerPhoto) + '" alt="" referrerpolicy="no-referrer">'
            : esc(initials(snap.ownerName));
        who.textContent = ownerView ? 'You' : snap.ownerName;
        when.textContent = (ownerView ? 'Your snap · ' : '') + ago(snap.createdAt);
        var at = snaps.indexOf(snap);
        seenCount.textContent = at > -1 && snaps.length > 1 ? (at + 1) + ' of ' + snaps.length : '';

        var isOwner = ownerView || snap.ownerUid === (me && me.uid);
        $('qsActions').hidden = isOwner;
        $('qsReply').hidden = true;
        $('qsOwnerTools').hidden = !isOwner;
        $('qsReplyBtn').hidden = isOwner;

        renderReactions(snap, isOwner);
    }

    function renderReactions(snap, isOwner) {
        var wrap = $('qsReactions');
        wrap.innerHTML = EMOJI.map(function (e) {
            return '<button class="qs-emoji" type="button" data-emoji="' + e + '" aria-label="React ' + e + '">' + e + '</button>';
        }).join('');
        wrap.hidden = isOwner;
    }

    async function react(emoji) {
        if (!current || !me) return;
        try {
            await db.collection('quickSnaps').doc(current.id).collection('reactions').doc(me.uid)
                .set({
                    emoji: emoji,
                    uid: me.uid,
                    name: profile.name,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            showMsg('Reaction sent ' + emoji);
            setTimeout(closeCard, 700);
        } catch (err) {
            showMsg('Could not send that reaction.');
        }
    }

    async function sendReply() {
        var input = $('qsReplyInput');
        var text = (input.value || '').trim();
        if (!current || !me) return;
        if (!text) { input.focus(); return; }
        try {
            var peer = current.ownerUid;
            await db.collection('chatMessages').doc().set({
                senderUid: me.uid,
                receiverUid: peer,
                participantsKey: [me.uid, peer].sort().join('_'),
                participants: [me.uid, peer],
                senderName: profile.name,
                senderPhoto: profile.photo,
                text: text,
                mentions: [],
                hasSquadMention: false,
                read: false,
                isGroup: false,
                reactions: {},
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            input.value = '';
            showMsg('Reply sent');
            setTimeout(function () {
                closeCard();
                if (typeof window.openChatWith === 'function') {
                    try { window.openChatWith(peer); } catch (e) { /* chat may be disabled */ }
                }
            }, 600);
        } catch (err) {
            showMsg('Could not send that reply.');
        }
    }

    async function deleteSnap(snap) {
        if (!snap || !me) return;
        if (!window.confirm('Delete this snap for everyone?')) return;
        try {
            await db.collection('quickSnaps').doc(snap.id).delete();
            snaps = snaps.filter(function (s) { return s.id !== snap.id; });
            archive = archive.filter(function (s) { return s.id !== snap.id; });
            await refreshFab();
            if (snaps.length) {
                openViewer(snaps[0], snaps[0].ownerUid === me.uid);
            } else {
                showMsg('Deleted');
                openCamera();
            }
        } catch (err) {
            showMsg('Could not delete it.');
        }
    }

    /* ── camera and post ────────────────────────────────────────── */

    function openCamera() {
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;
        preview.removeAttribute('src');
        preview.hidden = true;
        video.hidden = false;
        captionInput.value = '';
        captionInput.hidden = true;
        frameFlag.hidden = true;
        hint.hidden = true;
        setMode('camera');
        setShotState(false);
        startStream();
    }

    function startStream() {
        stopStream();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            hint.textContent = 'This browser cannot open the camera.';
            hint.hidden = false;
            return;
        }
        navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1600 } }
        }).then(function (s) {
            if (view.hidden || mode !== 'camera') { s.getTracks().forEach(function (t) { t.stop(); }); return; }
            stream = s;
            view.dataset.facing = facing;
            video.srcObject = s;
            var started = video.play();
            if (started && started.catch) started.catch(function () {});
        }).catch(function (err) {
            console.warn('[quicksnap] camera:', err && err.name);
            hint.textContent = 'No camera access — allow it for this site, then tap the shutter.';
            hint.hidden = false;
        });
    }

    function shoot() {
        if (!stream || !video.videoWidth) { showMsg('Hold on — the camera is still waking up.'); return; }
        var w = video.videoWidth, h = video.videoHeight;
        var scale = Math.min(1, CFG.maxSide / Math.max(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var ctx = canvas.getContext('2d');
        if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(function (blob) {
            if (!blob) { showMsg('That photo did not save — try again.'); return; }
            pendingBlob = blob;
            pendingURL = URL.createObjectURL(blob);
            preview.src = pendingURL;
            preview.hidden = false;
            video.hidden = true;
            stopStream();
            hint.hidden = true;
            setShotState(true);
        }, 'image/jpeg', 0.9);
    }

    async function upload(blob) {
        var body = new FormData();
        body.append('file', blob, 'snap.jpg');
        body.append('upload_preset', CFG.preset);
        body.append('folder', CFG.folder);
        var res = await fetch('https://api.cloudinary.com/v1_1/' + CFG.cloud + '/image/upload', { method: 'POST', body: body });
        var json = await res.json();
        if (!res.ok) throw new Error((json.error && json.error.message) || 'Upload failed');
        return { url: json.secure_url, publicId: json.public_id };
    }

    async function postSnap() {
        if (busy) return;
        if (!pendingBlob) { openCamera(); return; }

        busy = true;
        shutter.disabled = true;
        showMsg('Posting your snap…');
        var text = (captionInput.value || '').trim().slice(0, CFG.maxText);

        try {
            var media = await upload(pendingBlob);
            var now = new Date();
            var doc = await db.collection('quickSnaps').add({
                ownerUid: me.uid,
                ownerName: profile.name,
                ownerPhoto: profile.photo,
                imageUrl: media.url,
                imagePublicId: media.publicId,
                text: text,
                status: 'active',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                expiresAt: firebase.firestore.Timestamp.fromDate(new Date(now.getTime() + CFG.ttlMs)),
                purgeAt: firebase.firestore.Timestamp.fromDate(new Date(now.getTime() + CFG.keepMs))
            });

            if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
            pendingBlob = null;
            closeCard();
            toastWithUndo('Snap posted for the squad', async function () {
                try { await db.collection('quickSnaps').doc(doc.id).delete(); } catch (e) { /* ignore */ }
                toast.hidden = true;
                loadSnaps().then(refreshFab);
            });
        } catch (err) {
            console.warn('[quicksnap] post:', err && err.message);
            showMsg('That did not post. Check your connection and try again.');
        } finally {
            busy = false;
            shutter.disabled = false;
        }
    }

    /* ── archive ────────────────────────────────────────────────── */

    async function openArchive() {
        setMode('archive');
        archiveGrid.innerHTML = '<p class="qs-col-empty">Loading your snaps…</p>';
        archiveEmpty.hidden = true;
        await loadArchive();
        if (!archive.length) {
            archiveGrid.innerHTML = '';
            archiveEmpty.hidden = false;
            return;
        }
        archiveGrid.innerHTML = archive.map(function (s) {
            return '<button class="qs-thumb" type="button" data-id="' + esc(s.id) + '">' +
                '<img src="' + esc(sized(s.imageUrl, 320)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
                '<span>' + esc(ago(s.createdAt)) + '</span></button>';
        }).join('');
    }

    /* ── the ribbon above conversations ─────────────────────────── */

    function renderRibbon() {
        var rail = document.getElementById('qsRibbon');
        if (!rail || !me) return;
        var latest = {};
        snaps.forEach(function (s) {
            if (!latest[s.ownerUid]) latest[s.ownerUid] = s;
        });
        var owners = Object.keys(latest).map(function (uid) { return latest[uid]; });
        if (!owners.length) {
            rail.hidden = true;
            rail.innerHTML = '';
            return;
        }
        rail.hidden = false;
        rail.innerHTML = '<button class="qs-rail-make" type="button" id="qsRailMake">' +
            '<span class="qs-rail-ring"><i class="fas fa-camera"></i></span><small>Your snap</small></button>' +
            owners.map(function (s) {
                return '<button class="qs-rail-item" type="button" data-id="' + esc(s.id) + '">' +
                    '<span class="qs-rail-ring has-snap">' +
                    (s.ownerPhoto ? '<img src="' + esc(s.ownerPhoto) + '" alt="" referrerpolicy="no-referrer">' : esc(initials(s.ownerName))) +
                    '</span><small>' + esc(String(s.ownerName).split(' ')[0]) + '</small></button>';
            }).join('');
    }

    /* ── opening and closing ────────────────────────────────────── */

    function zoomIn() {
        view.hidden = false;
        view.classList.remove('is-open');
        void view.offsetWidth;          // restart the zoom every time
        view.classList.add('is-open');
        setTimeout(function () { view.classList.remove('is-open'); }, 400);
    }

    async function openCard() {
        zoomIn();
        lock(true);
        await loadSnaps();
        if (snaps.length) openViewer(snaps[0], snaps[0].ownerUid === me.uid);
        else openCamera();
    }

    function closeCard() {
        stopStream();
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;
        captionInput.value = '';
        view.hidden = true;
        view.classList.remove('is-open');
        lock(false);
        current = null;
        loadSnaps().then(refreshFab);
    }

    /* ── wiring ─────────────────────────────────────────────────── */

    async function boot(user) {
        me = user || null;
        if (!me) { fab.classList.remove('visible'); return; }
        profile = {
            name: me.displayName || (me.email ? me.email.split('@')[0] : 'Member'),
            photo: me.photoURL || ''
        };
        fab.classList.add('visible');
        try {
            var doc = await db.collection('users').doc(me.uid).get();
            if (doc.exists) {
                var d = doc.data() || {};
                if (d.displayName) profile.name = d.displayName;
                if (d.photoURL) profile.photo = d.photoURL;
            }
        } catch (e) { /* the auth profile is enough */ }

        await loadSnaps();
        refreshFab();
        if (boot.polling) return;
        boot.polling = true;
        setInterval(async function () {
            if (!me) return;
            await loadSnaps();
            refreshFab();
        }, 60000);
    }

    firebase.auth().onAuthStateChanged(boot);

    fab.addEventListener('click', openCard);
    $('qsClose').addEventListener('click', closeCard);
    backBtn.addEventListener('click', function () {
        if (mode === 'viewer' && backTo === 'archive') openArchive(); else openCamera();
    });

    $('qsFlip').addEventListener('click', function () {
        facing = facing === 'user' ? 'environment' : 'user';
        startStream();
    });
    retake.addEventListener('click', openCamera);
    $('qsMakeSnap').addEventListener('click', openCamera);
    $('qsTakeSnap').addEventListener('click', function () {
        if (pendingBlob) postSnap(); else shoot();
    });
    shutter.addEventListener('click', function () {
        if (pendingBlob) postSnap(); else shoot();
    });
    $('qsSnapsBtn').addEventListener('click', function () {
        if (snaps.length) { openViewer(snaps[0], snaps[0].ownerUid === me.uid); }
        else { showMsg('No snaps up right now — take the first one.'); openCamera(); }
    });
    $('qsArchiveBtn').addEventListener('click', openArchive);

    captionInput.addEventListener('input', function () {
        captionInput.style.height = 'auto';
        captionInput.style.height = Math.min(captionInput.scrollHeight, 180) + 'px';
    });

    $('qsReplyBtn').addEventListener('click', function () {
        $('qsReply').hidden = false;
        $('qsReplyInput').focus();
    });
    $('qsReplySend').addEventListener('click', sendReply);
    $('qsReplyInput').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); sendReply(); }
    });
    $('qsDelete').addEventListener('click', function () { deleteSnap(current); });

    $('qsReactions').addEventListener('click', function (ev) {
        var b = ev.target.closest('.qs-emoji');
        if (b) react(b.dataset.emoji);
    });

    archiveGrid.addEventListener('click', function (ev) {
        var b = ev.target.closest('.qs-thumb');
        if (!b) return;
        var snap = archive.filter(function (s) { return s.id === b.dataset.id; })[0];
        if (snap) openViewer(snap, true);
    });

    document.addEventListener('keydown', function (ev) {
        if (view.hidden || ev.key !== 'Escape') return;
        if (mode === 'viewer' && backTo === 'archive') { openArchive(); return; }
        if (mode !== 'camera') { openCamera(); return; }
        closeCard();
    });

    view.addEventListener('click', function (ev) {
        if (ev.target === view) closeCard();
    });

    toast.addEventListener('click', function (ev) {
        if (ev.target.id !== 'qsUndo' || !undo) return;
        clearTimeout(undo.timer);
        undo.run();
        undo = null;
        toast.hidden = true;
    });

    // Ribbon lives inside the dashboard's Chats panel.
    document.addEventListener('click', function (ev) {
        var rail = ev.target.closest && ev.target.closest('.qs-rail-item');
        if (rail && me) {
            var snap = snaps.filter(function (s) { return s.id === rail.dataset.id; })[0];
            zoomIn();
            lock(true);
            if (snap) openViewer(snap, snap.ownerUid === me.uid); else openCamera();
            return;
        }
        var make = ev.target.closest && ev.target.closest('#qsRailMake');
        if (make && me) {
            zoomIn();
            lock(true);
            openCamera();
        }
    });

    window.QuickSnap = {
        open: openCard,
        openCamera: openCamera,
        refresh: async function () { await loadSnaps(); await refreshFab(); }
    };
})();
