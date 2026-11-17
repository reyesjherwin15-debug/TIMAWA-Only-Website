/* ================================================================
   quick-snap.js — QuickSnap, the camera-first private snapshot.

   Tap the tucked-away snippet beside Tita and the card zooms open straight
   into the camera. Take the photo, write a caption on it, pick friends, send.
   The snap disappears from a recipient's list the moment they open it, and
   stays unread at most 24 hours. The sender keeps a private 7-day archive.

   Data model
     quickSnaps/{id}          owner, image, caption, recipients[], viewedBy[],
                              audience, status, createdAt, expiresAt, purgeAt
     quickSnaps/{id}/reactions/{uid}   one emoji per recipient
     quickSnapFriends/{uid}   that member's Close Friends list (private)

   Access rules live in firestore.rules: a recipient may read a snap only
   while it is unexpired, active and not yet opened by them. The hourly
   cleanup worker deletes documents past purgeAt and their Cloudinary files.
   ================================================================ */
(function () {
    'use strict';

    if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
    if (window.__quickSnapLoaded) return;
    window.__quickSnapLoaded = true;

    var CFG = {
        ttlMs: 24 * 60 * 60 * 1000,          // how long a recipient can open it
        keepMs: 7 * 24 * 60 * 60 * 1000,     // how long the sender keeps it
        maxText: 140,
        maxSide: 1400,                       // long edge of the uploaded photo
        maxRecipients: 50,
        cloud: 'ooq99nlw',
        preset: 't-imawa',
        folder: 't-imawa/quicksnaps',
        membersLimit: 200,
        receivedLimit: 60,
        archiveLimit: 60,
        undoMs: 6000
    };

    var EMOJI = ['❤️', '😂', '😮', '😢', '👍'];

    var db = firebase.app().firestore();
    var me = null;
    var profile = { name: 'Member', photo: '' };
    var received = [];        // snaps addressed to me and not yet opened
    var archive = [];         // snaps I sent
    var members = [];         // { uid, name, photo } — everyone else in the squad
    var closeFriends = [];    // uids on my Close Friends list
    var picked = [];          // recipients chosen for the snap being made
    var pickedIsClose = false;
    var mode = 'camera';
    var backTo = 'camera';
    var current = null;       // snap open in the viewer / detail
    var inboxFilter = '';     // ribbon tapped a specific sender
    var stream = null;
    var facing = 'user';
    var pendingBlob = null;
    var pendingURL = null;
    var busy = false;
    var viewedTimer = null;
    var undo = null;          // { id, timer }

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
        '          <p id="qsSendLine">Pick friends to send a quicksnap</p>',
        '          <button class="qs-select-friends" id="qsSelectFriends" type="button">Select friends <i class="fas fa-chevron-right"></i></button>',
        '        </div>',
        '        <div class="qs-dock">',
        '          <button class="qs-dock-main" id="qsShutter" type="button" aria-label="Take the photo"><i class="fas fa-camera" id="qsShutterIcon"></i></button>',
        '          <button class="qs-dock-side qs-dock-friends" id="qsFriendsBtn" type="button" aria-label="Choose friends"><i class="fas fa-user-group"></i><span class="qs-dock-num" id="qsFriendsNum" hidden></span></button>',
        '          <button class="qs-dock-side qs-dock-inbox" id="qsInboxBtn" type="button" aria-label="Snaps for you"><i class="fas fa-heart"></i><span class="qs-dock-num" id="qsInboxNum" hidden></span></button>',
        '        </div>',
        '      </section>',

        // inbox
        '      <section class="qs-screen" id="qsInbox" aria-label="Snaps for you" hidden>',
        '        <div class="qs-inbox-head"><b>For you</b><span id="qsInboxCount"></span>' +
            '<button class="qs-link" id="qsInboxArchive" type="button">Archive</button></div>',
        '        <div class="qs-inbox-list" id="qsInboxList"></div>',
        '        <div class="qs-empty" id="qsInboxEmpty" hidden>',
        '          <span class="qs-empty-ico"><i class="fas fa-bolt"></i></span>',
        '          <b>No snaps right now</b>',
        '          <p>Snaps you receive land here and stay 24 hours — or until you open them.</p>',
        '          <button class="qs-btn qs-btn-post" id="qsInboxCam" type="button">Take a snap</button>',
        '        </div>',
        '      </section>',

        // a single snap
        '      <section class="qs-screen" id="qsViewer" aria-label="Snap" hidden>',
        '        <div class="qs-shot">',
        '          <img class="qs-img" id="qsImg" alt="" hidden />',
        '          <div class="qs-caption" id="qsCaption" hidden></div>',
        '          <span class="qs-shot-badge" id="qsShotBadge" hidden><i class="fas fa-check"></i> Seen</span>',
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
        '          <input class="qs-reply-input" id="qsReplyInput" type="text" maxlength="280" placeholder="Send a private reply…" />',
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
        '          <b>Nothing sent yet</b>',
        '          <p>Snaps you send stay here for 7 days, with who has opened them.</p>',
        '        </div>',
        '      </section>',

        // recipient picker rides over the body
        '      <div class="qs-picker" id="qsPicker" hidden aria-label="Choose recipients">',
        '        <div class="qs-picker-head">',
        '          <button class="qs-round" id="qsPickerBack" type="button" aria-label="Back"><i class="fas fa-chevron-left"></i></button>',
        '          <b>Send to</b>',
        '          <button class="qs-btn qs-btn-post" id="qsPickerDone" type="button">Done</button>',
        '        </div>',
        '        <div class="qs-picker-search"><i class="fas fa-search"></i>',
        '          <input id="qsPickerSearch" type="search" placeholder="Search friends" />',
        '        </div>',
        '        <button class="qs-close-friends" id="qsCloseFriends" type="button">',
        '          <i class="fas fa-star"></i> <span>Close Friends</span><small id="qsCloseCount"></small>',
        '        </button>',
        '        <div class="qs-picker-list" id="qsPickerList"></div>',
        '      </div>',

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
    var screens = { camera: $('qsCameraScreen'), inbox: $('qsInbox'), viewer: $('qsViewer'), archive: $('qsArchiveScreen') };
    var img = $('qsImg'), caption = $('qsCaption'), shotBadge = $('qsShotBadge');
    var ava = $('qsAva'), who = $('qsWho'), when = $('qsWhen'), seenCount = $('qsSeenCount');
    var video = $('qsVideo'), preview = $('qsPreview'), captionInput = $('qsCaptionInput');
    var hint = $('qsHint'), frameFlag = $('qsFrameFlag'), sendLine = $('qsSendLine');
    var shutter = $('qsShutter'), shutterIcon = $('qsShutterIcon');
    var inboxList = $('qsInboxList'), inboxEmpty = $('qsInboxEmpty'), inboxCount = $('qsInboxCount');
    var archiveGrid = $('qsArchiveGrid'), archiveEmpty = $('qsArchiveEmpty');
    var picker = $('qsPicker'), pickerList = $('qsPickerList'), pickerSearch = $('qsPickerSearch');
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
        return Math.floor(s / 3600) + 'h ago';
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
        picker.hidden = true;
        backBtn.hidden = next === 'camera';
        if (next !== 'camera') stopStream();
        if (next === 'camera') {
            $('qsFlip').hidden = !preview.hidden;
            retake.hidden = preview.hidden;
        }
    }

    function setShotState(hasShot) {
        shutter.classList.toggle('is-send', hasShot);
        shutterIcon.className = hasShot ? 'fas fa-paper-plane' : 'fas fa-camera';
        shutter.setAttribute('aria-label', hasShot ? 'Send this snap' : 'Take the photo');
        $('qsFlip').hidden = hasShot;
        retake.hidden = !hasShot;
        captionInput.hidden = !hasShot;
        frameFlag.hidden = !hasShot;
        sendLine.textContent = hasShot ? 'Pick friends to send a quicksnap' : 'Frame it, then tap the shutter';
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
            recipients: v.recipients || [],
            viewedBy: v.viewedBy || [],
            audience: v.audience || 'selected',
            status: v.status || 'active',
            createdAt: ms(v.createdAt),
            expiresAt: ms(v.expiresAt),
            purgeAt: ms(v.purgeAt)
        };
    }

    async function loadReceived() {
        if (!me) return [];
        try {
            // one equality filter, sorted here, so no composite index is needed
            var q = await db.collection('quickSnaps')
                .where('recipients', 'array-contains', me.uid)
                .limit(CFG.receivedLimit).get();
            var now = Date.now();
            received = q.docs.map(mapSnap).filter(function (s) {
                return s.imageUrl && s.status === 'active' && s.expiresAt > now &&
                    s.viewedBy.indexOf(me.uid) < 0;
            }).sort(function (a, b) { return b.createdAt - a.createdAt; });
        } catch (err) {
            console.warn('[quicksnap] inbox:', err && err.code, err && err.message);
            received = [];
        }
        refreshBadges();
        return received;
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

    async function loadMembers() {
        if (members.length) return members;
        try {
            var q = await db.collection('publicProfiles').limit(CFG.membersLimit).get();
            members = q.docs.map(function (d) {
                var v = d.data() || {};
                return { uid: d.id, name: v.displayName || 'Member', photo: v.photoURL || '' };
            }).filter(function (m) { return m.uid !== (me && me.uid); })
              .sort(function (a, b) { return a.name.localeCompare(b.name); });
        } catch (err) {
            console.warn('[quicksnap] members:', err && err.code, err && err.message);
            members = [];
        }
        return members;
    }

    async function loadCloseFriends() {
        if (!me) return [];
        try {
            var doc = await db.collection('quickSnapFriends').doc(me.uid).get();
            closeFriends = doc.exists ? ((doc.data() || {}).uids || []) : [];
        } catch (err) {
            closeFriends = [];
        }
        return closeFriends;
    }

    async function saveCloseFriends(uids) {
        if (!me) return;
        closeFriends = uids.slice();
        try {
            await db.collection('quickSnapFriends').doc(me.uid)
                .set({ uids: closeFriends, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        } catch (err) {
            showMsg('Could not save your Close Friends list.');
        }
    }

    /* ── the badge on the snippet and the dock ──────────────────── */

    function refreshBadges() {
        var unread = me ? received.length : 0;
        fabBadge.hidden = !unread;
        $('qsInboxNum').hidden = !unread;
        $('qsInboxNum').textContent = unread > 99 ? '99+' : String(unread);
        $('qsFriendsNum').hidden = !picked.length;
        $('qsFriendsNum').textContent = String(picked.length);
    }

    async function refreshFab() {
        refreshBadges();
        if (!me) { fab.classList.remove('visible'); return; }
        fab.classList.add('visible');
        if (received.length) {
            fabImg.innerHTML = '<img src="' + esc(sized(received[0].imageUrl, 200)) + '" alt="" referrerpolicy="no-referrer">';
        } else {
            fabImg.innerHTML = '<span class="qs-fab-empty"><i class="fas fa-bolt"></i></span>';
        }
    }

    /* ── inbox ───────────────────────────────────────────────────── */

    function visibleReceived() {
        return inboxFilter ? received.filter(function (s) { return s.ownerUid === inboxFilter; }) : received;
    }

    function renderInbox() {
        var list = visibleReceived();
        inboxCount.textContent = list.length ? list.length + ' new' : '';
        inboxEmpty.hidden = list.length > 0;
        inboxList.innerHTML = list.map(function (s) {
            return '<button class="qs-inbox-item" type="button" data-id="' + esc(s.id) + '">' +
                '<span class="qs-inbox-ava">' +
                (s.ownerPhoto
                    ? '<img src="' + esc(s.ownerPhoto) + '" alt="" referrerpolicy="no-referrer">'
                    : esc(initials(s.ownerName))) +
                '</span>' +
                '<span class="qs-inbox-body"><b>' + esc(s.ownerName) + '</b>' +
                '<small>' + (s.text ? esc(s.text) : 'Tap to open') + '</small></span>' +
                '<span class="qs-inbox-time">' + esc(ago(s.createdAt)) + '</span>' +
                '</button>';
        }).join('');
        // a tiny thumbnail is what makes the row feel like a snap, not a message
        list.forEach(function (s) {
            var row = inboxList.querySelector('[data-id="' + s.id + '"] .qs-inbox-ava');
            if (row && s.imageUrl) row.style.backgroundImage = 'url("' + sized(s.imageUrl, 160) + '")';
        });
        refreshBadges();
    }

    async function openInbox(filterUid) {
        inboxFilter = filterUid || '';
        setMode('inbox');
        renderInbox();
        await loadReceived();
        renderInbox();
    }

    /* ── viewer ──────────────────────────────────────────────────── */

    function openViewer(snap, ownerView) {
        backTo = mode === 'archive' ? 'archive' : 'inbox';
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
        when.textContent = ago(snap.createdAt) + (ownerView ? ' · ' + snap.audience + ' audience' : '');
        seenCount.textContent = ownerView
            ? snap.viewedBy.length + '/' + snap.recipients.length + ' opened'
            : '';
        shotBadge.hidden = true;

        var isOwner = ownerView || snap.ownerUid === (me && me.uid);
        $('qsActions').hidden = isOwner;
        $('qsReply').hidden = true;
        $('qsOwnerTools').hidden = !isOwner;
        $('qsReplyBtn').hidden = isOwner;

        renderReactions(snap);

        clearTimeout(viewedTimer);
        if (!isOwner) {
            // opening it consumes it: mark viewed once it has actually been on screen
            viewedTimer = setTimeout(function () { markViewed(snap); }, 1200);
        }
    }

    function renderReactions(snap) {
        var wrap = $('qsReactions');
        wrap.innerHTML = EMOJI.map(function (e) {
            return '<button class="qs-emoji" type="button" data-emoji="' + e + '" aria-label="React ' + e + '">' + e + '</button>';
        }).join('');
        wrap.hidden = snap.ownerUid === (me && me.uid);
    }

    async function markViewed(snap) {
        if (!me || !snap || snap.ownerUid === me.uid) return;
        if (snap.viewedBy.indexOf(me.uid) > -1) return;
        snap.viewedBy.push(me.uid);
        shotBadge.hidden = false;
        try {
            await db.collection('quickSnaps').doc(snap.id).update({
                viewedBy: firebase.firestore.FieldValue.arrayUnion(me.uid)
            });
        } catch (err) {
            console.warn('[quicksnap] mark viewed:', err && err.code);
        }
        // it is no longer available to this member
        received = received.filter(function (s) { return s.id !== snap.id; });
        renderInbox();
        renderRibbon();
        refreshFab();
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
            archive = archive.filter(function (s) { return s.id !== snap.id; });
            showMsg('Deleted');
            openArchive();
        } catch (err) {
            showMsg('Could not delete it.');
        }
    }

    /* ── camera and compose ─────────────────────────────────────── */

    function openCamera() {
        clearTimeout(viewedTimer);
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
            updateSendLabel();
        }, 'image/jpeg', 0.9);
    }

    function updateSendLabel() {
        var n = picked.length;
        sendLine.textContent = pendingBlob
            ? (n ? 'Sending to ' + n + (n === 1 ? ' friend' : ' friends') : 'Pick friends to send a quicksnap')
            : 'Frame it, then tap the shutter';
        $('qsSelectFriends').firstChild.textContent = n ? 'Selected: ' + n + ' · change ' : 'Select friends ';
        refreshBadges();
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

    async function sendSnap() {
        if (busy) return;
        if (!pendingBlob) { openCamera(); return; }
        if (!picked.length) { openPicker(); showMsg('Pick at least one friend first.'); return; }

        busy = true;
        shutter.disabled = true;
        showMsg('Sending your snap…');
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
                recipients: picked.slice(),
                viewedBy: [],
                audience: pickedIsClose ? 'close' : 'selected',
                status: 'active',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                expiresAt: firebase.firestore.Timestamp.fromDate(new Date(now.getTime() + CFG.ttlMs)),
                purgeAt: firebase.firestore.Timestamp.fromDate(new Date(now.getTime() + CFG.keepMs))
            });

            var sentTo = picked.length;
            if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
            pendingBlob = null;
            picked = [];
            pickedIsClose = false;
            closeCard();
            toastWithUndo(sentTo === 1 ? 'Snap sent' : 'Snap sent to ' + sentTo + ' friends', async function () {
                try { await db.collection('quickSnaps').doc(doc.id).delete(); } catch (e) { /* ignore */ }
                toast.hidden = true;
            });
        } catch (err) {
            console.warn('[quicksnap] send:', err && err.message);
            showMsg('That did not send. Check your connection and try again.');
        } finally {
            busy = false;
            shutter.disabled = false;
        }
    }

    /* ── recipients ─────────────────────────────────────────────── */

    function openPicker() {
        picker.hidden = false;
        pickerSearch.value = '';
        renderPicker('');
        $('qsCloseCount').textContent = closeFriends.length ? closeFriends.length : 'none yet';
    }

    function renderPicker(filter) {
        var q = String(filter || '').toLowerCase();
        var rows = members.filter(function (m) { return !q || m.name.toLowerCase().indexOf(q) > -1; });
        pickerList.innerHTML = rows.length ? rows.map(function (m) {
            var on = picked.indexOf(m.uid) > -1;
            return '<button class="qs-pick' + (on ? ' is-on' : '') + '" type="button" data-uid="' + esc(m.uid) + '">' +
                '<span class="qs-pick-ava">' +
                (m.photo ? '<img src="' + esc(m.photo) + '" alt="" referrerpolicy="no-referrer">' : esc(initials(m.name))) +
                '</span><span class="qs-pick-name">' + esc(m.name) + '</span>' +
                '<span class="qs-pick-check"><i class="fas fa-check"></i></span></button>';
        }).join('') : '<p class="qs-col-empty">No friends match that name.</p>';
        refreshBadges();
    }

    function togglePick(uid) {
        var at = picked.indexOf(uid);
        if (at > -1) picked.splice(at, 1); else if (picked.length < CFG.maxRecipients) picked.push(uid);
        pickedIsClose = false;
        renderPicker(pickerSearch.value);
        updateSendLabel();
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
                '<span>' + esc(ago(s.createdAt)) + '</span>' +
                '<i class="qs-thumb-seen">' + s.viewedBy.length + '/' + s.recipients.length + '</i></button>';
        }).join('');
    }

    /* ── the ribbon above conversations ─────────────────────────── */

    function renderRibbon() {
        var rail = document.getElementById('qsRibbon');
        if (!rail || !me) return;
        var latest = {};
        received.forEach(function (s) {
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
                return '<button class="qs-rail-item" type="button" data-uid="' + esc(s.ownerUid) + '">' +
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
        openCamera();
        renderRibbon();
        loadReceived();
    }

    function closeCard() {
        clearTimeout(viewedTimer);
        stopStream();
        if (pendingURL) { URL.revokeObjectURL(pendingURL); pendingURL = null; }
        pendingBlob = null;
        picked = [];
        pickedIsClose = false;
        captionInput.value = '';
        picker.hidden = true;
        view.hidden = true;
        view.classList.remove('is-open');
        lock(false);
        current = null;
        inboxFilter = '';
        refreshFab();
        renderRibbon();
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

        await Promise.all([loadMembers(), loadCloseFriends()]);
        await loadReceived();
        refreshFab();
        renderRibbon();
        if (boot.polling) return;
        boot.polling = true;
        setInterval(async function () {
            if (!me) return;
            await loadReceived();
            renderRibbon();
            if (!view.hidden && mode === 'inbox') renderInbox();
        }, 60000);
    }

    firebase.auth().onAuthStateChanged(boot);

    fab.addEventListener('click', openCard);
    $('qsClose').addEventListener('click', closeCard);
    backBtn.addEventListener('click', function () {
        if (mode === 'viewer') {
            if (backTo === 'archive') { openArchive(); } else { openInbox(inboxFilter); }
        } else {
            openCamera();
        }
    });

    $('qsFlip').addEventListener('click', function () {
        facing = facing === 'user' ? 'environment' : 'user';
        startStream();
    });
    retake.addEventListener('click', openCamera);
    $('qsInboxCam').addEventListener('click', openCamera);
    $('qsInboxBtn').addEventListener('click', function () { openInbox(''); });
    $('qsInboxArchive').addEventListener('click', openArchive);
    $('qsSelectFriends').addEventListener('click', openPicker);
    $('qsFriendsBtn').addEventListener('click', openPicker);

    shutter.addEventListener('click', function () {
        if (pendingBlob) sendSnap(); else shoot();
    });

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

    inboxList.addEventListener('click', function (ev) {
        var row = ev.target.closest('.qs-inbox-item');
        if (!row) return;
        var snap = received.filter(function (s) { return s.id === row.dataset.id; })[0];
        if (snap) openViewer(snap, false);
    });

    archiveGrid.addEventListener('click', function (ev) {
        var b = ev.target.closest('.qs-thumb');
        if (!b) return;
        var snap = archive.filter(function (s) { return s.id === b.dataset.id; })[0];
        if (snap) openViewer(snap, true);
    });

    pickerList.addEventListener('click', function (ev) {
        var b = ev.target.closest('.qs-pick');
        if (b) togglePick(b.dataset.uid);
    });
    pickerSearch.addEventListener('input', function () { renderPicker(pickerSearch.value); });
    $('qsPickerBack').addEventListener('click', function () { picker.hidden = true; });
    $('qsPickerDone').addEventListener('click', function () { picker.hidden = true; updateSendLabel(); });
    $('qsCloseFriends').addEventListener('click', async function () {
        if (!closeFriends.length) {
            if (!picked.length) { showMsg('Pick the friends you want to keep close, then tap Close Friends again.'); return; }
            await saveCloseFriends(picked.slice());
            showMsg('Close Friends saved — ' + closeFriends.length);
            $('qsCloseCount').textContent = closeFriends.length;
            return;
        }
        picked = closeFriends.slice();
        pickedIsClose = true;
        renderPicker(pickerSearch.value);
        updateSendLabel();
        showMsg('Sending to Close Friends');
    });

    document.addEventListener('keydown', function (ev) {
        if (view.hidden || ev.key !== 'Escape') return;
        if (!picker.hidden) { picker.hidden = true; return; }
        if (mode === 'viewer') { backBtn.click(); return; }
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
            zoomIn();
            lock(true);
            openInbox(rail.dataset.uid);
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
        openInbox: openInbox,
        refresh: async function () { await loadReceived(); renderRibbon(); refreshFab(); }
    };
})();
