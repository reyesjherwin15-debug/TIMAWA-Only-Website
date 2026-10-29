/* ================================================================
   notes-music.js · TIMAWA — songs on Notes + comment-thread helpers   (v1.0)
   Loaded by index.html and dashboard.html AFTER stories-shared.js.

   1) NoteMusic
      - "Add a song" row inside the Tita Tima note field and its own picker panel
        (search -> preview -> select). Same song search as Stories, but the clip is
        FIXED to the whole 30-second preview, so there is nothing else to configure.
      - A note can be text, a song, or both (text keeps the 60-character limit).
      - Note modal: music card that starts automatically and plays the 30 s once.
      - Firestore:  notes/{uid}.music = { provider, trackId, title, artist, thumbnail,
                    previewUrl, previewSec, startSec: 0, clipSec: previewSec }

   2) Threads  (notes replies + highlight comments)
      - Replies stay grouped under their top-level comment (replyToId = thread root)
        but now ALSO store the exact comment they answer:
          replyToCommentId, replyToUid, replyToName, replyToText
        so replying to a reply — or to yourself — always shows what it refers to.
      - Every comment (top-level or reply) has a Reply button.
   ================================================================ */
(function () {
    'use strict';
    if (window.NoteMusic) return;
    const S = () => window.StoriesShared;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const meUid = () => { try { const u = firebase.auth().currentUser; return u ? u.uid : null; } catch (e) { return null; } };

    // ------------------------------------------------------------ styles (theme tokens only)
    function injectStyles() {
        if (document.getElementById('nmStyles')) return;
        const st = document.createElement('style');
        st.id = 'nmStyles';
        st.textContent = `
        .nm-row{margin:10px 0 6px}
        .nm-add{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:14px;border:0;background:var(--theme-gradient,#1089d3);color:#fff;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;box-shadow:0 6px 16px color-mix(in srgb,var(--theme-primary,#1089d3) 32%,transparent);transition:transform .15s,box-shadow .15s}
        .nm-add:hover{transform:translateY(-1px);box-shadow:0 8px 20px color-mix(in srgb,var(--theme-primary,#1089d3) 42%,transparent)}
        .nm-add:active{transform:none}
        .nm-add .nm-addic{width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.22);display:grid;place-items:center;font-size:12px}
        .nm-add small{font-weight:600;opacity:.85;font-size:11.5px}
        .nm-chip{display:flex;align-items:center;gap:10px;padding:9px 10px;box-sizing:border-box;width:100%;border-radius:14px;border:1.5px solid color-mix(in srgb,var(--theme-primary,#1089d3) 35%,transparent);background:color-mix(in srgb,var(--theme-primary,#1089d3) 8%,var(--theme-card,#fff))}
        .nm-chip.nm-locked{border-style:dashed;opacity:.92}
        .nm-lockic{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;font-size:12px;background:color-mix(in srgb,var(--theme-text,#000) 8%,transparent);color:var(--theme-text-muted,#666)}
        .nm-locked-note{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:11px 13px;border-radius:14px;border:1.5px dashed var(--theme-border-input,#cbd5e1);background:color-mix(in srgb,var(--theme-text,#000) 4%,transparent);color:var(--theme-text-muted,#666);font-size:12.5px;line-height:1.35}
        .nm-locked-note i{color:var(--theme-text-dim,#94a3b8);flex:0 0 auto}
        .nm-locked-note b{color:var(--theme-text,#1a1a2e);font-weight:800}
        /* a live note is read-only until the member taps Replace note */
        #titaNote.nm-locked,.tita-note-editor.nm-locked input{background:color-mix(in srgb,var(--theme-text,#000) 6%,var(--theme-bg,#fff))!important;color:var(--theme-text-muted,#666)!important;cursor:default;-webkit-text-fill-color:var(--theme-text-muted,#666)}
        #titaNote.nm-locked:focus{outline:none;border-color:var(--theme-border-input,#cbd5e1)}
        .nm-art{width:42px;height:42px;border-radius:9px;object-fit:cover;flex:0 0 auto;background:#1db954}
        .nm-ph{width:42px;height:42px;border-radius:9px;flex:0 0 auto;background:var(--theme-gradient,#1089d3);display:grid;place-items:center;color:#fff;font-size:16px}
        .nm-meta{min-width:0;flex:1;line-height:1.3}
        .nm-meta b{display:block;font-size:13px;color:var(--theme-text,#1a1a2e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .nm-meta small{display:block;font-size:11.5px;color:var(--theme-text-muted,#666);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .nm-ib{width:32px;height:32px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;font-size:13px;flex:0 0 auto;background:var(--theme-primary-soft,#e0f2fe);color:var(--theme-primary,#1089d3)}
        .nm-ib.danger{background:#fee2e2;color:#dc2626}
        .nm-ib:focus-visible,.nm-add:focus-visible,.nm-btn:focus-visible{outline:2px solid var(--theme-primary,#1089d3);outline-offset:2px}
        .nm-replace{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;margin:10px 0 0;padding:9px 12px;border-radius:12px;border:1.5px solid var(--theme-border-input,#cbd5e1);background:var(--theme-bg-soft,transparent);color:var(--theme-text,#1a1a2e);cursor:pointer;font-family:inherit;text-align:left}
        .nm-replace:hover{border-color:var(--theme-primary,#1089d3);background:var(--theme-primary-soft,#e0f2fe)}
        .nm-replace .ic{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;background:var(--theme-primary-soft,#e0f2fe);color:var(--theme-primary,#1089d3);font-size:12px}
        .nm-replace b{display:block;font-size:13px}.nm-replace small{display:block;font-size:11.5px;color:var(--theme-text-muted,#666);margin-top:1px}
        .nm-replacing{display:flex;align-items:center;gap:10px;margin:10px 0 0;padding:10px 12px;border-radius:12px;border:1.5px solid #f59e0b;background:color-mix(in srgb,#f59e0b 12%,var(--theme-card,#fff));color:var(--theme-text,#1a1a2e)}
        .nm-replacing .ic{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;background:#fde68a;color:#b45309;font-size:12px}
        .nm-replacing .tx{flex:1;min-width:0;line-height:1.35}.nm-replacing b{display:block;font-size:13px}.nm-replacing small{display:block;font-size:11.5px;color:var(--theme-text-muted,#666)}
        .nm-replacing button{border:0;border-radius:10px;padding:7px 12px;font-weight:700;font-size:12.5px;cursor:pointer;font-family:inherit;background:var(--theme-bg-soft,#f3f4f6);color:var(--theme-text,#1a1a2e);flex:0 0 auto}
        .nm-replace:focus-visible,.nm-replacing button:focus-visible{outline:2px solid var(--theme-primary,#1089d3);outline-offset:2px}
        /* member note bubble with a song: title (pans when too long) / artist / text */
        .member-card .note-bubble.has-music,.member-card .member-note-bubble.has-music{align-items:center;gap:8px;border-radius:16px;padding:7px 12px;white-space:normal;text-overflow:clip}
        .member-card .has-music .nm-bi{font-size:13px;flex:0 0 auto}
        .member-card .has-music .nm-bub{display:flex;flex-direction:column;align-items:flex-start;min-width:0;width:max-content;max-width:min(170px,100%);line-height:1.25;text-align:left;overflow:hidden}
        .member-card .has-music .nm-bt{display:block;width:100%;overflow:hidden;white-space:nowrap;font-weight:800;font-size:12.5px;text-overflow:clip}
        .member-card .has-music .nm-marq{display:inline-block;white-space:nowrap;overflow:visible;text-overflow:clip}
        .member-card .has-music .nm-bt.pan .nm-marq{animation:nmPan var(--pan-t,6s) ease-in-out infinite alternate;will-change:transform}
        .member-card .has-music .nm-ba{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600;opacity:.8}
        .member-card .has-music .nm-bx{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;font-size:12px;font-weight:600;margin-top:2px;word-break:break-word;text-overflow:clip}
        @keyframes nmPan{0%,14%{transform:translateX(0)}86%,100%{transform:translateX(calc(var(--pan,0) * -1px))}}
        /* picker panel */
        .nm-ov{position:fixed;inset:0;z-index:10120;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit}
        .nm-bd{position:absolute;inset:0;background:rgba(8,8,14,.55);opacity:0;transition:opacity .18s}
        .nm-panel{position:relative;width:min(440px,100%);max-height:min(640px,92vh);display:flex;flex-direction:column;background:var(--theme-card,#fff);color:var(--theme-text,#1a1a2e);border:1px solid var(--theme-border,#eef2f7);border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.35);opacity:0;transform:translateY(14px) scale(.97);transition:transform .22s cubic-bezier(.22,.9,.28,1),opacity .18s;overflow:hidden}
        .nm-ov.in .nm-bd{opacity:1}.nm-ov.in .nm-panel{opacity:1;transform:none}
        .nm-h{display:flex;align-items:center;gap:10px;padding:14px 14px 10px}
        .nm-h b{flex:1;font-size:16px}
        .nm-btn{border:0;border-radius:12px;padding:9px 16px;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit;background:var(--theme-gradient,#1089d3);color:#fff}
        .nm-btn.ghost{background:var(--theme-primary-soft,#e0f2fe);color:var(--theme-primary,#1089d3)}
        .nm-btn.sm{padding:7px 12px;font-size:12.5px;border-radius:10px}
        .nm-body{overflow-y:auto;overscroll-behavior:contain;padding:0 14px 16px}
        .nm-sr{display:flex;gap:8px;margin:6px 0}
        .nm-sr input{flex:1;min-width:0;padding:11px 13px;border-radius:12px;border:1.5px solid var(--theme-border-input,#e0e7ff);background:var(--theme-bg,#fff);color:var(--theme-text,#1a1a2e);font-size:14px;font-family:inherit}
        .nm-sr input:focus{outline:none;border-color:var(--theme-primary,#1089d3)}
        .nm-msg{font-size:12.5px;color:var(--theme-text-dim,#888);margin:6px 2px}
        .nm-lab{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--theme-text-dim,#888);margin:10px 2px 6px}
        .nm-it{display:flex;align-items:center;gap:10px;padding:8px;border-radius:12px;margin-bottom:4px}
        .nm-it:hover{background:var(--theme-bg-soft,rgba(0,0,0,.03))}
        .nm-dur{font-size:11px;font-weight:700;color:var(--theme-primary,#1089d3);background:var(--theme-primary-soft,#e0f2fe);padding:3px 8px;border-radius:999px;flex:0 0 auto}
        @media (max-width:560px){.nm-ov{align-items:flex-end;padding:0}.nm-panel{width:100%;max-height:88vh;border-radius:22px 22px 0 0;transform:translateY(40px)}}
        /* music card inside the note modal / detail */
        .nm-card{display:flex;align-items:center;gap:12px;margin-top:12px;padding:10px 12px;border-radius:16px;border:1px solid color-mix(in srgb,var(--theme-primary,#1089d3) 30%,transparent);background:color-mix(in srgb,var(--theme-primary,#1089d3) 8%,var(--theme-card,#fff))}
        .nm-card .nm-art,.nm-card .nm-ph{width:50px;height:50px;border-radius:11px}
        .nm-card .nm-meta b{font-size:14px}
        .nm-prog{height:4px;border-radius:4px;background:color-mix(in srgb,var(--theme-text,#000) 12%,transparent);margin-top:7px;overflow:hidden}
        .nm-prog i{display:block;height:100%;width:0;background:var(--theme-gradient,#1089d3)}
        .nm-play{width:40px;height:40px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;font-size:15px;flex:0 0 auto;background:var(--theme-gradient,#1089d3);color:#fff}
        .nm-play:focus-visible{outline:2px solid var(--theme-primary,#1089d3);outline-offset:2px}
        .nm-eq{display:inline-flex;gap:2px;align-items:flex-end;height:12px;margin-left:6px;vertical-align:middle}
        .nm-eq i{width:3px;background:var(--theme-primary,#1089d3);border-radius:2px;animation:nmEq .8s ease-in-out infinite alternate}
        .nm-eq i:nth-child(2){animation-delay:-.3s}.nm-eq i:nth-child(3){animation-delay:-.6s}
        @keyframes nmEq{from{height:3px}to{height:12px}}
        /* comment threads: what a reply refers to */
        .reply-ref{display:flex;align-items:center;gap:6px;max-width:100%;margin:1px 0 4px;padding:3px 9px 3px 8px;border-left:3px solid color-mix(in srgb,var(--theme-primary,#1089d3) 55%,transparent);border-radius:4px 10px 10px 4px;background:color-mix(in srgb,var(--theme-primary,#1089d3) 7%,transparent);font-size:11.5px;color:var(--theme-text-muted,#666);cursor:pointer;line-height:1.35}
        .reply-ref i{font-size:10px;color:var(--theme-primary,#1089d3);flex:0 0 auto}
        .reply-ref b{color:var(--theme-text,#1a1a2e);font-weight:700;flex:0 0 auto}
        .reply-ref span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
        .reply-ref.gone{cursor:default;opacity:.75}
        .reply-ref:focus-visible{outline:2px solid var(--theme-primary,#1089d3)}
        .note-comment.nm-flash,.highlight-comment.nm-flash{animation:nmFlash 1.3s ease}
        @keyframes nmFlash{0%,60%{background:color-mix(in srgb,var(--theme-primary,#1089d3) 16%,transparent)}100%{background:transparent}}
        @media (prefers-reduced-motion:reduce){.nm-bt.pan .nm-marq{animation:none!important}.nm-bt{text-overflow:ellipsis!important}.nm-eq i,.nm-ov *,.note-comment.nm-flash,.highlight-comment.nm-flash{animation:none!important;transition:none!important}}`;
        document.head.appendChild(st);
    }

    // ------------------------------------------------------------ data helpers
    // Reads a stored music object safely; notes always play the whole preview from 0:00.
    function clean(m) {
        if (!m || typeof m !== 'object') return null;
        const c = S().cleanMusic(Object.assign({}, m, { startSec: 0, clipSec: 30 }));
        return c ? Object.assign(c, { startSec: 0, clipSec: c.previewSec }) : null;
    }
    const hasContent = n => !!(n && (String(n.text || '').trim() || clean(n.music)));
    function bubbleText(n) {
        if (!n) return '';
        const t = String(n.text || '').trim(); if (t) return t;
        const m = clean(n.music); return m ? m.title + (m.artist ? ' · ' + m.artist : '') : '';
    }
    const idOf = n => { const m = n && clean(n.music); return m ? m.trackId : ''; };

    // inner HTML of a member's note bubble. Song notes: title (pans if too long), artist, then the text (like IG).
    // Notes without a song keep the page's own markup (passed in as `fallback`).
    function bubbleInner(note, fallback) {
        const m = clean(note && note.music); if (!m) return fallback;
        const t = String(note.text || '').trim();
        return `<i class="fas fa-music nm-bi"></i><span class="nm-bub"><span class="nm-bt"><span class="nm-marq">${esc(m.title)}</span></span>${m.artist ? `<span class="nm-ba">${esc(m.artist)}</span>` : ''}${t ? `<span class="nm-bx">${esc(t)}</span>` : ''}</span>`;
    }
    // long titles pan back and forth (distance measured, so short titles stay still)
    function fitMarquees(root) {
        (root || document).querySelectorAll('.nm-bt:not([data-fit])').forEach(bt => {
            const mq = bt.firstElementChild; if (!mq || !bt.clientWidth) return;       // hidden for now: measure later
            bt.dataset.fit = '1';
            const over = Math.ceil(mq.scrollWidth - bt.clientWidth);
            if (over > 2) { bt.classList.add('pan'); bt.style.setProperty('--pan', over); bt.style.setProperty('--pan-t', Math.max(4, over / 16 + 3).toFixed(1) + 's'); }
        });
    }
    let fitQueued = false;
    const queueFit = () => { if (fitQueued) return; fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitMarquees(); }); };
    try { new MutationObserver(queueFit).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    window.addEventListener('resize', () => { document.querySelectorAll('.nm-bt[data-fit]').forEach(b => { b.removeAttribute('data-fit'); b.classList.remove('pan'); }); queueFit(); });
    setInterval(() => { if (document.querySelector('.nm-bt:not([data-fit])')) fitMarquees(); }, 2000);

    // ------------------------------------------------------------ audio (one shared player)
    let audio = null, cur = null;
    function stop() {
        if (audio) { try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) { /* ignore */ } audio = null; }
        if (cur) { setPlayIcon(cur.card, false); const p = cur.card && cur.card.querySelector('.nm-prog i'); if (p) p.style.width = '0'; }
        cur = null;
    }
    function setPlayIcon(card, playing, ended) {
        const b = card && card.querySelector('.nm-play'); if (!b) return;
        b.innerHTML = '<i class="fas fa-' + (ended ? 'rotate-right' : playing ? 'pause' : 'play') + '"></i>';
        b.setAttribute('aria-label', ended ? 'Replay' : playing ? 'Pause' : 'Play');
    }
    function play(url, card) {
        stop();
        const a = new Audio(url); audio = a; cur = { card, url };
        const bar = card && card.querySelector('.nm-prog i');
        a.addEventListener('timeupdate', () => {
            if (audio !== a) return;
            if (card && !card.isConnected || (card && card.offsetParent === null && !card.closest('.nm-panel'))) { stop(); return; }   // modal closed
            if (bar && a.duration) bar.style.width = Math.min(100, a.currentTime / a.duration * 100).toFixed(1) + '%';
        });
        a.addEventListener('ended', () => { if (audio === a) { setPlayIcon(card, false, true); if (bar) bar.style.width = '100%'; } });
        const ok = () => setPlayIcon(card, true), no = () => { if (audio === a) setPlayIcon(card, false); };
        a.play().then(ok).catch(no);
    }
    function toggle(card) {
        const url = card.dataset.src;
        if (cur && cur.card === card && audio && !audio.paused) { audio.pause(); setPlayIcon(card, false); return; }
        if (cur && cur.card === card && audio && !audio.ended && audio.paused) { audio.play().then(() => setPlayIcon(card, true)).catch(() => {}); return; }
        play(url, card);
    }
    function cardHtml(m, opts) {
        opts = opts || {};
        injectStyles();
        const art = S().safeImgUrl(m.thumbnail);
        return `<div class="nm-card" data-src="${esc(m.previewUrl)}">${art ? `<img class="nm-art" src="${esc(art)}" alt="">` : '<span class="nm-ph"><i class="fas fa-music"></i></span>'}
            <div class="nm-meta"><b>${esc(m.title)}</b><small>${esc(m.artist || 'Song')} · ${fmt(m.previewSec)}</small><div class="nm-prog"><i></i></div></div>
            <button type="button" class="nm-play" aria-label="Play"><i class="fas fa-play"></i></button></div>`;
    }
    function ensureAfter(id, afterId) {
        let el = document.getElementById(id);
        if (el) return el;
        const a = document.getElementById(afterId); if (!a) return null;
        el = document.createElement('div'); el.id = id; a.insertAdjacentElement('afterend', el);
        return el;
    }
    // note modal: shows the song and starts it (opening the modal was a tap, so autoplay is allowed)
    function mountModal(note) {
        injectStyles(); stop();
        const host = ensureAfter('noteModalMusic', 'noteModalText'); if (!host) return;
        const m = note && clean(note.music);
        host.innerHTML = m ? cardHtml(m) : '';
        if (m) play(m.previewUrl, host.querySelector('.nm-card'));
    }
    function mountDetail(note) {      // member detail modal: static card, user presses play
        injectStyles();
        const host = ensureAfter('memberDetailNoteMusic', 'memberDetailNoteText'); if (!host) return;
        const m = note && clean(note.music);
        host.innerHTML = m ? cardHtml(m) : '';
    }

    // ------------------------------------------------------------ Replace (start a fresh note, new 24 h timer)
    // Replace only CLEARS the editor. The live note and its replies are untouched until the user taps Save;
    // saving then writes a brand-new note (fresh 24 hours, replies cleared). Cancel / closing Tita keeps the old note.
    let replacing = false, replaceSnap = null, liveNote = null;
    const expMs = n => { const e = n && n.expireAt; if (!e) return 0; if (e.toMillis) return e.toMillis(); if (e.seconds) return e.seconds * 1000; const t = new Date(e).getTime(); return isNaN(t) ? 0 : t; };
    const isActive = n => hasContent(n) && expMs(n) > Date.now();
    const isReplacing = () => replacing;
    // An active note is LOCKED: its text and its song cannot be touched until the
    // member taps "Replace note". Typing is only possible for a brand-new note (or
    // one that already expired), so a stray keystroke can never rewrite the note
    // every other member is looking at. Replace clears the editor and unlocks it;
    // Save then publishes the new note with a fresh 24-hour timer.
    const isNoteLocked = () => isActive(liveNote) && !replacing;
    const canEditSong = () => !isNoteLocked();
    function refreshNoteLock() {
        const input = document.getElementById('titaNote');
        if (!input) return;
        const locked = isNoteLocked();
        const live = String((liveNote && liveNote.text) || '');
        if (!input.dataset.nmPh) input.dataset.nmPh = input.placeholder || '';
        if (locked) {
            if (document.activeElement === input) input.blur();
            if (input.value !== live) {
                input.value = live;
                const cnt = document.getElementById('titaNoteCount');
                if (cnt) cnt.textContent = String(live.length);
            }
        }
        input.readOnly = locked;
        input.setAttribute('aria-readonly', locked ? 'true' : 'false');
        input.classList.toggle('nm-locked', locked);
        const box = input.closest('.tita-note-editor');
        if (box) box.classList.toggle('nm-locked', locked);
        input.placeholder = locked ? 'Note locked — tap Replace note to change it' : (input.dataset.nmPh || '');
    }
    function syncLiveDraft() {
        if (replacing) return;
        const input = document.getElementById('titaNote');
        if (input && liveNote) liveNote = { ...liveNote, text: input.value.trim().slice(0, 60) };
    }
    function renderReplace() {
        const host = document.getElementById('titaNoteReplaceRow'); if (!host) return;
        injectStyles();
        if (replacing) {
            host.innerHTML = '<div class="nm-replacing" role="status"><span class="ic"><i class="fas fa-rotate"></i></span><div class="tx"><b>Replacing your note</b><small>Your current note stays live until you tap Save. Saving restarts the 24-hour timer and clears its replies.</small></div><button type="button" data-nm="replace-cancel">Cancel</button></div>';
        } else if (isActive(liveNote)) {
            host.innerHTML = '<button type="button" class="nm-replace" data-nm="replace"><span class="ic"><i class="fas fa-rotate"></i></span><span><b>Replace note</b><small>Start fresh · timer restarts at 24h when saved</small></span></button>';
        } else host.innerHTML = '';
    }
    // keepMode: live snapshots refresh the button without cancelling a Replace in progress
    function setReplaceNote(note, keepMode) {
        liveNote = note || null;
        if (!keepMode) { replacing = false; replaceSnap = null; }
        renderRow(); renderReplace(); refreshNoteLock();
    }
    async function startReplace() {
        if (replacing) return;
        const ok = await S().confirm({ title: 'Replace your note?', message: 'Your current note and song stay live until you tap Save. Saving gives the new note a fresh 24 hours and clears the replies on the old one.', confirmLabel: 'Start fresh', cancelLabel: 'Keep note', type: 'warn', confirmIcon: 'fa-rotate' });
        if (!ok) return;
        const inp = document.getElementById('titaNote'), cnt = document.getElementById('titaNoteCount');
        replaceSnap = { text: inp ? inp.value : '', music: draft };
        if (inp) { inp.value = ''; }
        if (cnt) cnt.textContent = '0';
        draft = null; replacing = true; renderRow(); renderReplace(); refreshNoteLock();
        if (inp) inp.focus({ preventScroll: true });
    }
    function cancelReplace() {
        const inp = document.getElementById('titaNote'), cnt = document.getElementById('titaNoteCount');
        if (replaceSnap) { if (inp) inp.value = replaceSnap.text; if (cnt) cnt.textContent = String((replaceSnap.text || '').length); draft = replaceSnap.music; }
        replacing = false; replaceSnap = null; renderRow(); renderReplace(); refreshNoteLock();
    }

    // ------------------------------------------------------------ draft (the song being attached in Tita Tima)
    let draft = null;
    const setDraft = m => { draft = clean(m); syncLiveDraft(); renderRow(); };
    const syncDraft = m => { if (ov) return; setDraft(m); };      // live snapshot: never overwrite a song that is being picked
    const getDraft = () => draft;
    function getDraftForSave() {
        const src = canEditSong() ? draft : clean(liveNote && liveNote.music);
        if (!src) return null;
        return { provider: 'itunes', trackId: src.trackId, title: src.title, artist: src.artist, thumbnail: src.thumbnail || '', previewUrl: src.previewUrl, previewSec: src.previewSec, startSec: 0, clipSec: src.previewSec };
    }
    function renderRow() {
        const host = document.getElementById('titaNoteMusicRow'); if (!host) return;
        injectStyles();
        host.className = 'nm-row';
        const locked = isNoteLocked();
        if (locked && !draft) { host.innerHTML = '<div class="nm-locked-note"><i class="fas fa-lock"></i><span>A song can only be added when you start a new note.</span></div>'; return; }
        if (!draft) { host.innerHTML = '<button type="button" class="nm-add" data-nm="open"><span class="nm-addic"><i class="fas fa-music"></i></span><span>Add a song</span><small>optional</small></button>'; return; }
        const art = S().safeImgUrl(draft.thumbnail);
        host.innerHTML = `<div class="nm-chip${locked ? ' nm-locked' : ''}">${art ? `<img class="nm-art" src="${esc(art)}" alt="">` : '<span class="nm-ph"><i class="fas fa-music"></i></span>'}
            <div class="nm-meta"><b>${esc(draft.title)}</b><small>${esc(draft.artist || 'Song')} · ${fmt(draft.previewSec)}</small></div>
            ${locked ? '<span class="nm-lockic" title="Replace the note to change the song"><i class="fas fa-lock"></i></span>' : '<button type="button" class="nm-ib" data-nm="open" aria-label="Change song"><i class="fas fa-pen"></i></button><button type="button" class="nm-ib danger" data-nm="remove" aria-label="Remove song"><i class="fas fa-xmark"></i></button>'}</div>`;
    }

    // ------------------------------------------------------------ picker panel
    let ov = null, before = null, results = [], busy = false, msg = '', query = '';
    function openPicker() {
        injectStyles(); closePanel(true);
        before = draft; results = []; msg = ''; busy = false; query = '';
        ov = document.createElement('div');
        ov.className = 'nm-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Add a song to your note');
        ov.innerHTML = `<div class="nm-bd" data-nm="cancel"></div><div class="nm-panel">
            <div class="nm-h"><button type="button" class="nm-ib" data-nm="cancel" aria-label="Close"><i class="fas fa-xmark"></i></button><b>Add a song</b><button type="button" class="nm-btn" data-nm="done">Done</button></div>
            <div class="nm-body"><div class="nm-selhost"></div>
              <div class="nm-sr"><input type="search" placeholder="Search a song or artist…" aria-label="Search songs" autocomplete="off"><button type="button" class="nm-btn" data-nm="go" aria-label="Search"><i class="fas fa-magnifying-glass"></i></button></div>
              <div class="nm-msg" aria-live="polite"></div><div class="nm-list"></div></div></div>`;
        document.body.appendChild(ov);
        ov.addEventListener('click', e => { onNmClick(e); e.stopPropagation(); });
        ov.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
        requestAnimationFrame(() => ov && ov.classList.add('in'));
        paint();
        setTimeout(() => { const i = ov && ov.querySelector('input'); if (i) i.focus({ preventScroll: true }); }, 60);
    }
    function paint() {
        if (!ov) return;
        const sel = ov.querySelector('.nm-selhost'), list = ov.querySelector('.nm-list'), m = ov.querySelector('.nm-msg');
        sel.innerHTML = draft ? `<div class="nm-lab">Selected</div><div class="nm-chip">${S().safeImgUrl(draft.thumbnail) ? `<img class="nm-art" src="${esc(S().safeImgUrl(draft.thumbnail))}" alt="">` : '<span class="nm-ph"><i class="fas fa-music"></i></span>'}
            <div class="nm-meta"><b>${esc(draft.title)}</b><small>${esc(draft.artist || 'Song')}</small></div><span class="nm-dur">${fmt(draft.previewSec)}</span>
            <button type="button" class="nm-ib danger" data-nm="remove" aria-label="Remove song"><i class="fas fa-xmark"></i></button></div>` : '';
        m.textContent = busy ? 'Searching…' : msg;
        list.innerHTML = results.length ? '<div class="nm-lab">Results</div>' + results.map((r, i) => `<div class="nm-it" data-card="1">${S().safeImgUrl(r.thumbnail) ? `<img class="nm-art" src="${esc(S().safeImgUrl(r.thumbnail))}" alt="">` : '<span class="nm-ph"><i class="fas fa-music"></i></span>'}
            <div class="nm-meta"><b>${esc(r.title)}</b><small>${esc(r.artist || '')}</small></div>
            <button type="button" class="nm-ib" data-nm="prev" data-i="${i}" aria-label="Preview ${esc(r.title)}">${cur && cur.url === r.previewUrl && audio && !audio.paused ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>'}</button>
            <button type="button" class="nm-btn sm" data-nm="pick" data-i="${i}">Select</button></div>`).join('') : '';
    }
    async function search() {
        if (!ov || busy) return;
        query = ov.querySelector('input').value.trim();
        if (query.length < 2) { msg = 'Type at least 2 characters.'; paint(); return; }
        stop(); busy = true; msg = ''; results = []; paint();
        try {
            results = await S().searchMusic(query);
            msg = results.length ? '' : 'No songs found. Try the artist name or a different spelling.';
        } catch (e) { msg = 'Song search is unavailable right now. Check your connection and try again.'; }
        busy = false; paint();
    }
    function closePanel(silent) {
        stop();
        if (!ov) return;
        const el = ov; ov = null;
        el.classList.remove('in');
        setTimeout(() => el.remove(), silent ? 0 : 180);
    }
    function cancelPanel() { draft = before; renderRow(); closePanel(); }
    function donePanel() { renderRow(); closePanel(); }

    // ------------------------------------------------------------ delegated events
    function onNmClick(e) {
        const t = e.target.closest('[data-nm]');
        if (t) {
            const a = t.dataset.nm;
            e.stopPropagation();      // these buttons re-render themselves; pages would then see a detached target as "outside" and close Tita Tima
            if (a === 'open') { if (canEditSong()) openPicker(); }
            else if (a === 'cancel') cancelPanel();
            else if (a === 'done') donePanel();
            else if (a === 'replace') startReplace();
            else if (a === 'replace-cancel') cancelReplace();
            else if (a === 'go') search();
            else if (a === 'remove') { if (!canEditSong()) return; draft = null; stop(); renderRow(); paint(); }
            else if (a === 'prev') {
                const r = results[Number(t.dataset.i)]; if (!r) return;
                if (cur && cur.url === r.previewUrl && audio && !audio.paused) stop(); else play(r.previewUrl, null);
                paint();
            } else if (a === 'pick') {
                const r = results[Number(t.dataset.i)]; if (!r || !canEditSong()) return;
                draft = clean(r); renderRow(); results = []; msg = ''; paint(); play(draft.previewUrl, null);
            }
            return;
        }
        const pl = e.target.closest('.nm-play');
        if (pl) { const card = pl.closest('.nm-card'); if (card) toggle(card); return; }
        const ref = e.target.closest('.reply-ref[data-ref]');
        if (ref && !ref.classList.contains('gone')) jumpTo(ref);
    }
    // the panel lives on <body>, outside the Tita panel: handle its clicks on the panel itself and stop them there,
    // otherwise pages treat them as "click outside" and close Tita Tima (which made saving the song impossible)
    document.addEventListener('click', e => { if (!e.target.closest('.nm-ov')) onNmClick(e); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && ov) { e.preventDefault(); e.stopPropagation(); cancelPanel(); return; }
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('reply-ref') && !e.target.classList.contains('gone')) { e.preventDefault(); jumpTo(e.target); }
    }, true);
    function jumpTo(ref) {
        const scope = ref.closest('#noteCommentsList,#highlightCommentsList') || document;
        const id = (window.CSS && CSS.escape) ? CSS.escape(ref.dataset.ref) : ref.dataset.ref;
        const el = scope.querySelector(`[data-comment-id="${id}"]`); if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        el.classList.remove('nm-flash'); void el.offsetWidth; el.classList.add('nm-flash');
        setTimeout(() => el.classList.remove('nm-flash'), 1400);
    }
    function initRows() { renderRow(); renderReplace(); refreshNoteLock(); }
    injectStyles();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initRows); else initRows();

    // ------------------------------------------------------------ comment threads
    const Threads = {
        index(comments) { const m = {}; (comments || []).forEach(c => { m[c.id] = c; }); return m; },
        // roots (no replyToId) in order, each followed by its replies in order; replies whose root is gone stay visible
        renderList(comments, itemFn) {
            const roots = comments.filter(c => !c.replyToId), ids = new Set(roots.map(c => c.id)), kids = {};
            comments.filter(c => c.replyToId && ids.has(c.replyToId)).forEach(c => { (kids[c.replyToId] = kids[c.replyToId] || []).push(c); });
            let html = '';
            roots.forEach(r => { html += itemFn(r, false); (kids[r.id] || []).forEach(k => { html += itemFn(k, true); }); });
            comments.filter(c => c.replyToId && !ids.has(c.replyToId)).forEach(o => { html += itemFn(o, false); });
            return html;
        },
        isRoot: (id, byId) => !(byId && byId[id] && byId[id].replyToId),
        // what the reply box is aimed at: id = thread root (what the page already stores as replyToId)
        target(id, byId, name) {
            const c = byId && byId[id];
            if (!c) return { id, targetId: id, targetUid: null, authorName: name || 'Someone', targetText: '' };
            return { id: c.replyToId || c.id, targetId: c.id, targetUid: c.authorUid || null, authorName: c.authorName || name || 'Someone', targetText: String(c.text || '').slice(0, 100) };
        },
        refFields(rt) {
            if (!rt) return {};
            return { replyToCommentId: rt.targetId || rt.id, replyToUid: rt.targetUid || null, replyToName: String(rt.authorName || '').slice(0, 60), replyToText: String(rt.targetText || '').slice(0, 100) };
        },
        refHtml(c, byId) {
            if (!c || !c.replyToId) return '';
            injectStyles();
            const tid = c.replyToCommentId || c.replyToId, t = byId && byId[tid];
            const tUid = t ? t.authorUid : c.replyToUid, me = meUid();
            const text = String((t && t.text) || c.replyToText || '').slice(0, 70);
            let who = (t && t.authorName) || c.replyToName || 'a comment';
            if (tUid && tUid === c.authorUid) who = c.authorUid === me ? 'yourself' : 'themselves';
            else if (tUid && tUid === me) who = 'you';
            return `<div class="reply-ref ${t ? '' : 'gone'}" data-ref="${esc(tid)}" ${t ? 'role="button" tabindex="0"' : ''} title="${t ? 'Go to the comment' : 'That comment was deleted'}"><i class="fas fa-reply"></i><span style="flex:0 0 auto;opacity:1">Replying to</span> <b>${esc(who)}</b>${text ? `<span>“${esc(text)}”</span>` : ''}${t ? '' : '<span>(deleted)</span>'}</div>`;
        }
    };

    window.NoteMusic = { hasContent, bubbleText, bubbleInner, fitMarquees, idOf, clean, cardHtml, injectStyles, canEditSong, setDraft, syncDraft, isReplacing, isActive, setReplaceNote, getDraft, getDraftForSave, mountModal, mountDetail, stop, openPicker };
    window.Threads = Threads;
})();