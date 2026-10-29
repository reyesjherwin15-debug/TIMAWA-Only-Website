/* ================================================================
   mobile-nav.js  ·  TIMAWA
   Turns the plain burger menu into a modern slide-in drawer.

   Why this exists: every page has its own <ul id="navLinks">, some
   filled by JS after sign-in. Instead of duplicating markup, this
   script reads the live list every time the drawer opens and builds
   an accessible drawer from it — links, active states, inline
   onclick handlers and dynamic auth links all keep working.

   Desktop navbar is untouched (the drawer only exists <= 768px).
   ================================================================ */
(function () {
    'use strict';

    /* ==================================================================
       MOBILE KEYBOARD GUARD
       ------------------------------------------------------------------
       Declared before the nav check below, so it also runs on a page
       without a burger menu. Every focused control is kept above the
       software keyboard:
         • Android: the viewport meta now carries
           `interactive-widget=resizes-content`, so the layout viewport
           shrinks; this layer follows visualViewport and publishes
           --kb-height / --kb-inset for fixed sheets.
         • iOS: the layout viewport does NOT shrink, so the focused field
           is scrolled above the keyboard inside whichever box scrolls
           (modal body, chat body, composer sheet).
       A field that is already fully visible is never moved.
       ================================================================== */
    var KB_MOBILE_Q = '(max-width: 768px)';
    var KB_FIELDS = 'input, textarea, select, [contenteditable="true"]';

    function kbIsMobile() {
        try { return window.matchMedia(KB_MOBILE_Q).matches; } catch (e) { return window.innerWidth <= 768; }
    }

    function kbSync() {
        var vv = window.visualViewport;
        if (!vv) return;
        var root = document.documentElement;
        var visible = Math.round(vv.height);
        var offset = Math.round(vv.offsetTop);
        root.style.setProperty('--mnav-visual-height', visible + 'px');
        root.style.setProperty('--mnav-visual-offset', offset + 'px');
        // The part of the screen that is not behind the keyboard.
        root.style.setProperty('--kb-height', visible + 'px');
        // How tall the keyboard is, measured against the layout viewport.
        var inset = Math.max(0, Math.round(window.innerHeight - (offset + visible)));
        root.style.setProperty('--kb-inset', inset + 'px');
        if (document.body) document.body.classList.toggle('kb-open', inset > 120);
    }

    function kbScroller(el) {
        for (var n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            var s = getComputedStyle(n);
            if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 2) return n;
        }
        return null;
    }

    function kbReveal(field) {
        if (!field || !field.isConnected || document.activeElement !== field) return;
        var vv = window.visualViewport;
        var top = vv ? vv.offsetTop : 0;
        var bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
        var rect = field.getBoundingClientRect();
        var pad = 14;
        if (rect.bottom <= bottom - pad && rect.top >= top + pad) return;   // already visible

        var scroller = kbScroller(field);
        if (scroller) {
            var sr = scroller.getBoundingClientRect();
            // The scroller itself may run under the keyboard: only the part
            // above it counts as visible.
            var visBottom = Math.min(sr.bottom, bottom) - pad;
            var visTop = Math.max(sr.top, top) + pad;
            if (rect.bottom > visBottom) scroller.scrollTop += rect.bottom - visBottom;
            else if (rect.top < visTop) scroller.scrollTop -= visTop - rect.top;
            return;
        }

        // Page-level scroll, but never for a field inside a fixed sheet:
        // scrolling the page would not move it and would jump the app behind.
        for (var n2 = field; n2 && n2 !== document.body; n2 = n2.parentElement) {
            if (getComputedStyle(n2).position === 'fixed') return;
        }
        var delta = rect.bottom > bottom - pad
            ? rect.bottom - bottom + pad
            : (rect.top < top + pad ? rect.top - top - pad : 0);
        if (delta) window.scrollBy(0, delta);
    }

    function kbFocus(target) {
        if (!kbIsMobile() || !target || !target.matches || !target.matches(KB_FIELDS)) return;
        if (target.type === 'checkbox' || target.type === 'radio') return;
        kbSync();
        // The keyboard slides in over ~250ms: check before and after it lands.
        setTimeout(function () { kbSync(); kbReveal(target); }, 120);
        setTimeout(function () { kbSync(); kbReveal(target); }, 360);
    }

    var kbLastField = null;
    document.addEventListener('focusin', function (e) {
        kbLastField = e.target;
        kbFocus(e.target);
    });
    if (window.visualViewport) {
        var kbResizeTimer = null;
        window.visualViewport.addEventListener('resize', function () {
            kbSync();
            if (kbResizeTimer) clearTimeout(kbResizeTimer);
            kbResizeTimer = setTimeout(function () { kbReveal(kbLastField); kbResizeTimer = null; }, 90);
        });
        window.visualViewport.addEventListener('scroll', kbSync);
        kbSync();
    }

    var nav = document.getElementById('navbar') || document.querySelector('.navbar');
    if (!nav) return;

    var src = document.getElementById('navLinks') || nav.querySelector('.nav-links');
    var toggle = nav.querySelector('.mobile-toggle');
    if (!src || !toggle) return;

    var MOBILE_QUERY = '(max-width: 768px)';
    function isMobile() {
        try { return window.matchMedia(MOBILE_QUERY).matches; } catch (e) { return window.innerWidth <= 768; }
    }

    /* ---------- burger icon ---------- */
    toggle.innerHTML = '<span class="mnav-burger" aria-hidden="true"><i></i><i></i><i></i></span>';
    toggle.removeAttribute('onclick');   // one handler only: ours (below)
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'mnavDrawer');

    /* ---------- chrome ---------- */
    var backdrop = document.createElement('div');
    backdrop.className = 'mnav-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    var drawer = document.createElement('aside');
    drawer.className = 'mnav-drawer';
    drawer.id = 'mnavDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Main menu');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML =
        '<div class="mnav-head">' +
            '<div class="mnav-mark">T</div>' +
            '<div class="mnav-head-text">' +
                '<div class="mnav-head-title">TIMAWA</div>' +
                '<div class="mnav-head-sub">Squad menu</div>' +
            '</div>' +
            '<button type="button" class="mnav-close" aria-label="Close menu"><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="mnav-items" id="mnavItems"></div>' +
        '<div class="mnav-foot"><span><span class="mnav-dot"></span>Squad online</span><span>Est. 2022</span></div>';

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    var itemsBox = drawer.querySelector('#mnavItems');
    var closeBtn = drawer.querySelector('.mnav-close');

    /* ---------- icon fallbacks for links that have none ---------- */
    var ICONS = [
        [/(spin|poll|wheel)/i, 'fa-dharmachakra'],
        [/(highlight|photo|gallery)/i, 'fa-images'],
        [/coffee|cafe/i, 'fa-mug-hot'],
        [/(place|location)/i, 'fa-location-dot'],
        [/(activit|things)/i, 'fa-list-check'],
        [/member|squad/i, 'fa-users'],
        [/calendar|event/i, 'fa-calendar-alt'],
        [/dashboard|home/i, 'fa-house'],
        [/admin panel|admin/i, 'fa-cog'],
        [/profile/i, 'fa-user'],
        [/(sign in|login)/i, 'fa-right-to-bracket'],
        [/(logout|sign out)/i, 'fa-right-from-bracket']
    ];

    function iconFor(label, href) {
        var hay = (label || '') + ' ' + (href || '');
        for (var i = 0; i < ICONS.length; i++) {
            if (ICONS[i][0].test(hay)) return ICONS[i][1];
        }
        return 'fa-circle';
    }

    function cleanText(node) {
        return (node.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /* ---------- build rows from the page's own list ---------- */
    function collectLinks() {
        var rows = [];
        var lis = src.querySelectorAll(':scope > li');
        Array.prototype.forEach.call(lis, function (li) {
            if (li.classList.contains('announcement-li')) return;

            // a wrapper <li> (e.g. #authLinks) can hold several anchors/buttons
            var direct = li.querySelectorAll(':scope > a, :scope > button');
            if (direct.length) {
                Array.prototype.forEach.call(direct, function (el) {
                    rows.push({ el: el, active: el.classList.contains('active') || li.classList.contains('active') });
                });
                return;
            }

            // generic container: grab its anchors/buttons but skip the bell
            var nested = li.querySelectorAll('a, button');
            Array.prototype.forEach.call(nested, function (el) {
                if (el.closest('.announcement-wrapper')) return;
                rows.push({ el: el, active: el.classList.contains('active') || li.classList.contains('active') });
            });
        });
        return rows;
    }

    function build() {
        var rows = collectLinks();
        var html = '';

        rows.forEach(function (row, index) {
            var el = row.el;
            var label = cleanText(el);
            if (!label) return;

            var href = el.tagName === 'A' ? (el.getAttribute('href') || '#') : '';
            var isDanger = /(logout|sign out|log out)/i.test(label);
            var existingIcon = el.querySelector('i');
            var iconClass = (existingIcon && /fa-/.test(existingIcon.className))
                ? existingIcon.className
                : 'fas ' + iconFor(label, href);

            var tag = el.tagName === 'A' ? 'a' : 'button';
            var attrs = '';
            if (tag === 'a') {
                attrs += ' href="' + href.replace(/"/g, '&quot;') + '"';
                if (el.getAttribute('target')) attrs += ' target="' + el.getAttribute('target') + '"';
            } else {
                attrs += ' type="button"';
            }
            // carry inline handlers/targets across
            Array.prototype.forEach.call(el.attributes, function (a) {
                if (/^on/.test(a.name) && a.name !== 'onclick') attrs += ' ' + a.name + '="' + a.value.replace(/"/g, '&quot;') + '"';
            });
            var inlineClick = el.getAttribute('onclick');
            if (inlineClick) attrs += ' onclick="' + inlineClick.replace(/"/g, '&quot;') + '"';

            html += '<' + tag + ' class="mnav-item' + (row.active ? ' is-active' : '') + (isDanger ? ' is-danger' : '') + '"' +
                    ' style="--i:' + index + '"' + attrs + '>' +
                    '<span class="mnav-ico"><i class="' + iconClass.replace(/"/g, '') + '"></i></span>' +
                    '<span class="mnav-label">' + label.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>' +
                    (isDanger ? '' : '<i class="fas fa-chevron-right mnav-arrow" aria-hidden="true"></i>') +
                    '</' + tag + '>';
        });

        if (!html) {
            html = '<div class="mnav-item" style="--i:0"><span class="mnav-ico"><i class="fas fa-circle-info"></i></span><span class="mnav-label">Nothing here yet</span></div>';
        }
        itemsBox.innerHTML = html;

        // close after navigating / acting
        Array.prototype.forEach.call(itemsBox.querySelectorAll('a, button'), function (el) {
            el.addEventListener('click', function () {
                // anchor navigation needs one frame, so close immediately (no preventDefault)
                close();
            });
        });
    }

    /* ---------- open / close ---------- */
    function syncDrawerTop() {
        var h = nav.getBoundingClientRect().height || 69;
        document.documentElement.style.setProperty('--mnav-top', Math.round(h + 8) + 'px');
    }

    function open() {
        if (!isMobile()) return;
        syncDrawerTop();
        build();
        document.body.classList.add('mnav-on', 'mnav-open', 'mnav-lock');
        drawer.setAttribute('aria-hidden', 'false');
        drawer.style.zIndex = '2601';
        backdrop.style.zIndex = '2600';
        backdrop.classList.add('show');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.setAttribute('aria-label', 'Close menu');
        try { closeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }

    function close() {
        document.body.classList.remove('mnav-open', 'mnav-lock');
        drawer.setAttribute('aria-hidden', 'true');
        backdrop.classList.remove('show');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open menu');
    }

    function isOpen() { return document.body.classList.contains('mnav-open'); }

    window.mnavOpen = open;
    window.mnavClose = close;
    window.toggleMobileMenu = function () { isOpen() ? close() : open(); };

    toggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        isOpen() ? close() : open();
    });

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    document.addEventListener('keydown', function (e) {
        if (!isOpen()) return;
        if (e.key === 'Escape') { close(); toggle.focus({ preventScroll: true }); }
        if (e.key === 'Tab') {
            var focusables = drawer.querySelectorAll('a[href], button:not([disabled])');
            if (!focusables.length) return;
            var first = focusables[0];
            var last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            if (isMobile()) {
                document.body.classList.add('mnav-on');
                syncDrawerTop();
            } else {
                close();
                document.body.classList.remove('mnav-on');
            }
        }, 120);
    });

    if (isMobile()) document.body.classList.add('mnav-on');
    window.addEventListener('load', function () { if (isMobile()) document.body.classList.add('mnav-on'); });
    // Assistant and its backdrop are siblings of the drawer, so place them below
    // the menu instead of mutating their inline styles permanently.
    function syncAssistantLayer() {
        document.body.classList.toggle('mnav-open', isOpen());
    }
    new MutationObserver(syncAssistantLayer).observe(document.body, { childList: true, subtree: true });
})();
