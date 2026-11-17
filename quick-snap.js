/* ================================================================
   quick-snap.js — QuickSnap, the camera-first snapshot for the whole squad.

   Tap the tucked-away snippet beside Tita and the card zooms open. If someone
   has a snap up, that is what you see, with the member who posted it and the
   time underneath; if nothing is up, the camera opens so you can be the one
   who posts. Everyone signed in can see every snap for 24 hours.

   The picture is always 1:1 with rounded corners, and its caption sits inside
   the top-left corner. A torch button lights the scene when the camera
   supports it, and the square preview is exactly the square that gets posted.
   Reply opens a small composer that sends a direct message to the author.

   Data model
     quickSnaps/{id}          author, image, caption, status,
                              createdAt, expiresAt, purgeAt
     quickSnaps/{id}/reactions/{uid}   one emoji per member
     chatMessages/{id}        the direct-message reply
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
        maxReply: 500,
        maxSide: 1080,                       // size of the uploaded square photo
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
    var flashOn = false;      // the member's choice, always shown
    var torchLit = false;     // whether the hardware torch actually lit
    var pendingBlob = null;
    var pendingURL = null;
    var busy = false;
    var feedUnsub = null;
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
        '      <div class="qs-head-gap"></div>',
        '      <div class="qs-tools">',
        '        <button class="qs-round qs-flash" id="qsFlash" type="button" title="Flash" aria-label="Turn on the flash" aria-pressed="false"><i class="fas fa-bolt"></i></button>',
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
        '          <span class="qs-flash-fill" id="qsFlashFill" aria-hidden="true"></span>',
        '          <textarea class="qs-caption-box" id="qsCaptionInput" rows="1" maxlength="140" placeholder="Add a caption…" aria-label="Caption" hidden></textarea>',
        '          <p class="qs-frame-hint" id="qsHint" hidden></p>',
        '        </div>',
        '        <div class="qs-sendline">',
        '          <p id="qsSendLine">Everyone can see your snap for 24 hours</p>',
        '          <button class="qs-select-friends" id="qsTakeSnap" type="button">Tap the shutter to take it <i class="fas fa-chevron-right"></i></button>',
        '        </div>',
        '        <div class="qs-dock">',
        '          <button class="qs-dock-side qs-dock-snaps" id="qsSnapsBtn" type="button" aria-label="See the latest snap"><i class="fas fa-images"></i><span class="qs-dock-num" id="qsSnapsNum" hidden></span></button>',
        '          <button class="qs-dock-main" id="qsShutter" type="button" aria-label="Take the photo"><i class="fas fa-camera" id="qsShutterIcon"></i></button>',
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
        '          <button class="qs-btn qs-btn-ghost" id="qsReplyBtn" type="button"><i class="fas fa-reply"></i> <span id="qsReplyLabel">Reply</span></button>',
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

        // reply straight to the author's direct messages
        '      <section class="qs-reply" id="qsReply" hidden aria-label="Reply to this snap">',
        '        <div class="qs-reply-head">',
        '          <button class="qs-round" id="qsReplyBack" type="button" aria-label="Back to the snap"><i class="fas fa-chevron-left"></i></button>',
        '          <b>Reply to <span id="qsReplyTo">them</span></b>',
        '        </div>',
        '        <p class="qs-reply-note"><i class="fas fa-paper-plane"></i> Sends a direct message</p>',
        '        <textarea class="qs-reply-input" id="qsReplyInput" rows="4" maxlength="500" placeholder="Write a reply…" aria-label="Reply message"></textarea>',
        '        <div class="qs-reply-foot">',
        '          <span class="qs-reply-count" id="qsReplyCount">0 / 500</span>',
        '          <button class="qs-btn qs-btn-post" id="qsReplySend" type="button">Send reply</button>',
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
    var backBtn = $('qsBack'), retake = $('qsRetake'), flashBtn = $('qsFlash'), flashFill = $('qsFlashFill');
    var replyPanel = $('qsReply'), replyInput = $('qsReplyInput'), replySend = $('qsReplySend');
    var replyLabel = $('qsReplyLabel');

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
        torchLit = false;
        flashOn = false;
        if (flashFill) flashFill.classList.remove('is-firing');
        refreshFlash();
    }

    function setMode(next) {
        mode = next;
        view.dataset.mode = next;
        Object.keys(screens).forEach(function (k) { screens[k].hidden = k !== next; });
        if (next !== 'viewer') closeReply();
        msgEl.hidden = true;
        backBtn.hidden = next === 'camera';
        $('qsMakeSnap').hidden = next === 'camera';
        if (next !== 'camera') {
            stopStream();
            $('qsFlip').hidden = true;
            retake.hidden = true;
        }
        if (next === 'camera') {
            $('qsFlip').hidden = !preview.hidden;
            retake.hidden = preview.hidden;
            refreshFlash();
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
        flashBtn.hidden = hasShot;
        sendLine.textContent = hasShot ? 'Everyone can see your snap for 24 hours' : 'Frame it, then tap the shutter';
        $('qsTakeSnap').firstChild.textContent = hasShot ? 'Tap the arrow to post it ' : 'Tap the shutter to take it ';
    }

    function refreshDock() {
        var n = snaps.length;
        $('qsSnapsNum').hidden = !n;
        $('qsSnapsNum').textContent = n > 9 ? '9+' : String(n);
        fabBadge.hidden = true;
    }

    /* ── flash (torch) ───────────────────────────────────────────── */

    function torchTrack() {
        return stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    }

    function torchAvailable() {
        var track = torchTrack();
        if (!track || !track.getCapabilities) return false;
        try { return !!track.getCapabilities().torch; } catch (e) { return false; }
    }

    /* The button is always there in the camera. Phones that expose a torch
       light it; everything else (front cameras, laptops) fires the white
       screen fill at capture, so flash works everywhere. */
    function refreshFlash() {
        var inCamera = mode === 'camera' && preview.hidden;
        flashBtn.hidden = !inCamera;
        flashBtn.classList.toggle('is-on', inCamera && flashOn);
        flashBtn.setAttribute('aria-pressed', inCamera && flashOn ? 'true' : 'false');
        flashBtn.setAttribute('aria-label', flashOn ? 'Turn off the flash' : 'Turn on the flash');
        flashBtn.title = torchAvailable() ? 'Flashlight' : 'Screen flash';
    }

    async function toggleFlash() {
        var next = !flashOn;
        flashOn = next;
        var track = torchTrack();
        if (next && track && torchAvailable()) {
            try {
                await track.applyConstraints({ advanced: [{ torch: true }] });
                torchLit = true;
            } catch (err) {
                console.warn('[quicksnap] torch:', err && err.name);
                torchLit = false;
            }
        } else if (!next && track && torchLit) {
            try { await track.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) { /* ignore */ }
            torchLit = false;
        }
        refreshFlash();
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
            imagePublicId: v.imagePublicId || '',
            text: v.text || '',
            status: v.status || '',
            createdAt: ms(v.createdAt),
            expiresAt: ms(v.expiresAt),
            purgeAt: ms(v.purgeAt)
        };
    }

    /* Matches the read rule exactly: unexpired snaps only. Ordering by
       expiresAt (creation + fixed TTL) is newest-first and rides the
       automatic single-field index, so no composite index is needed. */
    function feedQuery() {
        return db.collection('quickSnaps')
            .where('expiresAt', '>', new Date())
            .orderBy('expiresAt', 'desc')
            .limit(CFG.feedLimit);
    }

    async function loadSnaps() {
        if (!me) return [];
        try {
            var q = await feedQuery().get();
            var now = Date.now();
            snaps = q.docs.map(mapSnap).filter(function (s) {
                return s.imageUrl && s.status === 'active' && s.expiresAt > now;
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

    function stopFeed() {
        if (feedUnsub) { feedUnsub(); feedUnsub = null; }
    }

    /* one live listener replaces the old 60-second poll: a quiet feed costs
       nothing after the first snapshot, and a new snap arrives immediately */
    function startFeed() {
        stopFeed();
        if (!me) return;
        try {
            feedUnsub = feedQuery().onSnapshot(function (q) {
                    var now = Date.now();
                    snaps = q.docs.map(mapSnap).filter(function (s) {
                        return s.imageUrl && s.status === 'active' && s.expiresAt > now;
                    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
                    refreshDock();
                    renderRibbon();
                    refreshFab();
                }, function (err) {
                    console.warn('[quicksnap] feed stream:', err && err.code);
                    loadSnaps().then(refreshFab);
                });
        } catch (err) {
            console.warn('[quicksnap] feed stream:', err && err.message);
        }
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
        closeReply();
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
        $('qsOwnerTools').hidden = !isOwner;
        replyLabel.textContent = 'Reply';
        $('qsReplyTo').textContent = ownerView ? 'you' : snap.ownerName;

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
        var snap = current;
        try {
            await db.collection('quickSnaps').doc(snap.id).collection('reactions').doc(me.uid)
                .set({
                    emoji: emoji,
                    uid: me.uid,
                    name: profile.name,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            showMsg('Reaction sent ' + emoji);
            notifySnap(snap, emoji, profile.name + ' reacted ' + emoji + ' to your QuickSnap',
                snap.text ? '"' + String(snap.text).slice(0, 80) + '"' : 'Tap to see the snap');
        } catch (err) {
            showMsg('Could not send that reaction.');
        }
    }

    /* an uploaded file is deleted by the cleanup worker; queue its exact id so
       an early delete does not wait for the daily orphan sweep */
    function queueMedia(publicId, sourceId) {
        if (!publicId) return;
        db.collection('mediaCleanupQueue').add({
            publicId: publicId,
            resourceType: 'image',
            source: 'quicksnap',
            sourceId: sourceId || '',
            status: 'pending',
            attempts: 0,
            requestedBy: (me && me.uid) || '',
            requestedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function () { /* the daily sweep will still find it */ });
    }

    /* the owner hears about every reaction (never their own); one document per
       member per snap, so changing an emoji updates instead of piling up */
    function notifySnap(snap, icon, title, message) {
        if (!me || !snap || !snap.ownerUid || snap.ownerUid === me.uid) return;
        var url = 'index.html#quicksnap';
        var noteId = 'qs_react_' + snap.id + '_' + me.uid;
        db.collection('announcements').doc(noteId).set({
            type: 'quicksnap',
            title: title,
            message: message,
            icon: icon,
            actorUid: me.uid,
            actorName: profile.name,
            actorPhoto: profile.photo,
            priority: 'info',
            link: url,
            linkLabel: 'View QuickSnap',
            pushUrl: url,
            pushContext: 'snap:' + snap.id,
            pushPending: true,
            targetUid: snap.ownerUid,
            referenceId: 'snap_' + snap.id,
            readBy: [],
            createdBy: 'system',
            createdByName: 'System',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 3 * 86400000)
        }, { merge: true }).catch(function () { /* the reaction is saved either way */ });
    }

    /* ── reply straight to Direct Messages ──────────────────────── */

    function openReply() {
        if (!current || !me || current.ownerUid === me.uid) return;
        $('qsReplyTo').textContent = current.ownerName || 'them';
        replyInput.value = '';
        $('qsReplyCount').textContent = '0 / 500';
        replyPanel.hidden = false;
        setTimeout(function () { try { replyInput.focus(); } catch (e) { /* ignore */ } }, 40);
    }

    function closeReply() {
        if (!replyPanel) return;
        replyPanel.hidden = true;
        replyInput.value = '';
    }

    async function sendReply() {
        if (!current || !me) return;
        var text = (replyInput.value || '').trim().slice(0, CFG.maxReply);
        if (!text) { replyInput.focus(); return; }
        var ownerUid = current.ownerUid;
        if (!ownerUid || ownerUid === me.uid) return;

        var snap = current;
        replySend.disabled = true;
        try {
            var myUid = me.uid;
            await db.collection('chatMessages').add({
                senderUid: myUid,
                receiverUid: ownerUid,
                participants: [myUid, ownerUid],
                participantsKey: [myUid, ownerUid].sort().join('_'),
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
            notifyDmReply(ownerUid, text);
            closeReply();
            showMsg('Reply sent to ' + (snap.ownerName || 'their messages'));
        } catch (err) {
            console.warn('[quicksnap] reply:', err && err.code);
            showMsg('That reply did not send — check your connection.');
        } finally {
            replySend.disabled = false;
        }
    }

    /* one chat notification per sender, exactly like the chat screen's */
    async function notifyDmReply(ownerUid, text) {
        var myUid = me.uid;
        var snippet = String(text || '').slice(0, 80) + (String(text || '').length > 80 ? '...' : '');
        var pushUrl = 'dashboard.html#chat_' + myUid;
        var pushContext = 'chat:' + myUid;
        var expiresAt = new Date(Date.now() + 3 * 86400000);
        try {
            var existing = await db.collection('announcements')
                .where('type', '==', 'chat')
                .where('targetUid', '==', ownerUid)
                .where('referenceId', '==', 'dm_' + myUid)
                .limit(1).get();
            var previous = existing.empty ? null : existing.docs[0].data();
            var previousRead = !previous || !Array.isArray(previous.readBy) || previous.readBy.includes(ownerUid);
            var pushCount = previousRead ? 1 : (Number(previous.pushCount) || 0) + 1;
            if (!existing.empty) {
                await existing.docs[0].ref.update({
                    message: '"' + snippet + '"',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    expiresAt: expiresAt,
                    readBy: [],
                    link: pushUrl,
                    pushUrl: pushUrl,
                    pushContext: pushContext,
                    pushPending: true,
                    pushCount: pushCount,
                    actorUid: myUid,
                    actorName: profile.name,
                    actorPhoto: profile.photo
                });
            } else {
                await db.collection('announcements').add({
                    type: 'chat',
                    title: '💬 ' + profile.name + ' replied to your QuickSnap',
                    message: '"' + snippet + '"',
                    icon: '💬',
                    actorUid: myUid,
                    actorName: profile.name,
                    actorPhoto: profile.photo,
                    priority: 'info',
                    link: pushUrl,
                    pushUrl: pushUrl,
                    pushContext: pushContext,
                    pushPending: true,
                    pushCount: pushCount,
                    linkLabel: 'Open Chat',
                    targetUid: ownerUid,
                    referenceId: 'dm_' + myUid,
                    readBy: [],
                    createdBy: 'system',
                    createdByName: 'System',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    expiresAt: expiresAt
                });
            }
        } catch (err) {
            console.warn('[quicksnap] reply notification:', err && err.code);
        }
    }

    async function deleteSnap(snap) {
        if (!snap || !me) return;
        if (!window.confirm('Delete this snap for everyone?')) return;
        try {
            await db.collection('quickSnaps').doc(snap.id).delete();
            queueMedia(snap.imagePublicId, snap.id);
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
        // Ask for a square frame. Without this, phones hand back a tall
        // portrait stream and the square card has to crop the sides hard,
        // which is what read as "zoomed in".
        navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                facingMode: { ideal: facing },
                width: { ideal: 1440 },
                height: { ideal: 1440 },
                aspectRatio: { ideal: 1 }
            }
        }).then(function (s) {
            if (view.hidden || mode !== 'camera') { s.getTracks().forEach(function (t) { t.stop(); }); return; }
            stream = s;
            view.dataset.facing = facing;
            video.srcObject = s;
            var started = video.play();
            if (started && started.catch) started.catch(function () {});
            refreshFlash();
            setTimeout(refreshFlash, 350);
        }).catch(function (err) {
            console.warn('[quicksnap] camera:', err && err.name);
            hint.textContent = 'No camera access — allow it for this site, then tap the shutter.';
            hint.hidden = false;
        });
    }

    function shoot() {
        if (!stream || !video.videoWidth) { showMsg('Hold on — the camera is still waking up.'); return; }
        if (flashOn && !torchLit) {
            // screen flash: light the frame, then take the shot it lit
            flashFill.classList.add('is-firing');
            setTimeout(function () { flashFill.classList.remove('is-firing'); }, 260);
            setTimeout(captureFrame, 150);
            return;
        }
        captureFrame();
    }

    function captureFrame() {
        if (!stream || !video.videoWidth) return;
        var w = video.videoWidth, h = video.videoHeight;

        // The preview is a square, so the photo is the same centre square —
        // exactly what the member framed, never a surprise crop on the feed.
        var side = Math.min(w, h);
        var sx = (w - side) / 2, sy = (h - side) / 2;
        var out = Math.min(side, CFG.maxSide);
        var canvas = document.createElement('canvas');
        canvas.width = out;
        canvas.height = out;
        var ctx = canvas.getContext('2d');
        if (facing === 'user') { ctx.translate(out, 0); ctx.scale(-1, 1); }
        ctx.drawImage(video, sx, sy, side, side, 0, 0, out, out);

        canvas.toBlob(function (blob) {
            if (!blob) { showMsg('That photo did not save — try again.'); return; }
            pendingBlob = blob;
            pendingURL = URL.createObjectURL(blob);
            preview.src = pendingURL;
            preview.hidden = false;
            video.hidden = true;
            flashOn = false;
            torchLit = false;
            stopStream();
            hint.hidden = true;
            setShotState(true);
        }, 'image/jpeg', 0.85);
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
        var uploaded = null;

        try {
            var media = await upload(pendingBlob);
            uploaded = media;
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

            uploaded = null;            // the document owns the file now
            if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
            pendingBlob = null;
            closeCard();
            toastWithUndo('Snap posted for the squad', async function () {
                try { await db.collection('quickSnaps').doc(doc.id).delete(); } catch (e) { /* ignore */ }
                queueMedia(media.publicId, doc.id);
                toast.hidden = true;
                refreshFab();
            });
        } catch (err) {
            console.warn('[quicksnap] post:', err && err.message);
            // the upload landed but the document did not: free the asset
            if (uploaded && uploaded.publicId) queueMedia(uploaded.publicId, '');
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
        if (!snaps.length) await loadSnaps();
        if (snaps.length) openViewer(snaps[0], snaps[0].ownerUid === me.uid);
        else openCamera();
    }

    function closeCard() {
        closeReply();
        stopStream();
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;
        captionInput.value = '';
        view.hidden = true;
        view.classList.remove('is-open');
        lock(false);
        current = null;
        refreshFab();
    }

    /* ── wiring ─────────────────────────────────────────────────── */

    async function boot(user) {
        me = user || null;
        if (!me) { stopFeed(); fab.classList.remove('visible'); return; }
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

        // the live listener's first snapshot fills the feed; no extra read here
        startFeed();
        refreshFab();
        // a notification link lands straight on the snap
        if (/quicksnap/i.test(location.hash)) setTimeout(openCard, 80);
    }

    firebase.auth().onAuthStateChanged(boot);

    fab.addEventListener('click', openCard);
    $('qsClose').addEventListener('click', closeCard);
    backBtn.addEventListener('click', function () {
        if (mode === 'viewer' && backTo === 'archive') openArchive(); else openCamera();
    });

    $('qsFlip').addEventListener('click', function () {
        facing = facing === 'user' ? 'environment' : 'user';
        flashOn = false;
        torchLit = false;
        startStream();
    });
    retake.addEventListener('click', openCamera);
    $('qsMakeSnap').addEventListener('click', openCamera);
    flashBtn.addEventListener('click', toggleFlash);
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
        captionInput.style.height = Math.min(captionInput.scrollHeight, 160) + 'px';
    });

    $('qsReplyBtn').addEventListener('click', openReply);
    $('qsReplyBack').addEventListener('click', closeReply);
    replySend.addEventListener('click', sendReply);
    replyInput.addEventListener('input', function () {
        $('qsReplyCount').textContent = (replyInput.value || '').length + ' / 500';
    });
    replyInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); sendReply(); }
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
        if (mode === 'viewer' && !replyPanel.hidden) { closeReply(); return; }
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
