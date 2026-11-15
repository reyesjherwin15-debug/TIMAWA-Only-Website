/* ================================================================
   freedom-wall.js — the bulletin board on index.html.

   • anyone (visitor or member) can pin a note: 100 characters and an
     optional photo, taken from the gallery or with the quick-snap camera
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
        maxNotes: 40,
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
    var modal = document.getElementById('fwModal');
    var form = document.getElementById('fwForm');
    var area = document.getElementById('fwText');
    var counterEl = document.getElementById('fwCounter');
    var nameWrap = document.getElementById('fwNameWrap');
    var nameInput = document.getElementById('fwName');
    var postBtn = document.getElementById('fwPost');
    var msgEl = document.getElementById('fwMsg');
    var fileInput = document.getElementById('fwFile');
    var shotBtn = document.getElementById('fwShot');
    var pickBtn = document.getElementById('fwPick');
    var preview = document.getElementById('fwPreview');
    var previewImg = document.getElementById('fwPreviewImg');
    var previewX = document.getElementById('fwPreviewX');
    var viewModal = document.getElementById('fwView');
    var viewBody = document.getElementById('fwViewBody');
    var viewImg = document.getElementById('fwViewImg');
    var viewMeta = document.getElementById('fwViewMeta');
    var snap = document.getElementById('fwSnap');
    var snapVideo = document.getElementById('fwSnapVideo');
    var snapShutter = document.getElementById('fwShutter');
    var snapClose = document.getElementById('fwSnapClose');
    var snapFlip = document.getElementById('fwSnapFlip');
    var snapMsg = document.getElementById('fwSnapMsg');
    var snapStage = document.getElementById('fwSnapStage');

    var db = null;
    try { db = firebase.app().firestore(); } catch (e) { db = null; }

    var me = null;
    var notes = [];
    var unsubscribe = null;
    var pending = null;
    var loadError = false;          // id of the note just posted (for the pin-drop animation)
    var pendingImage = null;     // File waiting to be uploaded
    var busy = false;
    var snapStream = null;
    var snapFacing = 'user';
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
        if (modal.hidden && viewModal.hidden && snap.hidden) lockScroll(false);
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
    }

    /* ── the board ───────────────────────────────────────────────── */

    function noteMarkup(n) {
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
        if (countEl) countEl.textContent = live.length;
        document.querySelectorAll('.fw-ago[data-at]').forEach(function (el) {
            el.textContent = ago(Number(el.dataset.at) || 0);
        });
    }

    function bindBoard() {
        notesEl.addEventListener('click', function (ev) {
            var tile = ev.target.closest('.fw-add');
            if (tile) { openComposer(); return; }
            var note = ev.target.closest('.fw-note');
            if (note) openView(note.dataset.id);
        });
        if (addBtn) addBtn.addEventListener('click', openComposer);
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
            .limit(CFG.maxNotes)
            .onSnapshot(function (snap) {
                loadError = false;
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
            ? (me.displayName || (me.email ? me.email.split('@')[0] : 'Member'))
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
                authorPhoto: (me && me.photoURL) ? me.photoURL : '',
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

    function openView(id) {
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

        var ava = n.authorPhoto
            ? '<img class="fw-ava" src="' + esc(n.authorPhoto) + '" alt="" referrerpolicy="no-referrer">'
            : '<span class="fw-ava">' + esc(initials(n.authorName)) + '</span>';
        var left = n.expiresAt ? Math.max(0, Math.ceil((n.expiresAt - Date.now()) / 86400000)) : CFG.ttlDays;
        var del = (me && n.authorUid && me.uid === n.authorUid)
            ? '<button type="button" class="fw-view-del" id="fwDelete">Remove</button>' : '';

        viewMeta.innerHTML = ava +
            '<span><b>' + esc(n.authorName || 'Guest') + '</b><br>' + ago(n.createdAt) + ' ago · ' +
            (left > 0 ? left + ' day' + (left === 1 ? '' : 's') + ' left' : 'fading') + '</span>' + del;

        var delBtn = document.getElementById('fwDelete');
        if (delBtn) delBtn.addEventListener('click', function () { removeNote(n); });

        openSheet(viewModal);
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

    /* ── quick snap ──────────────────────────────────────────────── */

    function snapSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function openSnap() {
        if (!snapSupported()) {
            toast('This browser cannot open the camera — use Gallery.');
            return;
        }
        snap.hidden = false;
        lockScroll(true);
        snapMsg.textContent = '';
        startCamera();
    }

    function startCamera() {
        stopCamera();
        var wanted = {
            audio: false,
            video: { facingMode: snapFacing, width: { ideal: 1280 }, height: { ideal: 960 } }
        };
        navigator.mediaDevices.getUserMedia(wanted).then(function (stream) {
            snapStream = stream;
            snapStage.dataset.facing = snapFacing;
            snapVideo.srcObject = stream;
            var p = snapVideo.play();
            if (p && p.catch) p.catch(function () { /* autoplay guard */ });
        }).catch(function (err) {
            console.warn('[freedom wall] camera', err);
            snapMsg.textContent = 'No camera access. You can still pick a photo from the gallery.';
        });
    }

    function stopCamera() {
        if (snapStream) {
            snapStream.getTracks().forEach(function (t) { t.stop(); });
            snapStream = null;
        }
        snapVideo.srcObject = null;
    }

    function closeSnap() {
        stopCamera();
        snap.hidden = true;
        if (modal.hidden && viewModal.hidden) lockScroll(false);
    }

    function takeShot() {
        if (!snapStream || !snapVideo.videoWidth) {
            snapMsg.textContent = 'Hold on — the camera is still waking up.';
            return;
        }
        var w = snapVideo.videoWidth;
        var h = snapVideo.videoHeight;
        var scale = Math.min(1, 1600 / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        var ctx = c.getContext('2d');
        if (snapFacing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(snapVideo, 0, 0, c.width, c.height);
        c.toBlob(function (b) {
            if (!b) { snapMsg.textContent = 'That snap did not save — try again.'; return; }
            var file = new File([b], 'snap.jpg', { type: 'image/jpeg' });
            closeSnap();
            setImage(file);
        }, 'image/jpeg', 0.86);
    }

    /* ── wiring ──────────────────────────────────────────────────── */

    if (area) area.addEventListener('input', updateCounter);
    if (form) form.addEventListener('submit', submit);
    if (fileInput) fileInput.addEventListener('change', function () { setImage(fileInput.files && fileInput.files[0]); });
    if (pickBtn) pickBtn.addEventListener('click', function () { fileInput.click(); });
    if (shotBtn) {
        if (snapSupported()) shotBtn.addEventListener('click', openSnap);
        else shotBtn.hidden = true;
    }
    if (previewX) previewX.addEventListener('click', clearImage);
    if (snapShutter) snapShutter.addEventListener('click', takeShot);
    if (snapClose) snapClose.addEventListener('click', closeSnap);
    if (snapFlip) snapFlip.addEventListener('click', function () {
        snapFacing = snapFacing === 'user' ? 'environment' : 'user';
        startCamera();
    });
    if (snap) snap.addEventListener('click', function (ev) { if (ev.target === snap) closeSnap(); });

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
        if (!snap.hidden) { closeSnap(); return; }
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
            if (nameWrap) nameWrap.hidden = !!me;
        });
    } catch (e) { /* visitors without auth still see the wall */ }

    bindBoard();
    render();          // the add tile is there the moment the section paints
    load();
})();
