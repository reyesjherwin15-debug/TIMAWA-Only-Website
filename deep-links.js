/* ============================================================================
   TIMAWA — item-level notification links
   ----------------------------------------------------------------------------
   Section links (#members-section, #highlights) put the member near the right
   area but not on the item they tapped. This module resolves a notification to
   one concrete thing:

     #note=<uid>&comment=<id>       note + reply
     #highlight=<id>&comment=<id>   highlight + comment
     #chat=<uid|group>&msg=<id>     conversation + message
     #freedom=<noteId>&comment=<id> freedom-wall note + reply
     #event=<id>                    calendar event
     #snap=<id>                     QuickSnap
     #member=<uid>                  member card
     #birthday=<uid>                birthday card
     index.html?story=<id>          story viewer

   Pages register openers in `window.TIMAWA_NOTIF_HANDLERS`. The router waits
   for the relevant data/modal to render, scrolls the exact element into the
   middle of the screen, and flashes it once. If the item is on another page it
   navigates to the canonical URL instead.
   ========================================================================== */
(function () {
    'use strict';

    var VERSION = '1.0.2';
    var RETRY_MS = 350;
    var MAX_TRIES = 60;                 // ~21 s for a cold Firestore load
    var PULSE_CLASS = 'timawa-target-pulse';
    var HASH_KEYS = ['note', 'highlight', 'chat', 'freedom', 'event', 'snap', 'member', 'birthday', 'story'];
    var HASH_EXTRAS = ['comment', 'msg'];
    var active = null;
    var timer = 0;
    var tries = 0;

    function pageName() {
        var parts = String(location.pathname || '').split('/');
        var last = parts[parts.length - 1] || '';
        return (last || 'index.html').toLowerCase();
    }

    function handlers() {
        return (window.TIMAWA_NOTIF_HANDLERS && typeof window.TIMAWA_NOTIF_HANDLERS === 'object')
            ? window.TIMAWA_NOTIF_HANDLERS
            : {};
    }

    function encode(value) {
        try { return encodeURIComponent(String(value == null ? '' : value)); }
        catch (e) { return ''; }
    }

    function noteTarget(id, commentId) {
        if (!id) return null;
        var url = 'index.html#note=' + encode(id);
        if (commentId) url += '&comment=' + encode(commentId);
        return { kind: 'note', id: String(id), commentId: commentId ? String(commentId) : '', page: 'index.html', url: url };
    }

    function highlightTarget(id, commentId) {
        if (!id) return null;
        var url = 'index.html#highlight=' + encode(id);
        if (commentId) url += '&comment=' + encode(commentId);
        return { kind: 'highlight', id: String(id), commentId: commentId ? String(commentId) : '', page: 'index.html', url: url };
    }

    function chatTarget(uid, msgId) {
        if (!uid) return null;
        var url = 'dashboard.html#chat=' + encode(uid);
        if (msgId) url += '&msg=' + encode(msgId);
        return { kind: 'chat', id: String(uid), messageId: msgId ? String(msgId) : '', page: 'dashboard.html', url: url };
    }

    function freedomTarget(noteId, commentId) {
        if (!noteId) return null;
        var url = 'index.html#freedom=' + encode(noteId);
        if (commentId) url += '&comment=' + encode(commentId);
        return { kind: 'freedom', id: String(noteId), commentId: commentId ? String(commentId) : '', page: 'index.html', url: url };
    }

    function eventTarget(id) {
        if (!id) return null;
        return { kind: 'event', id: String(id), page: 'calendar.html', url: 'calendar.html#event=' + encode(id) };
    }

    function storyTarget(id) {
        if (!id) return null;
        return { kind: 'story', id: String(id), page: 'index.html', url: 'index.html?story=' + encode(id) };
    }

    function snapTarget(id) {
        if (!id) return null;
        var url = (pageName() === 'index.html') ? '#snap=' + encode(id) : 'index.html#snap=' + encode(id);
        return { kind: 'snap', id: String(id), page: 'index.html', url: url };
    }

    function memberTarget(uid) {
        if (!uid) return null;
        return { kind: 'member', id: String(uid), page: 'index.html', url: 'index.html#member=' + encode(uid) };
    }

    function birthdayTarget(uid) {
        if (!uid) return null;
        return { kind: 'birthday', id: String(uid), page: 'calendar.html', url: 'calendar.html#birthday=' + encode(uid) };
    }

    /* ---------------------------------------------------------------- parse */

    function parse(source) {
        var url;
        try { url = new URL(source || location.href, location.href); } catch (e) { return null; }
        if (!url) return null;
        try {
            var story = url.searchParams.get('story');
            if (story) return storyTarget(story);
            var snapQ = url.searchParams.get('snap');
            if (snapQ) return snapTarget(snapQ);
        } catch (e) { /* older browsers */ }

        var hash = String(url.hash || '').replace(/^#/, '');
        if (!hash) return null;
        var h;
        try { h = new URLSearchParams(hash); } catch (e) { return null; }

        if (h.get('note')) return noteTarget(h.get('note'), h.get('comment'));
        if (h.get('highlight')) return highlightTarget(h.get('highlight'), h.get('comment'));
        if (h.get('chat')) return chatTarget(h.get('chat'), h.get('msg'));
        if (h.get('freedom')) return freedomTarget(h.get('freedom'), h.get('comment'));
        if (h.get('event')) return eventTarget(h.get('event'));
        if (h.get('snap')) return snapTarget(h.get('snap'));
        if (h.get('member')) return memberTarget(h.get('member'));
        if (h.get('birthday')) return birthdayTarget(h.get('birthday'));
        if (h.get('story')) return storyTarget(h.get('story'));
        return null;
    }

    /* ------------------------------------------------- announcement -> target */

    function explicitTarget(item) {
        var type = String(item.targetType || '').toLowerCase();
        var id = item.targetId;
        if (!type || !id) return null;
        if (type === 'note') return noteTarget(id, item.commentId);
        if (type === 'highlight') return highlightTarget(id, item.commentId);
        if (type === 'chat') return chatTarget(id, item.messageId);
        if (type === 'freedom') return freedomTarget(id, item.commentId);
        if (type === 'event') return eventTarget(id);
        if (type === 'story') return storyTarget(id);
        if (type === 'snap') return snapTarget(id);
        if (type === 'member') return memberTarget(id);
        if (type === 'birthday') return birthdayTarget(id);
        return null;
    }

    function fromAnnouncement(item) {
        if (!item) return null;
        var explicit = explicitTarget(item);
        if (explicit) return explicit;

        var type = String(item.type || '').toLowerCase();
        var ref = String(item.referenceId || '');
        var ctx = String(item.pushContext || '');
        var link = String(item.link || item.pushUrl || '');

        // A precise link always wins (story ?story=, newer #note= links, etc.).
        var byLink = parse(link);
        if (byLink) return byLink;

        // QuickSnap reactions open the exact snap.
        if (type === 'quicksnap' || /^snap_/.test(ref) || /^snap:/.test(ctx)) {
            var snapId = item.targetId || (ctx.match(/^snap:(.+)$/) || [])[1] || ref.replace(/^snap_/, '');
            if (snapId) return snapTarget(snapId);
        }

        // Stories.
        if (type === 'story' || /^story_/.test(ref) || /^mention:story_/.test(ctx)) {
            var sid = (ref.match(/^story_([^_]+)/) || [])[1] ||
                (ctx.match(/^mention:story_(.+)$/) || [])[1] || '';
            if (sid) return storyTarget(sid);
        }

        // Freedom wall: the context carries the note id when the reference only
        // carries a comment id.
        if (type === 'freedom' || /^freedom_/.test(ref) || /^freedom:/.test(ctx) ||
            /^mention:freedom_/.test(ctx)) {
            var noteId = item.targetId ||
                (ctx.match(/^freedom:(.+)$/) || [])[1] ||
                (ctx.match(/^mention:freedom_(.+)$/) || [])[1] ||
                (ref.match(/^freedom_note_([^_]+)/) || [])[1] || '';
            var fwComment = item.commentId ||
                (ref.match(/^freedom_c_(.+)$/) || [])[1] || '';
            if (noteId) return freedomTarget(noteId, fwComment);
        }

        // Chat / group / squad.
        if (type === 'chat' || type === 'squad' || /^chat:/.test(ctx) ||
            /^mention:chat_/.test(ctx) || /^(dm_|chat_|group_|squad_)/.test(ref)) {
            var chatUid = '';
            if (type === 'squad' || /^squad/.test(ref) || /^group_/.test(ref)) chatUid = 'group';
            else if (/^dm_/.test(ref)) chatUid = ref.slice(3);
            else if (/^chat_/.test(ref)) chatUid = ref.slice(5);
            else if (/^chat:/.test(ctx)) chatUid = ctx.slice(5);
            else if (/^mention:chat_/.test(ctx)) chatUid = ctx.slice('mention:chat_'.length);
            var legacyChat = link.match(/#chat_([^&?]+)/);
            if (!chatUid && legacyChat) chatUid = legacyChat[1];
            if (!chatUid && type === 'squad') chatUid = 'group';
            if (chatUid) return chatTarget(chatUid, item.messageId || '');
        }

        // Calendar events (incl. the bare event id used by tomorrow reminders).
        if (type === 'event' || /^event:/.test(ctx) || /^created_/.test(ref)) {
            var eventId = item.targetId ||
                (ctx.match(/^event:(?:new_)?(.+)$/) || [])[1] ||
                ref.replace(/^created_/, '');
            if (eventId) return eventTarget(eventId);
        }

        // Highlight comments, mentions and reactions.
        if (type === 'reaction' || type === 'comment' || type === 'reply' ||
            type === 'mention' || /^highlight/.test(type)) {
            var highlightId = item.targetId ||
                (ctx.match(/(?:mention:|reaction:?)highlight_([^_]+)/) || [])[1] || '';
            if (!highlightId && /^reaction/.test(ref)) {
                highlightId = ref.replace(/^reaction[^_]*_/, '').split('_')[0];
            }
            if (!highlightId && /#highlights/.test(link)) highlightId = ref;
            if (highlightId) return highlightTarget(highlightId, item.commentId || '');
        }

        // Notes and their replies/mentions.
        if (type === 'reply' || type === 'mention' || type === 'comment' ||
            type === 'note' || /^note/.test(type)) {
            var noteUid = item.targetId ||
                (ctx.match(/note_([^_]+)/) || [])[1] ||
                ref.replace(/^note_/, '');
            if (noteUid) return noteTarget(noteUid, item.commentId || '');
        }

        if (type === 'member' && ref) return memberTarget(ref);
        if (type === 'birthday' && ref) return birthdayTarget(ref.split('_').pop());

        return null;
    }

    function urlForAnnouncement(item) {
        var target = fromAnnouncement(item);
        return target ? target.url : '';
    }

    /* --------------------------------------------------------------- scroll */

    function injectStyle() {
        if (document.getElementById('timawa-deep-link-style')) return;
        var style = document.createElement('style');
        style.id = 'timawa-deep-link-style';
        style.textContent =
            '[data-comment-id],[data-msg-id],[data-member-id],[data-event-id]{scroll-margin-block:96px;}' +
            '.' + PULSE_CLASS + '{outline:2px solid color-mix(in srgb,var(--theme-primary,#1089d3) 72%,transparent);' +
            'outline-offset:2px;border-radius:10px;animation:timawa-target-glow 2.4s ease-out 1;}' +
            '@keyframes timawa-target-glow{0%,100%{outline-color:transparent}' +
            '12%{outline-color:color-mix(in srgb,var(--theme-primary,#1089d3) 80%,transparent)}' +
            '52%{outline-color:color-mix(in srgb,var(--theme-primary,#1089d3) 45%,transparent)}}' +
            '@media(prefers-reduced-motion:reduce){.' + PULSE_CLASS + '{animation:none;outline-color:transparent;}}';
        (document.head || document.documentElement).appendChild(style);
    }

    function isVisible(el) {
        if (!el) return false;
        try { return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)); }
        catch (e) { return false; }
    }

    function findVisible(selector) {
        var list;
        try { list = document.querySelectorAll(selector); } catch (e) { return null; }
        for (var i = 0; i < list.length; i += 1) {
            if (isVisible(list[i])) return list[i];
        }
        return null;
    }

    function pulse(el) {
        if (!el || !el.classList) return;
        el.classList.remove(PULSE_CLASS);
        void el.offsetWidth;
        el.classList.add(PULSE_CLASS);
        setTimeout(function () { el.classList.remove(PULSE_CLASS); }, 2600);
    }

    function scrollParent(el) {
        var node = el && el.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            try {
                var style = window.getComputedStyle(node);
                if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
            } catch (e) { /* keep walking */ }
            node = node.parentElement;
        }
        return null;
    }

    function scrollToElement(el) {
        if (!el) return;
        // Jump immediately: notification targets must be in place even when
        // the tab is backgrounded or a mobile browser throttles animations.
        var behavior = 'auto';
        var scroller = scrollParent(el);
        if (scroller) {
            // Modals, the chat log and the Freedom Wall sheet scroll themselves.
            try {
                el.scrollIntoView({ behavior: behavior, block: 'center', inline: 'nearest' });
            } catch (e) {
                try { el.scrollIntoView(); } catch (err) { /* ignore */ }
            }
        } else {
            // Page-level cards (members, events) need the sticky nav offset.
            try {
                var mobile = window.matchMedia('(max-width: 768px)').matches;
                var offset = mobile ? 72 : 88;
                var top = el.getBoundingClientRect().top + window.pageYOffset - offset;
                window.scrollTo({ top: Math.max(0, top), behavior: behavior });
            } catch (e) {
                try { el.scrollIntoView(); } catch (err) { /* ignore */ }
            }
        }
        setTimeout(function () { pulse(el); }, 260);
    }

    function waitFor(selector, onFound, timeout) {
        var deadline = Date.now() + (timeout || 15000);
        var done = false;
        var observer = null;
        var interval = 0;
        function cleanup() {
            if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
            if (interval) clearInterval(interval);
        }
        function check() {
            if (done) return;
            var el = findVisible(selector);
            if (el) {
                done = true;
                cleanup();
                onFound(el);
                return;
            }
            if (Date.now() > deadline) {
                done = true;
                cleanup();
            }
        }
        try {
            observer = new MutationObserver(check);
            observer.observe(document.documentElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['class', 'style', 'hidden']
            });
        } catch (e) { observer = null; }
        interval = setInterval(check, 120);
        check();
    }

    function reveal(selector, options) {
        if (!selector) return false;
        var opts = options || {};
        var existing = findVisible(selector);
        if (existing) {
            setTimeout(function () { scrollToElement(existing); }, opts.delay || 180);
            return true;
        }
        waitFor(selector, function (el) {
            setTimeout(function () { scrollToElement(el); }, opts.delay || 180);
            if (typeof opts.onFound === 'function') {
                try { opts.onFound(el); } catch (e) { /* ignore */ }
            }
        }, opts.timeout || 15000);
        return false;
    }

    function revealAttribute(name, value, options) {
        if (!name || value == null || value === '') return false;
        var safe = String(value).replace(/["\\]/g, '\\$&');
        return reveal('[' + name + '="' + safe + '"]', options);
    }

    /* ----------------------------------------------------------------- open */

    function finish(target) {
        try {
            var url = new URL(location.href);
            if (target && target.kind === 'story') {
                url.searchParams.delete('story');
            } else {
                var raw = String(url.hash || '').replace(/^#/, '');
                if (raw) {
                    var h = new URLSearchParams(raw);
                    var changed = false;
                    HASH_KEYS.forEach(function (key) {
                        if (h.has(key)) { h.delete(key); changed = true; }
                    });
                    if (changed) {
                        HASH_EXTRAS.forEach(function (key) { h.delete(key); });
                        var next = h.toString();
                        url.hash = next ? '#' + next : '';
                    }
                }
            }
            window.history.replaceState(window.history.state, '',
                url.pathname + url.search + url.hash);
        } catch (e) { /* the link still worked; only cleanup failed */ }
    }

    function failed(target, options) {
        try {
            window.dispatchEvent(new CustomEvent('timawa:deeplink-failed', { detail: target || {} }));
        } catch (e) { /* ignore */ }
        if (options && typeof options.onFail === 'function') {
            try { options.onFail(target); } catch (e) { /* ignore */ }
        }
    }

    function tick() {
        if (!active) return;
        var target = active;
        var options = target.__options || {};
        var handler = handlers()[target.kind];

        if (typeof handler === 'function') {
            // Clean the URL *before* opening. Chat pushes a history entry while
            // opening; if the hash were still there it would be copied onto the
            // entry underneath and Back would re-open the same conversation.
            if (!target.__cleaned) {
                finish(target);
                target.__cleaned = true;
            }
            var opened = false;
            try { opened = handler(target.id, target.commentId, target) === true; }
            catch (e) { opened = false; }
            if (opened) {
                active = null;
                return;
            }
            if (tries < MAX_TRIES) {
                tries += 1;
                timer = setTimeout(tick, RETRY_MS);
                return;
            }
            active = null;
            failed(target, options);
            return;
        }

        // No opener here: send the member to the page that owns this item.
        if (target.page && target.page !== pageName() && target.url) {
            active = null;
            location.assign(target.url);
            return;
        }
        if (tries < MAX_TRIES) {
            tries += 1;
            timer = setTimeout(tick, RETRY_MS);
            return;
        }
        active = null;
        failed(target, options);
    }

    function schedule(target, options) {
        if (!target) return false;
        target.__options = options || {};
        active = target;
        tries = 0;
        clearTimeout(timer);
        timer = setTimeout(tick, 0);
        return true;
    }

    function openTarget(target, options) {
        if (!target || !target.kind) return false;
        if (target.kind === 'custom' || !target.url) return false;
        // Stories.js owns `?story=` from a cold link. From an in-app tap we can
        // reuse the already-loaded viewer, or navigate to the exact story.
        if (target.kind === 'story') {
            if (pageName() === 'index.html' && window.Stories &&
                typeof window.Stories.isActive === 'function' &&
                window.Stories.isActive(target.id)) {
                try { window.Stories.openById(target.id); finish(target); return true; } catch (e) { /* fall through */ }
            }
            location.assign(target.url);
            return true;
        }
        return schedule(target, options);
    }

    function openAnnouncement(item, options) {
        var target = fromAnnouncement(item);
        if (!target) return false;
        return openTarget(target, options);
    }

    function start(source) {
        var target = parse(source || location.href);
        if (!target) return false;
        // A cold `?story=` is handled by stories.js, which strips the param and
        // opens the viewer after its listener has the story. Do not reload it.
        if (target.kind === 'story') {
            try {
                var src = new URL(source || location.href, location.href);
                if (src.searchParams.get('story')) return false;
            } catch (e) { /* fall through */ }
        }
        if (target.page === pageName() && typeof handlers()[target.kind] !== 'function') {
            // A page can still be loading its inline script; tick() retries.
        }
        return openTarget(target, {});
    }

    /* The in-app click uses the same resolver, but asks the page to open the
       item without leaving it when possible. */
    window.TIMAWA_DEEP_LINKS = {
        version: VERSION,
        parse: parse,
        fromAnnouncement: fromAnnouncement,
        urlForAnnouncement: urlForAnnouncement,
        openTarget: openTarget,
        openAnnouncement: openAnnouncement,
        reveal: reveal,
        revealAttribute: revealAttribute,
        waitFor: waitFor,
        scrollToElement: scrollToElement,
        finish: finish
    };

    injectStyle();

    function boot() {
        // Let the page's inline script register its openers first. Some pages
        // strip a chat hash before their own history setup; they hand the full
        // URL over through this slot so the target is not lost.
        var source = window.__TIMAWA_BOOT_DEEP_LINK__ || location.href;
        try { window.__TIMAWA_BOOT_DEEP_LINK__ = ''; } catch (e) { /* ignore */ }
        setTimeout(function () { start(source); }, 80);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.addEventListener('hashchange', function () { start(location.hash); });
    window.addEventListener('timawa:push-open', function (event) {
        var url = event && event.detail && event.detail.url;
        if (url) start(url);
    });
    window.addEventListener('pageshow', function (event) {
        if (event && event.persisted) start(location.href);
    });
})();
