/* ================================================================
   public-profile.js · TIMAWA — keeps each member's PUBLIC card up to date   (v1.0)
   index.html shows visitors (not signed in) every member's public card: only name, bio,
   occupation, interests and photo. Those five fields live in `publicProfiles/{uid}`;
   the full profile (email, birthday, location, socials ...) stays in `users`.

   - Load this on every signed-in page (dashboard, profile, calendar, admin).
   - A member's card is rewritten automatically whenever their profile changes
     (one tiny listener on their own `users/{uid}` document), so cards never go stale.
   - Admins can publish EVERY member's card at once: PublicProfile.backfill(users)
     (admin.html does this automatically and has a "Publish member cards" button).
   ================================================================ */
(function () {
    'use strict';
    if (window.PublicProfile) return;
    if (!window.firebase || !firebase.auth || !firebase.firestore) return;
    const auth = firebase.auth(), db = firebase.firestore();
    const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
    // identical to index.html's own sync, so both share the same "already published" signature
    function payloadOf(uid, p) {
        return { uid, displayName: cut(p.displayName, 60), bio: cut(p.bio, 300), occupation: cut(p.occupation, 80),
                 interests: Array.isArray(p.interests) ? p.interests.slice(0, 12).map(x => cut(x, 30)) : cut(p.interests, 200), photoURL: cut(p.photoURL, 500) };
    }
    const keyOf = uid => 'timawa_pp_' + uid;
    const unchanged = (uid, sig) => { try { return sessionStorage.getItem(keyOf(uid)) === sig; } catch (e) { return false; } };
    const remember = (uid, sig) => { try { sessionStorage.setItem(keyOf(uid), sig); } catch (e) { /* ignore */ } };
    const ts = () => firebase.firestore.FieldValue.serverTimestamp();

    async function writeCard(uid, profile) {
        const payload = payloadOf(uid, profile || {});
        if (!payload.displayName) return false;                  // nothing worth showing yet
        const sig = JSON.stringify(payload);
        if (unchanged(uid, sig)) return false;
        await db.collection('publicProfiles').doc(uid).set(Object.assign({}, payload, { updatedAt: ts() }));
        remember(uid, sig);
        return true;
    }
    // admins: publish many cards (skips the ones already up to date); returns how many were written
    async function backfill(users) {
        let n = 0;
        for (const u of (users || [])) {
            const id = u.id || u.uid; if (!id) continue;
            try { if (await writeCard(id, u)) n++; } catch (e) { console.warn('public card not published for', id, e.code || e.message); }
        }
        return n;
    }

    // admins: remove visitor cards whose member no longer exists. The homepage a
    // visitor sees is built from publicProfiles, not users — so deleting a member
    // used to leave their card on the public site while signed-in members no
    // longer saw them.
    async function prune(users) {
        const live = new Set((users || []).map(u => (u && (u.id || u.uid)) || '').filter(Boolean));
        if (!live.size) return 0;                 // never wipe every card from an empty/failed list
        let removed = 0;
        const snap = await db.collection('publicProfiles').get();
        let batch = db.batch(), pending = 0;
        for (const doc of snap.docs) {
            if (live.has(doc.id)) continue;
            batch.delete(doc.ref);
            pending++; removed++;
            if (pending === 400) { await batch.commit(); batch = db.batch(); pending = 0; }
        }
        if (pending) await batch.commit();
        return removed;
    }

    let unsub = null;
    auth.onAuthStateChanged(user => {
        if (unsub) { unsub(); unsub = null; }
        if (!user) return;
        unsub = db.collection('users').doc(user.uid).onSnapshot(
            snap => { if (snap.exists) writeCard(user.uid, snap.data()).catch(e => console.warn('public card not synced:', e.code || e.message)); },
            () => { /* not allowed / offline: nothing to do */ });
    });

    window.PublicProfile = { writeCard, backfill, prune, payloadOf };
})();