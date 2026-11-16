/* ================================================================
   freedom-wall.js — the bulletin board on index.html.

   • anyone (visitor or member) can pin a note: 100 characters and an
     optional photo, from the gallery
   • every note carries expiresAt = now + 14 days; the page hides expired
     notes at once and tools/cloudinary_cleanup.py removes the document and
     its Cloudinary file on its next run
   • no libraries, no images of its own: notes are DOM + CSS, the photos go
     to the same unsigned Cloudinary preset the rest of the site uses
   ================================================================ */
(function () {
    'use strict';

    var CFG = {
        ttlDays: 14,
        pageSize: 30,
        charLimit: 100,
        cloudName: 'ooq99nlw',
        uploadPreset: 't-imawa',
        folder: 't-imawa/freedom',
        maxUploadBytes: 8 * 1024 * 1024,
        shrinkOver: 500 * 1024,
        shrinkTo: 1280
    };

    var board = document.getElementById('fwBoard');
    if (!board) return;

    var notesEl = document.getElementById('fwNotes');
    var emptyEl = document.getElementById('fwEmpty');
    var addBtn = document.getElementById('fwAdd');
    var countEl = document.getElementById('fwCount');
    var moreBtn = document.getElementById('fwMore');
    var modal = document.getElementById('fwModal');
    var form = document.getElementById('fwForm');
    var area = document.getElementById('fwText');
    var counterEl = document.getElementById('fwCounter');
    var nameWrap = document.getElementById('fwNameWrap');
    var nameInput = document.getElementById('fwName');
    var postBtn = document.getElementById('fwPost');
    var msgEl = document.getElementById('fwMsg');
    var fileInput = document.getElementById('fwFile');
    var pickBtn = document.getElementById('fwPick');
    var preview = document.getElementById('fwPreview');
    var previewImg = document.getElementById('fwPreviewImg');
    var previewX = document.getElementById('fwPreviewX');
    var viewModal = document.getElementById('fwView');
    var viewBody = document.getElementById('fwViewBody');
    var viewImg = document.getElementById('fwViewImg');
    var viewMeta = document.getElementById('fwViewMeta');

    var db = null;
    try { db = firebase.app().firestore(); } catch (e) { db = null; }

    var me = null;
    var notes = [];
    var shown = CFG.pageSize;      // how many notes the listener is asked for
    var profile = null;            // the signed-in member's name + photo
    var lift = null;               // the note currently lifted off the board
    var people = {};               // uid -> { name, photo } | null while it loads
    var unsubscribe = null;
    var pending = null;
    var loadError = false;          // id of the note just posted (for the pin-drop animation)
    var pendingImage = null;     // File waiting to be uploaded
    var busy = false;
    var lastFocus = null;

    /* ── helpers ─────────────────────────────────────────────────── */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function hash(s) {
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        return h;
    }

    function thumb(url) {
        if (!url || url.indexOf('res.cloudinary.com') < 0 || url.indexOf('/upload/') < 0) return url;
        var after = url.split('/upload/')[1] || '';
        if (/^[a-z]_/.test(after) || /^[a-z]+,[a-z]/.test(after)) return url;
        return url.replace('/upload/', '/upload/w_360,h_360,c_fill,q_auto:good,f_auto/');
    }

    function ago(ms) {
        if (!ms) return 'now';
        var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (s < 60) return 'now';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        if (s < 86400) return Math.floor(s / 3600) + 'h';
        return Math.floor(s / 86400) + 'd';
    }

    function initials(name) {
        var parts = String(name || 'G').trim().split(/\s+/);
        return ((parts[0] || 'G')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }

    function toast(text) {
        if (typeof window.showToast === 'function') { try { window.showToast(text); return; } catch (e) { /* fall through */ } }
        var host = document.getElementById('toastStack');
        if (!host) return;
        var el = document.createElement('div');
        el.className = 'toast';
        el.textContent = text;
        host.appendChild(el);
        setTimeout(function () { el.remove(); }, 3200);
    }

    function setMsg(text) {
        if (!msgEl) return;
        msgEl.textContent = text || '';
        msgEl.classList.toggle('is-on', !!text);
    }

    function lockScroll(on) {
        document.documentElement.style.overflow = on ? 'hidden' : '';
    }

    function openSheet(el) {
        lastFocus = document.activeElement;
        el.hidden = false;
        lockScroll(true);
    }

    function closeSheet(el) {
        el.hidden = true;
        if (el === viewModal) restoreLift();
        if (modal.hidden && viewModal.hidden) lockScroll(false);
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
    }

    /* ── who pinned it ───────────────────────────────────────────── */

    // A member's live public card wins over whatever the note stored, so a new
    // profile photo shows on old notes too. Guests keep their typed name.
    function personOf(n) {
        var card = (!n.isGuest && n.authorUid) ? people[n.authorUid] : null;
        return {
            name: (card && card.name) || n.authorName || 'Guest',
            photo: (card && card.photo) || n.authorPhoto || ''
        };
    }

    function paintPerson(uid) {
        var card = people[uid];
        if (!card) return;
        notesEl.querySelectorAll('.fw-note[data-uid="' + uid + '"]').forEach(function (el) {
            var nameEl = el.querySelector('.fw-name');
            if (nameEl && card.name) nameEl.textContent = card.name;
            var ava = el.querySelector('.fw-ava');
            if (!card.photo || !ava) return;
            if (ava.tagName === 'IMG') { if (ava.src !== card.photo) ava.src = card.photo; return; }
            var img = document.createElement('img');
            img.className = 'fw-ava';
            img.src = card.photo;
            img.alt = '';
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            ava.replaceWith(img);
        });
    }

    function hydratePeople(list) {
        if (!db) return;
        var asked = 0;
        list.forEach(function (n) {
            if (!n.authorUid || n.isGuest) return;
            if (people[n.authorUid] !== undefined) return;
            if (asked >= 25) return;                  // stay polite on a busy wall
            asked++;
            people[n.authorUid] = null;               // in flight
            db.collection('publicProfiles').doc(n.authorUid).get().then(function (doc) {
                var d = doc.exists ? (doc.data() || {}) : {};
                people[n.authorUid] = { name: d.displayName || '', photo: d.photoURL || '' };
                paintPerson(n.authorUid);
            }).catch(function () {
                people[n.authorUid] = { name: '', photo: '' };
            });
        });
    }

    /* ── the board ───────────────────────────────────────────────── */

    function noteMarkup(n) {
        var who = personOf(n);
        n = Object.assign({}, n, { authorName: who.name, authorPhoto: who.photo });
        var h = hash(n.id);
        var rot = ((h % 61) / 10) - 3;              // -3.0 … 3.0
        var delay = ((h >> 5) % 40) / 10;            // 0 … 3.9s
        var sway = 8 + ((h >> 9) % 5);               // 8 … 12s
        var colour = (h % 6) + 1;
        var name = n.authorName || 'Guest';
        var ava = n.authorPhoto
            ? '<img class="fw-ava" src="' + esc(n.authorPhoto) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
            : '<span class="fw-ava">' + esc(initials(name)) + '</span>';
        var img = n.imageUrl
            ? '<span class="fw-thumb" style="background-image:url(' + esc(thumb(n.imageUrl)) + ')"></span>'
            : '';
        return '<button type="button" class="fw-note' + (n.imageUrl ? ' has-img' : '') + '"' +
            ' data-id="' + esc(n.id) + '" data-c="' + colour + '"' +
            (n.authorUid && !n.isGuest ? ' data-uid="' + esc(n.authorUid) + '"' : '') +
            ' style="--rot:' + rot.toFixed(1) + 'deg;--delay:' + delay.toFixed(1) + 's;--sway:' + sway + 's"' +
            ' aria-label="Note by ' + esc(name) + ': ' + esc(n.text) + '">' +
            '<span class="fw-pin" aria-hidden="true"></span>' +
            '<span class="fw-who">' + ava + '<span class="fw-name">' + esc(name) + '</span></span>' +
            '<span class="fw-text">' + esc(n.text) + '</span>' +
            img +
            '<span class="fw-ago" data-at="' + (n.createdAt || 0) + '">' + ago(n.createdAt) + '</span>' +
            '</button>';
    }

    function render() {
        var live = notes.filter(function (n) { return !n.expiresAt || n.expiresAt > Date.now(); });
        var ids = live.map(function (n) { return n.id; }).join(',');

        if (notesEl.dataset.ids !== ids) {
            notesEl.dataset.ids = ids;
            var html = live.map(noteMarkup).join('');
            html += '<button type="button" class="fw-add" id="fwAddTile" aria-label="Pin a note">' +
                '<span class="fw-add-plus" aria-hidden="true">+</span><span>Pin a note</span></button>';
            notesEl.innerHTML = html;

            if (pending) {
                var fresh = notesEl.querySelector('[data-id="' + pending + '"]');
                if (fresh) {
                    fresh.classList.add('is-new');
                    setTimeout(function () { fresh.classList.remove('is-new'); }, 900);
                }
                pending = null;
            }
        }

        notesEl.classList.toggle('is-solo', live.length === 0);

        if (emptyEl) {
            var showEmpty = live.length === 0;
            emptyEl.hidden = !showEmpty;
            if (showEmpty) {
                var line = loadError
                    ? 'The wall is warming up — notes will appear here in a moment.'
                    : 'Nothing pinned yet — be the first to leave something on the wall.';
                if (emptyEl.textContent !== line) emptyEl.textContent = line;
            }
        }
        hydratePeople(live);
        if (countEl) countEl.textContent = live.length;
        document.querySelectorAll('.fw-ago[data-at]').forEach(function (el) {
            el.textContent = ago(Number(el.dataset.at) || 0);
        });
    }

    function loadMemberProfile(u) {
        if (!u) { profile = null; return; }
        profile = {
            name: u.displayName || (u.email ? u.email.split('@')[0] : 'Member'),
            photo: u.photoURL || ''
        };
        if (!db) return;
        db.collection('users').doc(u.uid).get().then(function (doc) {
            if (!doc.exists || me !== u) return;
            var d = doc.data() || {};
            if (d.displayName) profile.name = d.displayName;
            if (d.photoURL) profile.photo = d.photoURL;
        }).catch(function () { /* the auth record is enough */ });
    }

    /* ── take a note off the board, put it back ───────────────────── */

    function reduceMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function liftNote(el) {
        if (!el || reduceMotion() || !el.animate) return;
        var r = el.getBoundingClientRect();
        var clone = el.cloneNode(true);
        clone.className = 'fw-note fw-lift';
        clone.removeAttribute('aria-label');
        clone.style.position = 'fixed';
        clone.style.margin = '0';
        clone.style.left = r.left + 'px';
        clone.style.top = r.top + 'px';
        clone.style.width = r.width + 'px';
        clone.style.height = r.height + 'px';
        clone.style.zIndex = '80';
        clone.style.pointerEvents = 'none';
        document.body.appendChild(clone);
        el.classList.add('is-lifting');

        var dx = window.innerWidth / 2 - (r.left + r.width / 2);
        var dy = Math.min(window.innerHeight * 0.4, 320) - (r.top + r.height / 2);

        clone.animate([
            { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1, boxShadow: '0 8px 16px rgba(52,30,8,.22)' },
            { transform: 'translate(' + (dx * .6) + 'px,' + (dy * .7) + 'px) rotate(4.5deg) scale(1.18)', opacity: 1, offset: .72 },
            { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(2deg) scale(1.26)', opacity: .96, boxShadow: '0 30px 64px rgba(20,12,4,.42)' }
        ], { duration: 330, easing: 'cubic-bezier(.2,.86,.24,1)', fill: 'forwards' });

        lift = { el: el, clone: clone, rect: r, dx: dx, dy: dy };
    }

    function settleLift() {
        if (!lift || !lift.clone) return;
        try {
            lift.clone.animate([{ opacity: .96 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
        } catch (e) { lift.clone.style.opacity = '0'; }
    }

    function restoreLift() {
        if (!lift) return;
        var l = lift;
        lift = null;
        l.el.classList.remove('is-lifting');
        if (!l.clone) return;
        var clone = l.clone;
        if (reduceMotion()) { clone.remove(); return; }
        clone.animate([
            { transform: 'translate(' + l.dx + 'px,' + l.dy + 'px) rotate(2deg) scale(1.26)', opacity: .96 },
            { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 }
        ], { duration: 300, easing: 'cubic-bezier(.3,.8,.2,1)', fill: 'forwards' }).onfinish = function () { clone.remove(); };
    }

    /* members' pins ring the bell everywhere: an announcement the push
       dispatcher turns into a real notification (guests stay local) */
    function announceNote(id, text) {
        if (!me || !db) return;
        var name = (profile && profile.name) || me.displayName || 'A member';
        db.collection('announcements').add({
            type: 'freedom',
            title: '\uD83D\uDCCC ' + name + ' pinned a note',
            message: '"' + String(text).slice(0, 90) + '"',
            icon: '\uD83D\uDCCC',
            actorUid: me.uid,
            actorName: name,
            actorPhoto: (profile && profile.photo) || '',
            priority: 'info',
            link: 'index.html#freedom-wall',
            linkLabel: 'Read the wall',
            pushUrl: 'index.html#freedom-wall',
            pushContext: 'freedom',
            pushPending: true,
            targetUid: '',
            referenceId: 'freedom_' + id,
            readBy: [],
            createdBy: 'system',
            createdByName: 'System',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 7 * 86400000)
        }).catch(function () { /* the note is pinned either way */ });
    }

    function bindBoard() {
        notesEl.addEventListener('click', function (ev) {
            var tile = ev.target.closest('.fw-add');
            if (tile) { openComposer(); return; }
            var note = ev.target.closest('.fw-note');
            if (note) openView(note.dataset.id, note);
        });
        if (addBtn) addBtn.addEventListener('click', openComposer);
        if (moreBtn) moreBtn.addEventListener('click', function () {
            shown += CFG.pageSize;
            load();
        });
    }

    function load() {
        if (!db) {
            loadError = true;
            render();
            return;
        }
        if (unsubscribe) unsubscribe();
        unsubscribe = db.collection('freedomNotes')
            .orderBy('createdAt', 'desc')
            .limit(shown)
            .onSnapshot(function (snap) {
                loadError = false;
                if (moreBtn) moreBtn.hidden = snap.size < shown;
                notes = snap.docs.map(function (d) {
                    var v = d.data() || {};
                    return {
                        id: d.id,
                        text: v.text || '',
                        imageUrl: v.imageUrl || '',
                        imagePublicId: v.imagePublicId || '',
                        authorUid: v.authorUid || '',
                        authorName: v.authorName || 'Guest',
                        authorPhoto: v.authorPhoto || '',
                        isGuest: !!v.isGuest,
                        createdAt: v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : 0,
                        expiresAt: v.expiresAt && v.expiresAt.toMillis ? v.expiresAt.toMillis() : 0
                    };
                });
                render();
            }, function (err) {
                console.warn('[freedom wall]', err && err.code, err && err.message);
                loadError = true;
                notes = [];
                render();
            });
    }

    /* ── composer ────────────────────────────────────────────────── */

    function openComposer() {
        if (typeof start === 'function') start();
        if (!db) { toast('The wall is not ready yet.'); return; }
        setMsg('');
        nameWrap.hidden = !!me;
        if (!me) {
            nameInput.value = localStorage.getItem('fw_guest_name') || '';
        }
        updateCounter();
        openSheet(modal);
        setTimeout(function () { area.focus(); }, 60);
    }

    function closeComposer() {
        closeSheet(modal);
        clearImage();
        area.value = '';
        updateCounter();
    }

    function updateCounter() {
        var n = area.value.length;
        counterEl.innerHTML = '<span>Pinned for 14 days</span><span><b>' + n + '</b>/' + CFG.charLimit + '</span>';
        counterEl.classList.toggle('is-near', n >= CFG.charLimit - 15);
        postBtn.disabled = busy || n === 0;
    }

    function clearImage() {
        pendingImage = null;
        preview.classList.remove('is-on');
        previewImg.removeAttribute('src');
        if (fileInput) fileInput.value = '';
    }

    function setImage(file) {
        if (!file) return;
        if (file.size > CFG.maxUploadBytes) {
            setMsg('That photo is a little heavy — pick one under 8 MB.');
            return;
        }
        pendingImage = file;
        previewImg.src = URL.createObjectURL(file);
        preview.classList.add('is-on');
        setMsg('');
    }

    /* shrink big photos before they ever leave the phone */
    function prepare(file) {
        if (!file || file.type.indexOf('image/') !== 0) return Promise.resolve(file);
        if (file.size < CFG.shrinkOver) return Promise.resolve(file);
        return new Promise(function (resolve) {
            var img = new Image();
            var url = URL.createObjectURL(file);
            var done = function (out) { URL.revokeObjectURL(url); resolve(out || file); };
            img.onload = function () {
                var scale = Math.min(1, CFG.shrinkTo / Math.max(img.width, img.height));
                var c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(img.width * scale));
                c.height = Math.max(1, Math.round(img.height * scale));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                if (c.toBlob) {
                    c.toBlob(function (b) {
                        done(b ? new File([b], 'note.jpg', { type: 'image/jpeg' }) : null);
                    }, 'image/jpeg', 0.84);
                } else { done(null); }
            };
            img.onerror = function () { done(null); };
            img.src = url;
        });
    }

    function upload(file) {
        var fd = new FormData();
        fd.append('file', file);
        fd.append('upload_preset', CFG.uploadPreset);
        fd.append('folder', CFG.folder);
        return fetch('https://api.cloudinary.com/v1_1/' + CFG.cloudName + '/image/upload', {
            method: 'POST', body: fd
        }).then(function (r) {
            if (!r.ok) throw new Error('upload-failed');
            return r.json();
        }).then(function (j) {
            if (!j || !j.secure_url) throw new Error('upload-failed');
            return { url: j.secure_url, publicId: j.public_id || '' };
        });
    }

    function submit(ev) {
        if (ev) ev.preventDefault();
        if (busy) return;
        var text = area.value.trim().slice(0, CFG.charLimit);
        if (!text) { setMsg('Write something first — even one word.'); return; }

        var name = me
            ? ((profile && profile.name) || me.displayName || (me.email ? me.email.split('@')[0] : 'Member'))
            : (nameInput.value.trim() || 'Guest');

        if (!me) {
            if (name.length > 40) name = name.slice(0, 40);
            localStorage.setItem('fw_guest_name', name);
        }

        busy = true;
        postBtn.disabled = true;
        postBtn.textContent = pendingImage ? 'Posting photo…' : 'Pinning…';
        setMsg('');

        var chain = pendingImage ? prepare(pendingImage).then(upload) : Promise.resolve(null);

        chain.then(function (media) {
            var now = new Date();
            return db.collection('freedomNotes').add({
                text: text,
                imageUrl: media ? media.url : '',
                imagePublicId: media ? media.publicId : '',
                authorUid: me ? me.uid : '',
                authorName: name,
                authorPhoto: (me && profile && profile.photo) ? profile.photo : ((me && me.photoURL) ? me.photoURL : ''),
                isGuest: !me,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                expiresAt: firebase.firestore.Timestamp.fromDate(
                    new Date(now.getTime() + CFG.ttlDays * 86400000))
            });
        }).then(function (ref) {
            pending = ref.id;
            busy = false;
            postBtn.textContent = 'Pin it';
            closeComposer();
            toast('Pinned — it stays up for 14 days.');
            announceNote(ref.id, text);
            if (board) {
                board.classList.remove('is-thumped');
                void board.offsetWidth;
                board.classList.add('is-thumped');
                setTimeout(function () { board.classList.remove('is-thumped'); }, 620);
            }
            var first = notesEl.querySelector('.fw-note');
            if (first && board.getBoundingClientRect().top < 0) {
                board.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }).catch(function (err) {
            busy = false;
            postBtn.textContent = 'Pin it';
            postBtn.disabled = area.value.trim().length === 0;
            console.warn('[freedom wall] post failed', err);
            setMsg('That did not go through. Check your connection and try again.');
        });
    }

    /* ── one note, opened ────────────────────────────────────────── */

    function openView(id, el) {
        var n = null;
        for (var i = 0; i < notes.length; i++) if (notes[i].id === id) n = notes[i];
        if (!n) return;

        viewBody.textContent = n.text;
        if (n.imageUrl) {
            viewImg.src = n.imageUrl;
            viewImg.hidden = false;
        } else {
            viewImg.removeAttribute('src');
            viewImg.hidden = true;
        }

        var who = personOf(n);
        var ava = who.photo
            ? '<img class="fw-ava" src="' + esc(who.photo) + '" alt="" referrerpolicy="no-referrer">'
            : '<span class="fw-ava">' + esc(initials(who.name)) + '</span>';
        var left = n.expiresAt ? Math.max(0, Math.ceil((n.expiresAt - Date.now()) / 86400000)) : CFG.ttlDays;
        var del = (me && n.authorUid && me.uid === n.authorUid)
            ? '<button type="button" class="fw-view-del" id="fwDelete">Remove</button>' : '';

        viewMeta.innerHTML = ava +
            '<span><b>' + esc(who.name || 'Guest') + '</b><br>' + ago(n.createdAt) + ' ago · ' +
            (left > 0 ? left + ' day' + (left === 1 ? '' : 's') + ' left' : 'fading') + '</span>' + del;

        var delBtn = document.getElementById('fwDelete');
        if (delBtn) delBtn.addEventListener('click', function () { removeNote(n); });

        liftNote(el);
        if (!lift) { openSheet(viewModal); return; }
        lockScroll(true);
        setTimeout(function () {
            openSheet(viewModal);
            setTimeout(settleLift, 300);
        }, 180);
    }

    function removeNote(n) {
        if (!me || n.authorUid !== me.uid) return;
        db.collection('freedomNotes').doc(n.id).delete().then(function () {
            if (n.imagePublicId) {
                return db.collection('mediaCleanupQueue').add({
                    publicId: n.imagePublicId,
                    resourceType: 'image',
                    source: 'freedom',
                    sourceId: n.id,
                    status: 'pending',
                    attempts: 0,
                    requestedBy: me.uid,
                    requestedAt: firebase.firestore.FieldValue.serverTimestamp()
                }).catch(function () { /* the sweep will still find it */ });
            }
        }).then(function () {
            closeSheet(viewModal);
            toast('Note removed.');
        }).catch(function () {
            toast('Could not remove that note.');
        });
    }

    /* ── wiring ──────────────────────────────────────────────────── */

    if (area) area.addEventListener('input', updateCounter);
    if (form) form.addEventListener('submit', submit);
    if (fileInput) fileInput.addEventListener('change', function () { setImage(fileInput.files && fileInput.files[0]); });
    if (pickBtn) pickBtn.addEventListener('click', function () { fileInput.click(); });
    if (previewX) previewX.addEventListener('click', clearImage);

    [modal, viewModal].forEach(function (m) {
        if (!m) return;
        m.addEventListener('click', function (ev) {
            if (ev.target === m) { m === modal ? closeComposer() : closeSheet(m); }
        });
        m.querySelectorAll('[data-fw-close]').forEach(function (b) {
            b.addEventListener('click', function () { m === modal ? closeComposer() : closeSheet(m); });
        });
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        if (!modal.hidden) { closeComposer(); return; }
        if (!viewModal.hidden) closeSheet(viewModal);
    });

    document.addEventListener('visibilitychange', function () {
        document.body.classList.toggle('fw-paused', document.hidden);
    });

    /* keep "2h ago" honest without waking the tab */
    setInterval(function () {
        if (document.hidden) return;
        document.querySelectorAll('.fw-ago[data-at]').forEach(function (el) {
            el.textContent = ago(Number(el.dataset.at) || 0);
        });
        notes = notes.filter(function (n) { return !n.expiresAt || n.expiresAt > Date.now(); });
    }, 120000);

    try {
        firebase.auth().onAuthStateChanged(function (u) {
            me = u || null;
            loadMemberProfile(me);
            if (nameWrap) nameWrap.hidden = !!me;
        });
    } catch (e) { /* visitors without auth still see the wall */ }

    bindBoard();
    render();          // the add tile is there the moment the section paints

    // Nothing is read until the board is close to the screen: a landing-page
    // visit should not open a Firestore listener it never looks at.
    var started = false;
    function start() {
        if (started) return;
        started = true;
        load();
    }
    function nearBoard() {
        var r = board.getBoundingClientRect();
        return r.top < window.innerHeight + 600 && r.bottom > -600;
    }
    if (nearBoard()) {
        start();
    } else {
        // Load when the wall is scrolled near. The scroll listener is the
        // safety net for browsers that throttle IntersectionObserver.
        var onScroll = function () {
            if (!nearBoard()) return;
            start();
            window.removeEventListener('scroll', onScroll);
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        if ('IntersectionObserver' in window) {
            var io = new IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].isIntersecting) { io.disconnect(); start(); return; }
                }
            }, { rootMargin: '600px' });
            io.observe(board);
        }
    }
})();
