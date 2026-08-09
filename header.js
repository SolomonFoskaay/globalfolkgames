// header.js
// Shared modern header for Landing + all games

(function () {
    function renderHeader(options = {}) {
        const showLocal = options.showLocal || false;
        const localPoints = options.localPoints || 0;
        const gameName = options.gameName || '';

        // Remove old header if it somehow exists
        const old = document.querySelector('.gfg-header');
        if (old) old.remove();

        const headerHTML = `
            <header class="gfg-header">
                <div class="gfg-header-left">
                    <a href="/" class="gfg-brand">🌍 GlobalFolkGames</a>
                    ${gameName ? `<span class="gfg-game-tag">${gameName}</span>` : ''}
                </div>
                <div class="gfg-header-right">
                    ${showLocal ? `<span class="gfg-local-pts">Local: ${localPoints}</span>` : ''}
                    <div class="gfg-user-pill" id="gfg-user-pill">
                        <span id="display-points">⭐ 0 Pts</span>
                    </div>
                </div>
            </header>
        `;

        document.body.insertAdjacentHTML('afterbegin', headerHTML);

        // Tell profiles.js that the header is now ready
        if (typeof window.refreshAuthHeader === 'function') {
            window.refreshAuthHeader();
        }
    }

    window.initGlobalHeader = function (options) {
        renderHeader(options || {});
    };
})();