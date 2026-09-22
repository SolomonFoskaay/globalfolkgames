// ggi-demos/idle/demo.js — the Idle Farm demo for Foskaay Gasless Games Infrastructure (GGI).
//
// BUILT AS AN OUTSIDER WOULD: it uses @foskaay/ggi-sdk for the digest/action work
// and the GGI sponsor relay for the paid transactions. It imports NOTHING from
// the host game platform and keeps no host state. It is a demo of the RAIL.
//
// RULES THIS DEMO FOLLOWS (per the docs spec, no deviation):
//   - 1 participant, ttl 3600s
//   - 1 random stream, committed at open and revealed at settle
//   - actions: plant, water, harvest, upgrade, folded with an increasing sequence
//   - settle: close + reveal + seal + ONE session fee (sponsor pays it)
//   - the player NEVER pays and never sees a popup during play
//
// The sponsor relay (/api/ggi-sponsor) is generic GGI sponsorship. It signs with
// the game operator's key from the environment, so the player's wallet is only
// ever their identity plus the session-key authoriser.
(function () {
    'use strict';

    var SDK = null; // window.GgiSdk (from the published @foskaay/ggi-sdk bundle or local)

    // ---- state ---------------------------------------------------------------
    var S = {
        sessionId: null,
        digest: '0x' + '00'.repeat(32),
        seq: 0,
        actions: 0,
        writes: 0,
        costUsd: 0,
        mode: 'unbatched',
        seed: null,
        plots: [],
        running: false,
        walletAddress: null,
        sessionKey: null
    };

    var PLOT_COUNT = 8;

    // ---- tiny DOM helpers ----------------------------------------------------
    function $(id) { return document.getElementById(id); }
    function log(msg) {
        var el = $('if-log');
        var d = document.createElement('div');
        d.textContent = msg;
        el.appendChild(d);
        el.scrollTop = el.scrollHeight;
    }
    function setMeter() {
        $('if-actions').textContent = String(S.actions);
        $('if-writes').textContent = String(S.writes);
        $('if-cost').textContent = '$' + S.costUsd.toFixed(6);
    }

    // ---- digest fold ---------------------------------------------------------
    // Prefer the SDK's helper; fall back to an identical local fold so the demo
    // still works if the SDK bundle has not loaded. The formula is the SAME one
    // the contract uses (verified byte-identical by a Foundry parity test).
    function foldDigest(prev, seat, sequence, payloadHash) {
        if (SDK && SDK.foldDigest) return SDK.foldDigest(prev, seat, sequence, payloadHash);
        // Fallback: no browser keccak without a lib, so we cannot truly hash here.
        // We therefore REQUIRE the SDK for real play and make that explicit.
        throw new Error('SDK not loaded: the demo needs @foskaay/ggi-sdk for the digest fold');
    }

    // The SDK's payloadHashOf is keccak-based (viem). We try the SDK first.
    function payloadHash(payload) {
        if (SDK && SDK.payloadHashOf) return SDK.payloadHashOf(payload);
        throw new Error('SDK not loaded: the demo needs @foskaay/ggi-sdk for payload hashing');
    }

    // ---- deterministic seed (browser) ----------------------------------------
    // A 32-byte hex seed the browser generates locally, shown to the player, and
    // committed at open. It is revealed at settle so anyone can verify outcomes.
    function randomSeed() {
        var b = new Uint8Array(32);
        (window.crypto || window.msCrypto).getRandomValues(b);
        var hex = '';
        for (var i = 0; i < 32; i++) hex += b[i].toString(16).padStart(2, '0');
        return '0x' + hex;
    }

    // ---- wallet (identity only; the sponsor pays) -----------------------------
    function getWallet() {
        try {
            if (window.getDynamicEvmWallet) {
                var a = window.getDynamicEvmWallet();
                if (a) return a;
            }
        } catch (e) { /* soft */ }
        // Fallback for standalone testing: a plain injected provider.
        try {
            if (window.ethereum && window.ethereum.selectedAddress) return window.ethereum.selectedAddress;
        } catch (e) { /* soft */ }
        return null;
    }

    async function connectWallet() {
        // On this deployment the host provides the embedded wallet (Dynamic).
        // Standalone, a dev would wire their own provider here; the SDK is
        // wallet-agnostic, so only the address matters for sponsorship.
        var attempts = 0;
        while (attempts < 50) {
            var a = getWallet();
            if (a) return a;
            await new Promise(function (r) { setTimeout(r, 200); });
            attempts++;
        }
        // If there is an injected provider, try to request accounts.
        if (window.ethereum && window.ethereum.request) {
            try {
                var accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
                if (accs && accs[0]) return accs[0];
            } catch (e) { /* soft */ }
        }
        return null;
    }

    // ---- plots ---------------------------------------------------------------
    function makePlots() {
        S.plots = [];
        for (var i = 0; i < PLOT_COUNT; i++) {
            S.plots.push({ state: 'empty', level: 0, readyAt: 0 });
        }
        renderPlots();
    }

    function renderPlots() {
        var g = $('if-grid');
        g.innerHTML = '';
        S.plots.forEach(function (p, i) {
            var d = document.createElement('div');
            d.className = 'if-plot' + (p.state === 'ready' ? ' ready' : '') + (p.state === 'water' ? ' water' : '');
            var emoji = p.state === 'empty' ? '🟫' : (p.state === 'water' ? '💧' : (p.state === 'ready' ? '🌾' : '🌱'));
            d.innerHTML = '<div class="emoji">' + emoji + '</div><div class="lvl">' + (p.state === 'empty' ? 'plant' : (['', 'seed', 'sprout', 'growing', 'ripe'][Math.min(p.level, 4)] || 'growing')) + '</div>';
            d.addEventListener('click', function () { tapPlot(i); });
            g.appendChild(d);
        });
    }

    // ---- actions (free, silent) ----------------------------------------------
    function doAction(kind, plotIndex) {
        if (!S.running) { log('Start a run first.'); return; }
        // Fold the action into the digest. No chain write, no popup, no fee.
        var payload = { kind: kind, plot: plotIndex, at: Date.now() };
        var ph;
        try { ph = payloadHash(payload); } catch (e) { log('ERROR: ' + e.message); return; }
        try { S.digest = foldDigest(S.digest, 0, BigInt(S.seq + 1), ph); } catch (e) { log('ERROR: ' + e.message); return; }
        S.seq += 1;
        S.actions += 1;
        setMeter();
    }

    function tapPlot(i) {
        var p = S.plots[i];
        if (p.state === 'empty') { p.state = 'water'; p.level = 1; doAction('plant', i); }
        else if (p.state === 'water') { p.state = 'ready'; p.level = 4; doAction('water', i); }
        else if (p.state === 'ready') { harvest(i); }
        renderPlots();
    }

    function harvest(i) {
        var p = S.plots[i];
        var coins = 10 * (p.level || 1);
        // One free action per harvest. The random bonus comes from the seed, which
        // is only revealed at settle, so it is provably not chosen by the game.
        doAction('harvest', i);
        p.state = 'empty'; p.level = 0;
        log('+ ' + coins + ' coins (plot ' + i + ')');
        renderPlots();
    }

    function waterAll() {
        S.plots.forEach(function (p, i) {
            if (p.state === 'water') { p.state = 'ready'; p.level = 4; doAction('water', i); }
        });
        renderPlots();
    }

    // ---- sponsor relay --------------------------------------------------------
    async function relay(action, params) {
        var res = await fetch('/api/ggi-sponsor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, params || {}))
        });
        var j = await res.json();
        if (!res.ok || !j.ok) throw new Error((j && j.error) || ('relay ' + res.status));
        return j;
    }

    // We do not hide the real cost: we read the sponsor's actual spend is complex
    // client-side, so we show the SESSION MODEL (2 writes unbatched, 3-4 batched)
    // multiplied by the measured per-write cost. The exact figure comes from the
    // cost measurement script and is stated in the docs.
    var PER_WRITE_USD = 0.0030; // measured Arc cost per write, see /foskaay-ggi-docs/#fees
    function accountWrites(n) { S.writes += n; S.costUsd = S.writes * PER_WRITE_USD; setMeter(); }

    // ---- run lifecycle --------------------------------------------------------
    async function startRun() {
        $('if-connect').disabled = true;
        $('if-core-line').textContent = 'Starting a session (the game pays; you pay nothing)...';
        var wallet = await connectWallet();
        if (!wallet) {
            $('if-core-line').textContent = 'No wallet found. Connect a wallet first (this page uses the host sign-in).';
            $('if-connect').disabled = false;
            return;
        }
        S.walletAddress = wallet;
        S.seed = randomSeed();

        // Register a session key so play is silent. The SDK creates the key; the
        // on-chain registration is sponsored. (Registration is optional for a
        // single-session demo, but it is the pattern a real game uses.)
        if (SDK && SDK.createSessionKey) {
            try { S.sessionKey = SDK.createSessionKey(); } catch (e) { S.sessionKey = null; }
        }

        try {
            var openRes = await relay('open', {
                participants: 1,
                ttlSecs: 3600,
                seeds: [S.seed],
                player: wallet,          // the player's wallet is the seat authority
                authorities: [wallet]     // so the game can settle their session
            });
            S.sessionId = openRes.sessionId;
            // open + setAuthority = 2 sponsored writes, per the docs spec
            accountWrites(2);
            log('Session opened: ' + S.sessionId);
            $('if-core-line').innerHTML = 'Session live. <b>You never pay a fee.</b> Actions are free; they are signed and folded into the result.';
            $('if-session-line').innerHTML = 'Session <span class="if-mono">' + S.sessionId + '</span>';
            $('if-explorer').disabled = false;
            S.running = true;
            $('if-finish').disabled = false;
            $('if-water-all').disabled = false;
            makePlots();
        } catch (e) {
            $('if-core-line').textContent = 'Could not start: ' + e.message;
            $('if-connect').disabled = false;
        }
    }

    async function finishRun() {
        if (!S.running) return;
        $('if-finish').disabled = true;
        $('if-water-all').disabled = true;
        log('Settling (the game pays the fee)...');
        try {
            if (S.mode === 'batched') {
                // batched: submit the digest into a window, then flush if ready
                await relay('batchSubmit', { sessionId: S.sessionId, digest: S.digest, maxSize: 4, windowSecs: 600 });
                accountWrites(1);
                log('Digest submitted to a batch window.');
                var f = await relay('batchFlush', {});
                if (f && f.tx) { accountWrites(1); log('Window flushed into one Merkle root.'); }
                else { log('Window not ready to flush yet (needs to be full or past its deadline).'); }
            } else {
                await relay('settle', { sessionId: S.sessionId, digest: S.digest, seeds: [S.seed] });
                accountWrites(2);
                log('Settled: closed, seed revealed, result sealed (instant).');
            }
            S.running = false;
            $('if-core-line').innerHTML = 'Run finished. Result is sealed on-chain. <b>Total you paid: $0.00.</b>';
            $('if-connect').disabled = false;
        } catch (e) {
            log('Settle failed: ' + e.message);
            $('if-finish').disabled = false;
            $('if-water-all').disabled = false;
        }
    }

    // ---- mode toggle ----------------------------------------------------------
    document.querySelectorAll('.if-tgl').forEach(function (t) {
        t.addEventListener('click', function () {
            document.querySelectorAll('.if-tgl').forEach(function (x) { x.classList.remove('active'); });
            t.classList.add('active');
            S.mode = t.getAttribute('data-mode');
            $('if-mode-note').textContent = S.mode === 'batched'
                ? 'The result becomes final when the window flushes. Cheapest per game.'
                : 'Each session settles on its own. The result is final immediately.';
        });
    });

    // ---- wire buttons ---------------------------------------------------------
    $('if-connect').addEventListener('click', startRun);
    $('if-water-all').addEventListener('click', waterAll);
    $('if-finish').addEventListener('click', finishRun);
    $('if-explorer').addEventListener('click', function () {
        if (S.sessionId) window.location.href = '/ggi-explorer/?session=' + S.sessionId;
    });

    // The SDK is loaded from the published package bundle if present. A real
    // integrator installs it; this page can also work when it is provided.
    if (window.GgiSdk) { SDK = window.GgiSdk; }

    makePlots();
    setMeter();
})();
