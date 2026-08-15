/**
 * GlobalFolkGames State Persistence Layer
 * Handles device-level state caching to safeguard matches during reloads.
 */

function displayEducationalLog(message) {
    console.log(message);
    const logBox = document.getElementById('ludo-log');
    if (logBox) logBox.innerText = message;
}

function saveGameStateToStorage() {
    const winState = (typeof window.serializeWinState === 'function')
        ? window.serializeWinState()
        : null;

    const statePayload = {
        currentTurn,
        lastDiceRoll1,
        lastDiceRoll2,
        isDiceRolled,
        currentTurnMoves,
        consecutiveDoubleSixes,
        hasRolledThisTurn,
        isGamePaused,
        setupConfigurationLocked,
        playerProfiles,
        matchMode: (typeof matchMode !== 'undefined') ? matchMode : '4p',
        activeSeats: (typeof getActiveSeats === 'function') ? getActiveSeats() : null,
        winState,
        tokensSnapshot: typeof tokens !== 'undefined' ? tokens : null
    };
    localStorage.setItem('gfg_ludo_persistence_state', JSON.stringify(statePayload));
}

function loadGameStateFromStorage() {
    const rawData = localStorage.getItem('gfg_ludo_persistence_state');
    if (!rawData) return false;

    try {
        const savedState = JSON.parse(rawData);
        
        currentTurn = savedState.currentTurn;
        lastDiceRoll1 = savedState.lastDiceRoll1;
        lastDiceRoll2 = savedState.lastDiceRoll2;
        isDiceRolled = savedState.isDiceRolled;
        currentTurnMoves = savedState.currentTurnMoves;
        consecutiveDoubleSixes = savedState.consecutiveDoubleSixes;
        hasRolledThisTurn = savedState.hasRolledThisTurn;
        isGamePaused = savedState.isGamePaused;
        setupConfigurationLocked = savedState.setupConfigurationLocked;

        // Restore the match mode (2P / 4P) FIRST so active-seat logic lines up.
        if (typeof matchMode !== 'undefined' && savedState.matchMode) {
            matchMode = savedState.matchMode === '2p' ? '2p' : '4p';
            // Restore the chosen 2P corner choice BEFORE the mode re-apply so
            // selectMatchMode('2p') preserves the player's two picked seats.
            if (savedState.activeSeats && Array.isArray(savedState.activeSeats) && savedState.activeSeats.length > 0) {
                if (typeof window.setActiveSeats === 'function') {
                    window.setActiveSeats(savedState.activeSeats);
                }
            }
            if (typeof window.selectMatchMode === 'function') {
                window.selectMatchMode(matchMode);
            }
        }
        
        for (let color in savedState.playerProfiles) {
            if (!playerProfiles[color]) continue;
            playerProfiles[color].mode = savedState.playerProfiles[color].mode || 'human';
            playerProfiles[color].isUser = savedState.playerProfiles[color].isUser === true;
        }

        // Restore crowns / finishing order + match outcome so they survive reloads.
        if (typeof window.hydrateWinState === 'function' && savedState.winState) {
            window.hydrateWinState(savedState.winState);
        }

        // A finished match restores to the ceremony (never resumes play).
        const restoredStatus = (typeof window.getMatchStatus === 'function')
            ? window.getMatchStatus() : 'in-progress';

        // An abandoned match never resumes: clear the cache back to fresh setup.
        if (restoredStatus === 'abandoned') {
            localStorage.removeItem('gfg_ludo_persistence_state');
            displayEducationalLog("Previous match was abandoned (never rewarded). Ready for a fresh match.");
            if (typeof window.resetWinDetection === 'function') window.resetWinDetection();
            setupConfigurationLocked = false;
            const startBtn = document.getElementById('startMatchBtn');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.style.background = '#2ecc71';
                startBtn.style.color = '#fff';
                startBtn.innerText = 'Start Arena Match';
            }
            turnSequence.forEach(color => {
                const selectElement = document.getElementById(`type-${color}`);
                if (selectElement) selectElement.disabled = false;
            });
            // Re-apply the mode's active-seat disable (2P: yellow + blue stay off).
            if (typeof window.getActiveSeats === 'function') {
                const active = window.getActiveSeats();
                turnSequence.forEach(color => {
                    const selectElement = document.getElementById(`type-${color}`);
                    if (selectElement && active.indexOf(color) === -1) selectElement.disabled = true;
                });
            }
            const diceBtn = document.getElementById('diceBtn');
            if (diceBtn) diceBtn.disabled = true;
            return true;
        }

        if (savedState.tokensSnapshot && typeof tokens !== 'undefined') {
            for (let color in tokens) {
                tokens[color] = savedState.tokensSnapshot[color];
            }
        }

        const turnIndicator = document.getElementById('turn-indicator');
        if (turnIndicator) {
            turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
            turnIndicator.style.color = colorsMap[currentTurn];
        }

        const d1Box = document.getElementById('val-d1');
        const d2Box = document.getElementById('val-d2');
        const totalBox = document.getElementById('val-total');
        if (d1Box) d1Box.innerText = lastDiceRoll1 || '-';
        if (d2Box) d2Box.innerText = lastDiceRoll2 || '-';
        if (totalBox) totalBox.innerText = lastDiceRoll1 ? `= Total: ${lastDiceRoll1 + lastDiceRoll2}` : 'Total: -';

        const pauseBtn = document.getElementById('pauseBtn');
        if (pauseBtn) {
            if (isGamePaused) {
                pauseBtn.innerText = '▶ Resume';
                pauseBtn.classList.add('paused-state');
            } else {
                pauseBtn.innerText = '⏸ Pause';
                pauseBtn.classList.remove('paused-state');
            }
        }

        turnSequence.forEach(color => {
            const selectElement = document.getElementById(`type-${color}`);
            if (selectElement) {
                selectElement.value = playerProfiles[color].isUser ? 'you' : playerProfiles[color].mode;
                selectElement.disabled = setupConfigurationLocked;
            }
        });
        // In 2P mode the yellow + blue seats are not part of the match: keep
        // their dropdowns disabled even when unlocked (restored pre-lock setup).
        if (typeof window.getActiveSeats === 'function') {
            const active = window.getActiveSeats();
            turnSequence.forEach(color => {
                const selectElement = document.getElementById(`type-${color}`);
                if (selectElement && active.indexOf(color) === -1) selectElement.disabled = true;
            });
        }

        const startBtn = document.getElementById('startMatchBtn');
        if (startBtn) {
            if (setupConfigurationLocked) {
                startBtn.disabled = true;
                startBtn.style.background = '#333';
                startBtn.style.color = '#666';
                startBtn.innerText = 'Match Active';
            } else {
                startBtn.disabled = false;
                startBtn.style.background = '#2ecc71';
                startBtn.style.color = '#fff';
                startBtn.innerText = 'Start Arena Match';
            }
        }

        const diceBtn = document.getElementById('diceBtn');
        if (diceBtn) diceBtn.disabled = !setupConfigurationLocked;

        displayEducationalLog(`STATE PERSISTENCE: Saved match recovered. Active Turn: ${currentTurn.toUpperCase()}`);
        
        if (typeof drawLudoLayout === 'function') drawLudoLayout();

        // A finished match must NOT resume the loop — re-show the ceremony.
        if (restoredStatus === 'finished') {
            if (typeof window.markMatchOver === 'function') window.markMatchOver();
            if (typeof window.showResultCeremony === 'function') window.showResultCeremony();
            return true;
        }

        if (setupConfigurationLocked && !isGamePaused && playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
                if (typeof matchOver !== 'undefined' && matchOver) return;
                if (!isDiceRolled) {
                    if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
                } else if (currentTurnMoves.length > 0) {
                    if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
                }
            }, 1500);
        }

        return true;
    } catch (e) {
        console.error("State recovery parsing error: ", e);
        return false;
    }
}

