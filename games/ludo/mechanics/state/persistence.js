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
        
        for (let color in savedState.playerProfiles) {
            playerProfiles[color].mode = savedState.playerProfiles[color].mode;
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
                selectElement.value = playerProfiles[color].mode;
                selectElement.disabled = setupConfigurationLocked;
            }
        });

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

        if (setupConfigurationLocked && !isGamePaused && playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
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

function triggerManualArenaReset() {
    const userConfirmed = confirm("⚠️ ATTENTION: Are you sure you want to abandon this match? All current progress will be lost permanently.");
    if (!userConfirmed) {
        displayEducationalLog("RESET CANCELLED: Returning to match arena.");
        return;
    }
    localStorage.removeItem('gfg_ludo_persistence_state');
    displayEducationalLog("SYSTEM RESET: Persistent cache cleared. Re-initializing arena canvas...");
    setTimeout(() => {
        window.location.reload();
    }, 500);
}
