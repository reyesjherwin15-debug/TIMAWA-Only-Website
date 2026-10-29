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

    function omitMobileSectionLink(node) {
        var href = node && node.tagName === 'A' ? (node.getAttribute('href') || '') : '';
        var label = cleanText(node);
        var isLandingPage = /index\.html/i.test(location.pathname) || location.pathname === '/' || location.pathname === '';
        var isRequestedLandingSection = /#(?:highlights|coffee-shops|favorite-places|things-to-do|members-section)(?:$|[?&])/i.test(href) ||
            /^(highlights|coffee(?: shops?)?|places|activities|things to do|members)$/i.test(label);
        // Keep these section shortcuts on other pages; omit them from the
        // landing-page drawer where the user asked for a shorter menu.
        return !!(isLandingPage && isRequestedLandingSection);
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
                    if (omitMobileSectionLink(el)) return;
                    rows.push({ el: el, active: el.classList.contains('active') || li.classList.contains('active') });
                });
                return;
            }

            // generic container: grab its anchors/buttons but skip the bell
            var nested = li.querySelectorAll('a, button');
            Array.prototype.forEach.call(nested, function (el) {
                if (el.closest('.announcement-wrapper') || omitMobileSectionLink(el)) return;
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
    // Keep focused controls above the mobile software keyboard (including iOS
    // visual-viewport changes inside fixed modals and the fullscreen chat).
    function syncVisualViewport() {
        var vv = window.visualViewport;
        if (!vv) return;
        document.documentElement.style.setProperty('--mnav-visual-height', Math.round(vv.height) + 'px');
        document.documentElement.style.setProperty('--mnav-visual-offset', Math.round(vv.offsetTop) + 'px');
    }
    function keepFocusedFieldVisible(target) {
        if (!target || !isMobile() || !target.matches('input, textarea, select, [contenteditable="true"]')) return;
        syncVisualViewport();
        setTimeout(function () {
            if (!target.isConnected || document.activeElement !== target) return;
            var vv = window.visualViewport;
            var bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
            var rect = target.getBoundingClientRect();
            if (rect.bottom > bottom - 14 || rect.top < (vv ? vv.offsetTop : 0) + 8) {
                try { target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
                catch (e) { target.scrollIntoView(false); }
            }
        }, 90);
    }
    document.addEventListener('focusin', function (e) { keepFocusedFieldVisible(e.target); });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', function () { syncVisualViewport(); keepFocusedFieldVisible(document.activeElement); });
        window.visualViewport.addEventListener('scroll', function () { syncVisualViewport(); });
        syncVisualViewport();
    }
    // Assistant and its backdrop are siblings of the drawer, so place them below
    // the menu instead of mutating their inline styles permanently.
    function syncAssistantLayer() {
        document.body.classList.toggle('mnav-open', isOpen());
    }
    new MutationObserver(syncAssistantLayer).observe(document.body, { childList: true, subtree: true });
})();
