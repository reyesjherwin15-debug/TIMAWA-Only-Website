/* ============================================================
   avatar-fallback.js · TIMAWA — member photos that will not load
   ============================================================
   A member's photo can be missing (never uploaded), stale (the old
   Cloudinary file was cleaned up) or blocked. Instead of the browser's
   broken-image glyph, every such picture is swapped for a small inline
   SVG avatar with that member's initials, drawn from the name already in
   the markup (`data-avatar-name`, otherwise `alt`).

   It is one global watcher, so it covers every page, every list and any
   markup rendered later (chat, comments, wall, highlights, admin tabs…)
   without each renderer needing its own onerror handler.

   Opt out on a picture with data-avatar-fallback="off".
   ============================================================ */
(function () {
    'use strict';

    if (window.TIMAWA_AVATAR) return;

    var PALETTE = [
        '#7c6bd6', '#e06b8b', '#3fa88b', '#d99a4e',
        '#5b8fd6', '#9a6bbf', '#c96a5a', '#4aa3a8'
    ];
    var MARK = 'data-avatar-fallback';

    var AVATAR_TOKEN = /(^|[\s_-])(avatar|ava|pfp|profilephoto|profile-photo|userphoto|memberphoto)([\s_-]|$)/i;

    function initials(name) {
        var clean = String(name == null ? '' : name).trim();
        if (!clean) return '';
        // "name@mail.com" reads as "name"; punctuation at the edges is trimmed.
        clean = clean.replace(/@[^\s]+/, ' ').replace(/[^\s'.-]/g, function (ch) {
            return /[a-z0-9]/i.test(ch) || ch.charCodeAt(0) > 127 ? ch : ' ';
        }).trim();
        var parts = clean.split(/\s+/).filter(Boolean);
        if (!parts.length) return '';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function colorFor(seed) {
        var text = String(seed || '');
        var hash = 0;
        for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
        return PALETTE[Math.abs(hash) % PALETTE.length];
    }

    function xmlEscape(text) {
        return String(text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /* An inline SVG keeps the original <img>: the page's own size, radius,
       object-fit and lazy behaviour all still apply. */
    function uri(name) {
        var letters = initials(name);
        var label = letters || '?';
        var size = label.length > 1 ? 40 : 50;
        var bg = colorFor(name || label);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"'
            + ' preserveAspectRatio="xMidYMid slice">'
            + '<rect width="100" height="100" fill="' + bg + '"/>'
            + '<text x="50" y="55" text-anchor="middle" dominant-baseline="middle"'
            + ' font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif"'
            + ' font-size="' + size + '" font-weight="700" fill="#ffffff">'
            + xmlEscape(label) + '</text></svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    function classOf(el) {
        return typeof el.className === 'string' ? el.className : '';
    }

    function isAvatar(img) {
        if (!img || img.tagName !== 'IMG') return false;
        if (img.getAttribute(MARK) === 'off') return false;
        if (img.getAttribute(MARK) === 'done') return false;
        if (img.closest && img.closest('.announcement-icon')) return false;
        if (img.hasAttribute('data-avatar-name') || img.hasAttribute('data-avatar-uid')) return true;
        if (AVATAR_TOKEN.test(classOf(img)) || AVATAR_TOKEN.test(img.id || '')) return true;
        var el = img.parentElement;
        for (var depth = 0; el && depth < 3; depth++) {
            if (AVATAR_TOKEN.test(classOf(el)) || AVATAR_TOKEN.test(el.id || '')) return true;
            el = el.parentElement;
        }
        return false;
    }

    function nameFor(img) {
        var name = img.getAttribute('data-avatar-name') || img.getAttribute('alt') || img.getAttribute('title') || '';
        if (name.trim()) return name;
        var holder = img.closest && img.closest('[data-avatar-name]');
        return holder ? (holder.getAttribute('data-avatar-name') || '') : '';
    }

    function apply(img) {
        if (!isAvatar(img)) return false;
        var name = nameFor(img);
        img.setAttribute(MARK, 'done');
        img.removeAttribute('onerror');
        img.removeAttribute('srcset');
        if (!name.trim()) {
            // Nothing to print — keep the circle the page drew, never the glyph.
            img.style.visibility = 'hidden';
            return true;
        }
        img.setAttribute('alt', name);
        img.src = uri(name);
        return true;
    }

    /* `error` does not bubble, so it is caught on the way down. The swap waits
       a tick so a page's own inline onerror (hide/remove/retry raw) can run
       first and win if it did something better. */
    document.addEventListener('error', function (event) {
        var img = event.target;
        if (!img || img.tagName !== 'IMG') return;
        setTimeout(function () {
            if (!document.documentElement.contains(img)) return;
            if (img.naturalWidth > 0) return;
            apply(img);
        }, 0);
    }, true);

    function scan(root) {
        var imgs = (root || document).querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            if (img.getAttribute(MARK) === 'done') continue;
            if (img.complete && img.naturalWidth === 0) apply(img);
        }
    }

    function boot() { scan(document); }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
    window.addEventListener('load', boot);

    window.TIMAWA_AVATAR = {
        initials: initials,
        uri: uri,
        apply: apply,
        scan: scan,
        isAvatar: isAvatar
    };
})();
