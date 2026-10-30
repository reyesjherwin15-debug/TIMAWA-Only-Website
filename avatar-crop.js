/* ============================================================================
   avatar-crop.js · TIMAWA
   ----------------------------------------------------------------------------
   A small, dependency-free cropper for profile photos. Every avatar in TIMAWA
   is shown inside a circle, so the member (or the admin editing a member) sees
   exactly that circle while sizing the picture — zoom, drag, confirm.

   Usage:
       const file = await TimawaAvatarCrop.open(originalFile, { size: 512 });
       if (file) uploadToCloudinary(file, ...);

   Resolves with a square JPEG File, or null when the member cancels. The
   original file is never modified on disk; everything happens on a canvas.
   ========================================================================== */
(function () {
    'use strict';

    if (window.TimawaAvatarCrop) return;

    var STYLE_ID = 'twAvatarCropStyle';
    var Z = 2147483000;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var css = ''
            + '.twc-backdrop{position:fixed;inset:0;z-index:' + Z + ';display:flex;align-items:center;justify-content:center;'
            + 'padding:16px;background:rgba(6,12,24,.62);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);'
            + 'opacity:0;transition:opacity .22s ease;}'
            + '.twc-backdrop.twc-in{opacity:1;}'
            + '.twc-card{width:min(420px,100%);max-height:calc(100dvh - 32px);overflow:auto;border-radius:26px;'
            + 'background:var(--theme-card,#fff);color:var(--theme-text,#111);'
            + 'box-shadow:0 30px 70px -24px rgba(2,10,30,.55),inset 0 0 0 1px color-mix(in srgb,var(--theme-border,#e5e7eb) 80%,transparent);'
            + 'transform:translateY(10px) scale(.98);transition:transform .26s cubic-bezier(.34,1.4,.64,1);}'
            + '.twc-backdrop.twc-in .twc-card{transform:none;}'
            + '.twc-head{display:flex;align-items:center;gap:10px;padding:18px 20px 6px;}'
            + '.twc-title{font-size:16px;font-weight:800;letter-spacing:-.01em;flex:1;}'
            + '.twc-close{width:34px;height:34px;border-radius:50%;border:0;cursor:pointer;background:var(--theme-bg-soft,#f3f4f6);'
            + 'color:var(--theme-text-muted,#555);font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;}'
            + '.twc-sub{padding:0 20px 14px;font-size:12.5px;line-height:1.5;color:var(--theme-text-muted,#666);}'
            + '.twc-stage-wrap{display:flex;align-items:center;justify-content:center;padding:2px 20px 6px;}'
            + '.twc-stage{position:relative;width:min(300px,74vw);aspect-ratio:1;border-radius:22px;overflow:hidden;'
            + 'background:repeating-conic-gradient(color-mix(in srgb,var(--theme-text,#111) 6%,transparent) 0% 25%,transparent 0% 50%) 0 0/22px 22px;'
            + 'touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;}'
            + '.twc-stage.twc-drag{cursor:grabbing;}'
            + '.twc-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}'
            + '.twc-mask{position:absolute;inset:0;pointer-events:none;'
            + 'background:radial-gradient(circle at 50% 50%,transparent 0 49.4%,rgba(5,10,20,.52) 50%);}'
            + '.twc-ring{position:absolute;inset:8%;border-radius:50%;pointer-events:none;'
            + 'box-shadow:0 0 0 1.5px rgba(255,255,255,.85),0 0 0 3px rgba(0,0,0,.12);}'
            + '.twc-zoom{display:flex;align-items:center;gap:12px;padding:16px 20px 6px;}'
            + '.twc-zoom i{font-size:13px;color:var(--theme-text-dim,#888);}'
            + '.twc-zoom input[type=range]{flex:1;accent-color:var(--theme-primary,#3a82ff);height:26px;}'
            + '.twc-actions{display:flex;gap:10px;padding:12px 20px 20px;}'
            + '.twc-btn{flex:1;height:46px;border-radius:14px;border:0;font-size:14px;font-weight:800;cursor:pointer;}'
            + '.twc-btn.ghost{background:var(--theme-bg-soft,#f3f4f6);color:var(--theme-text-muted,#555);}'
            + '.twc-btn.primary{background:var(--theme-gradient,linear-gradient(135deg,#3a82ff,#6f52ff));color:#fff;'
            + 'box-shadow:0 12px 26px -12px var(--theme-shadow,rgba(58,130,255,.6));}'
            + '.twc-btn:disabled{opacity:.55;cursor:default;}'
            + '@media (max-width:420px){.twc-card{border-radius:22px;}.twc-stage{width:min(72vw,270px);}}';
        var el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = css;
        document.head.appendChild(el);
    }

    function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

    function open(file, options) {
        options = options || {};
        return new Promise(function (resolve) {
            if (!file || !/^image\//.test(file.type || '')) { resolve(null); return; }

            injectStyle();

            var backdrop = document.createElement('div');
            backdrop.className = 'twc-backdrop';
            backdrop.setAttribute('role', 'dialog');
            backdrop.setAttribute('aria-modal', 'true');
            backdrop.setAttribute('aria-label', 'Adjust your profile photo');
            backdrop.innerHTML = ''
                + '<div class="twc-card">'
                +   '<div class="twc-head">'
                +     '<div class="twc-title">Adjust your photo</div>'
                +     '<button type="button" class="twc-close" aria-label="Cancel">&#10005;</button>'
                +   '</div>'
                +   '<div class="twc-sub">This is exactly how the circle looks on your profile. Drag to reposition, pinch or use the slider to zoom.</div>'
                +   '<div class="twc-stage-wrap">'
                +     '<div class="twc-stage">'
                +       '<canvas width="640" height="640"></canvas>'
                +       '<div class="twc-mask"></div>'
                +       '<div class="twc-ring"></div>'
                +     '</div>'
                +   '</div>'
                +   '<div class="twc-zoom"><i class="fas fa-image" aria-hidden="true"></i>'
                +     '<input type="range" min="1" max="3" step="0.01" value="1" aria-label="Zoom" />'
                +     '<i class="fas fa-search-plus" aria-hidden="true"></i></div>'
                +   '<div class="twc-actions">'
                +     '<button type="button" class="twc-btn ghost" data-act="cancel">Cancel</button>'
                +     '<button type="button" class="twc-btn primary" data-act="use">Use photo</button>'
                +   '</div>'
                + '</div>';

            document.body.appendChild(backdrop);
            requestAnimationFrame(function () { backdrop.classList.add('twc-in'); });

            var stage = backdrop.querySelector('.twc-stage');
            var canvas = backdrop.querySelector('canvas');
            var ctx = canvas.getContext('2d');
            var slider = backdrop.querySelector('input[type=range]');
            var useBtn = backdrop.querySelector('[data-act="use"]');
            var url = URL.createObjectURL(file);
            var img = new Image();
            var base = 1;         // cover scale for the stage square
            var zoom = 1;
            var offsetX = 0;      // pan in stage pixels, from centre
            var offsetY = 0;
            var stageSize = 300;
            var dragging = false;
            var startX = 0, startY = 0, startOffX = 0, startOffY = 0;
            var pinchStart = 0, pinchZoom = 1;
            var done = false;

            function measure() {
                stageSize = Math.max(120, Math.round(stage.clientWidth || 300));
            }

            function draw() {
                measure();
                var dpr = Math.min(2, window.devicePixelRatio || 1);
                var px = Math.round(stageSize * dpr);
                if (canvas.width !== px || canvas.height !== px) {
                    canvas.width = px;
                    canvas.height = px;
                }
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                var scale = base * zoom * dpr;
                var w = img.width * scale;
                var h = img.height * scale;
                var cx = canvas.width / 2 + offsetX * dpr;
                var cy = canvas.height / 2 + offsetY * dpr;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
            }

            function clampPan() {
                var scale = base * zoom;
                var w = img.width * scale;
                var h = img.height * scale;
                var maxX = Math.max(0, (w - stageSize) / 2);
                var maxY = Math.max(0, (h - stageSize) / 2);
                offsetX = clamp(offsetX, -maxX, maxX);
                offsetY = clamp(offsetY, -maxY, maxY);
            }

            function setZoom(next) {
                zoom = clamp(next, 1, 3);
                slider.value = String(zoom);
                clampPan();
                draw();
            }

            function finish(result) {
                if (done) return;
                done = true;
                try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
                document.removeEventListener('keydown', onKey, true);
                backdrop.classList.remove('twc-in');
                setTimeout(function () { backdrop.remove(); }, 220);
                resolve(result);
            }

            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); finish(null); }
            }

            backdrop.querySelector('.twc-close').addEventListener('click', function () { finish(null); });
            backdrop.querySelector('[data-act="cancel"]').addEventListener('click', function () { finish(null); });
            backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) finish(null); });
            document.addEventListener('keydown', onKey, true);

            slider.addEventListener('input', function () { setZoom(Number(slider.value)); });

            stage.addEventListener('pointerdown', function (e) {
                dragging = true;
                stage.classList.add('twc-drag');
                stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
                startX = e.clientX; startY = e.clientY;
                startOffX = offsetX; startOffY = offsetY;
            });
            stage.addEventListener('pointermove', function (e) {
                if (!dragging) return;
                offsetX = startOffX + (e.clientX - startX);
                offsetY = startOffY + (e.clientY - startY);
                clampPan();
                draw();
            });
            function endDrag() { dragging = false; stage.classList.remove('twc-drag'); }
            stage.addEventListener('pointerup', endDrag);
            stage.addEventListener('pointercancel', endDrag);

            // Pinch to zoom on touch, without fighting the drag handler.
            stage.addEventListener('touchstart', function (e) {
                if (e.touches.length !== 2) return;
                var dx = e.touches[0].clientX - e.touches[1].clientX;
                var dy = e.touches[0].clientY - e.touches[1].clientY;
                pinchStart = Math.hypot(dx, dy);
                pinchZoom = zoom;
            }, { passive: true });
            stage.addEventListener('touchmove', function (e) {
                if (e.touches.length !== 2 || !pinchStart) return;
                var dx = e.touches[0].clientX - e.touches[1].clientX;
                var dy = e.touches[0].clientY - e.touches[1].clientY;
                var dist = Math.hypot(dx, dy);
                if (dist > 0) setZoom(pinchZoom * (dist / pinchStart));
                e.preventDefault();
            }, { passive: false });
            stage.addEventListener('touchend', function () { pinchStart = 0; });

            useBtn.addEventListener('click', function () {
                if (!useBtn || done) return;
                useBtn.disabled = true;
                var size = Math.max(128, Math.min(1024, Number(options.size) || 512));
                var out = document.createElement('canvas');
                out.width = size; out.height = size;
                var octx = out.getContext('2d');
                var ratio = size / stageSize;
                octx.imageSmoothingQuality = 'high';
                octx.fillStyle = '#fff';
                octx.fillRect(0, 0, size, size);
                var scale = base * zoom * ratio;
                var w = img.width * scale;
                var h = img.height * scale;
                var cx = size / 2 + offsetX * ratio;
                var cy = size / 2 + offsetY * ratio;
                octx.drawImage(img, cx - w / 2, cy - h / 2, w, h);

                var type = options.type || 'image/jpeg';
                var name = (file.name || 'avatar').replace(/\.[^.]+$/, '') + '-cropped.jpg';
                var finishFile = function (blob) {
                    if (!blob) { finish(null); return; }
                    var cropped;
                    try { cropped = new File([blob], name, { type: blob.type || type, lastModified: Date.now() }); }
                    catch (err) { cropped = blob; cropped.name = name; }
                    finish(cropped);
                };
                if (out.toBlob) out.toBlob(finishFile, type, 0.92);
                else {
                    var data = out.toDataURL(type, 0.92).split(',')[1];
                    var bin = atob(data);
                    var bytes = new Uint8Array(bin.length);
                    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    finishFile(new Blob([bytes], { type: type }));
                }
            });

            img.onload = function () {
                base = Math.max(stageSize / img.width, stageSize / img.height);
                offsetX = 0; offsetY = 0;
                draw();
                useBtn.disabled = false;
            };
            img.onerror = function () { finish(null); };
            useBtn.disabled = true;
            img.src = url;
        });
    }

    window.TimawaAvatarCrop = { open: open };
})();