/**
 * Triggers the custom mobile warning confirmation overlay modal panel view
 */
function triggerManualArenaReset() {
    const customConfirmBox = document.getElementById('custom-confirm-overlay');
    if (customConfirmBox) {
        customConfirmBox.style.display = 'flex';
    }
}

/**
 * Handles action callbacks derived from clicking choice buttons in the warning dialogue portal box
 */
function handleConfirmationCallback(userApproved) {
    const customConfirmBox = document.getElementById('custom-confirm-overlay');
    if (customConfirmBox) {
        customConfirmBox.style.display = 'none'; // Clear window layout view out right away
    }

    if (!userApproved) {
        displayEducationalLog("RESET ABORTED: Match sequence preserved safely.");
        return;
    }

    // End Match: commit status=abandoned (never rewarded), then clear + reload.
    if (typeof window.endMatchAbandon === 'function') {
        window.endMatchAbandon();
        return;
    }

    // ===== RESET WIN DETECTION: Reset only the win-detection flag (so a new match can award points again) =====
    if (typeof window.resetWinDetection === 'function') {
        window.resetWinDetection();
    }
    // =============================================

    localStorage.removeItem('gfg_ludo_persistence_state');
    displayEducationalLog("SYSTEM RESET: Persistent cache cleared. Re-initializing arena canvas...");
    setTimeout(() => {
        window.location.reload();
    }, 500);
}