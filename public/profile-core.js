// profile-core.js
// Shared data helpers for the profile pages (home + detail). Reads the signed-in
// user's own Supabase records and their own on-chain points PDA only.
// Used by /profile/ (home) and its detail pages (/profile/activity.html,
// /profile/ledger.html).

(function () {

    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Load the signed-in user's point_transactions that carry an on-chain
    // match_id (proof-roll signature). Renders into el. `full` fetches all
    // rows (detail pages) vs a leaner cap on the profile home card.
    async function loadOnchainActivity(el, opts) {
        opts = opts || {};
        if (!window.supabaseClient || !window.currentUser) return;
        try {
            const { data, error } = await window.supabaseClient
                .from('point_transactions')
                .select('game_id, points, reason, match_id, created_at')
                .eq('user_id', window.currentUser.id)
                .not('match_id', 'is', null)
                .order('created_at', { ascending: false })
                .limit(opts.full ? 200 : 100);
            if (error) throw new Error(error.message);
            if (!data || !data.length) {
                el.innerHTML = '<p class="empty">No on-chain activity linked to your account yet. Play a match and win to see your verifiable rolls here.</p>';
                return;
            }
            const rows = data.map(t => {
                const game = t.game_id === 'ludo' ? 'Ludo' : esc(t.game_id);
                const reason = t.reason === 'win' ? '🏆 Match won'
                    : t.reason === 'tamper' ? '⚠ Tamper notice'
                    : esc(t.reason || 'Activity');
                const when = t.created_at ? '<span style="color:#666;font-size:0.75rem;"> ' + esc(t.created_at.slice(0, 16).replace('T', ' ')) + '</span>' : '';
                const link = window.gfgExplorer ? window.gfgExplorer.txLink(t.match_id) : esc(t.match_id);
                return `<div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <div style="font-weight:600;">${game} · ${reason}${t.points ? ' <span style="color:#f39c12;">(+' + esc(t.points) + ' pts)</span>' : ''}</div>
                    <div style="margin-top:4px;">${link}${when}</div>
                    <div style="color:#555;font-size:0.72rem; word-break:break-all; margin-top:2px;">${esc(t.match_id)}</div>
                </div>`;
            });
            if (window.GFG_Pager) {
                GFG_Pager.paginate(el, {
                    items: rows,
                    render: r => r,
                    empty: '<p class="empty">No on-chain activity linked to your account yet. Play a match and win to see your verifiable rolls here.</p>',
                    homePer: 6,
                });
            } else {
                el.innerHTML = rows.join('');
            }
        } catch (e) {
            el.innerHTML = '<p class="empty">Could not load on-chain activity (' + esc(e.message) + ').</p>';
        }
    }

    // Load the signed-in user's own on-chain points PDA ledger (gasless read,
    // own account only, per-game ledger). Renders into el.
    async function loadPointsLedger(el, gameTag) {
        gameTag = gameTag || 'ludo';
        const magic = window.magicblockDice;
        if (!magic || typeof magic.fetchPointsPda !== 'function' || typeof magic.pointsPda !== 'function') {
            el.innerHTML = '<p class="empty">On-chain ledger unavailable (wallet not ready).</p>';
            return;
        }
        const pda = magic.pointsPda(gameTag);
        if (!pda) {
            el.innerHTML = '<p class="empty">Connect your wallet to see your on-chain ledger.</p>';
            return;
        }
        try {
            const ledger = await magic.fetchPointsPda(gameTag);
            if (!ledger) {
                el.innerHTML = '<p class="empty">Your ledger account has no rewards yet. Win a match and your +100 reward is written here permanently.</p>';
                return;
            }
            const lastTs = ledger.lastRecordedTs
                ? new Date(ledger.lastRecordedTs).toLocaleString() : '—';
            const reasonLabel = ledger.lastReason === 1 ? 'Match won (1st place)'
                : (ledger.lastReason === 2 ? 'Match won (2nd place)'
                : (ledger.lastReason === 3 ? 'Match won (3rd place)'
                : (ledger.lastReason ? 'Award (' + ledger.lastReason + ')' : '—')));
            const pdaLink = window.gfgExplorer
                ? window.gfgExplorer.accountLink(pda) : esc(pda);
            el.innerHTML = `
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Lifetime points (pure)</span>
                    <b style="color:#f39c12; font-size:1.15rem;">${ledger.pureLifetime}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Spendable points</span>
                    <b style="color:#9b59b6;">${ledger.spendableBalance}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Rewards recorded</span>
                    <b>${ledger.awardCount}</b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last award</span>
                    <b>+${ledger.lastPoints} <span style="color:#666;font-size:0.78rem;">(${esc(reasonLabel)})</span></b>
                </div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last recorded</span>
                    <b style="font-size:0.82rem;">${esc(lastTs)}</b>
                </div>
                ${ledger.spendCount ? `
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Local spends</span>
                    <b>${ledger.spendCount}</b>
                </div>` : ''}
                <div style="padding:8px 0;">
                    <span style="color:var(--muted); font-size:0.82rem;">Ledger account (yours, game: ludo)</span>
                    <div style="margin-top:4px;">${pdaLink}</div>
                </div>`;
        } catch (e) {
            el.innerHTML = '<p class="empty">Could not read your ledger (' + esc(e.message) + ').</p>';
        }
    }

    // Collapsible homepage sections: sections marked .dash-section render
    // EXPANDED by default; clicking the header row collapses the section and
    // shows a one-line summary. Bound once on the header row so the inline
    // onclick + button listener never double-fire.
    function bindFolds() {
        document.querySelectorAll('.dash-section').forEach(function (section) {
            const head = section.querySelector('.dash-fold-head');
            const toggle = section.querySelector('.dash-fold-toggle');
            if (!head) return;
            const syncLabel = function () {
                if (toggle) {
                    toggle.textContent = section.classList.contains('collapsed') ? '＋ Expand' : '− Collapse';
                }
            };
            syncLabel();
            head.addEventListener('click', function () {
                section.classList.toggle('collapsed');
                syncLabel();
            });
        });
    }

    async function loadGlobalLedger(el) {
        const magic = window.magicblockDice;
        if (!magic || typeof magic.fetchGlobalPointsPda !== 'function') {
            el.innerHTML = '<p class="empty">Global ledgers unavailable (wallet not ready).</p>';
            return;
        }
        const pda = magic.globalPointsPda();
        if (!pda) {
            el.innerHTML = '<p class="empty">Connect your wallet to see your global ledgers.</p>';
            return;
        }
        try {
            const ledger = await magic.fetchGlobalPointsPda();
            if (!ledger) {
                el.innerHTML = '<p class="empty">No global ledger account yet. Win a match to create your cross-game record.</p>';
                return;
            }
            const lastTs = ledger.lastRecordedTs
                ? new Date(ledger.lastRecordedTs).toLocaleString() : '—';
            const pdaLink = window.gfgExplorer
                ? window.gfgExplorer.accountLink(pda) : esc(pda);
            const fmt = (n) => (n ?? 0).toLocaleString();
            el.innerHTML = `
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Pure (unspendable, never multiplied)</span>
                    <b style="color:#f39c12;font-size:1.15rem;">${fmt(ledger.pureLifetime)}</b>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Lifetime (unspendable, all sources)</span>
                    <b style="color:#9b59b6;">${fmt(ledger.lifetime)}</b>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Spendable</span>
                    <b style="color:#2ecc71;">${fmt(ledger.spendableBalance)}</b>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Game credits</span>
                    <b>${ledger.awardCount ?? 0}</b>
                </div>
                ${ledger.spendCount ? `
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Spends</span>
                    <b>${ledger.spendCount}</b>
                </div>` : ''}
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <span style="color:var(--muted);">Last credit</span>
                    <b style="font-size:0.82rem;">${esc(lastTs)}</b>
                </div>
                <div style="padding:8px 0;">
                    <span style="color:var(--muted);font-size:0.82rem;">Global ledger account (yours, site-wide)</span>
                    <div style="margin-top:4px;">${pdaLink}</div>
                </div>`;
        } catch (e) {
            el.innerHTML = '<p class="empty">Could not read global ledgers (' + esc(e.message) + ').</p>';
        }
    }

    window.ProfileCore = { esc, loadOnchainActivity, loadPointsLedger, loadGlobalLedger, bindFolds };

})();
