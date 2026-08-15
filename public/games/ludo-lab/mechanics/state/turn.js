/**
 * GlobalFolkGames Core Game Loop Engine
 * Manages active player loops, tournament matching, and progression hooks.
 */

// Core Variable Definitions
let currentTurn = 'green';
let lastDiceRoll1 = 0;
let lastDiceRoll2 = 0;
let isDiceRolled = false;
let displayDiceOnBoard = false;

let currentTurnMoves = []; 
let consecutiveDoubleSixes = 0; 
let hasRolledThisTurn = false;

// Pause Loop Execution Control States
let isGamePaused = false;

// Endgame state (M1 locked spec): once ALL active seats are finished the loop
// STOPS (no infinite cycling, no reset-only ending) and a result ceremony
// 1st..4th + "Play Again" is shown. matchOver guards every action.
let matchOver = false;

// Anti-Cheat Automation Settings Engine States
let setupConfigurationLocked = false;
// `isUser` marks the seat bound to the signed-in Dynamic user (the "You" seat).
// Exactly ONE seat may be the user seat; it is always played as a human.
window.playerProfiles = {
    green: { mode: 'human', isUser: true },
    yellow: { mode: 'computer', isUser: false },
    blue: { mode: 'computer', isUser: false },
    red: { mode: 'computer', isUser: false }
};

const turnSequence = ['green', 'yellow', 'blue', 'red'];
const colorsMap = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };

// Match mode: '2p' (green + red, the opposite corners) or '4p' (all four).
// Selectable BEFORE the match locks; after lock it is frozen. Active seats in
// 2P mode are turnSequence[0] (green) and turnSequence[3] (red) — the classic
// 2-player Ludo setup. The locked spec's COMPLETED DEFINITION requires both
// seats (2P) or all four seats (4P) to finish, so the endgame + ceremony +
// seam all derive from the ACTIVE seats only.
let matchMode = '4p';
const MODE_ACTIVE_SEATS = {
    '2p': ['green', 'red'],
    '4p': ['green', 'yellow', 'blue', 'red'],
};
const ALL_SEATS = ['green', 'yellow', 'blue', 'red'];

// Active seats for the current mode (what the turn loop, endgame and seam use).
function getActiveSeats() {
    return MODE_ACTIVE_SEATS[matchMode] || MODE_ACTIVE_SEATS['4p'];
}
window.getActiveSeats = getActiveSeats;

// Public: select 2P / 4P before the match locks. In 2P, the yellow + blue
// seat dropdowns are disabled (their slots stay visible but greyed out).
window.selectMatchMode = function (mode) {
    if (setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match already active. Mode cannot be changed.");
        return;
    }
    matchMode = (mode === '2p') ? '2p' : '4p';

    const active = getActiveSeats();

    // Keep the signed-in 'You' seat on an ACTIVE seat: if the current 'You'
    // seat is no longer active (e.g. user was 'You' on yellow, then switched
    // to 2P), fall back to green. Otherwise leave the player's choice alone.
    const userOnActive = active.find(color => playerProfiles[color] && playerProfiles[color].isUser === true);
    if (!userOnActive) {
        turnSequence.forEach(color => { playerProfiles[color].isUser = false; });
        playerProfiles.green = { mode: 'human', isUser: true };
    }

    // Disable the seats that are NOT active in this mode.
    ALL_SEATS.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement) {
            selectElement.disabled = active.indexOf(color) === -1;
            selectElement.value = playerProfiles[color].isUser ? 'you' : playerProfiles[color].mode;
        }
    });

    const btn2 = document.getElementById('mode-2p');
    const btn4 = document.getElementById('mode-4p');
    if (btn2) btn2.classList.toggle('active', matchMode === '2p');
    if (btn4) btn4.classList.toggle('active', matchMode === '4p');

    displayEducationalLog(`Match mode: ${matchMode === '2p' ? '2 Players (Green vs Red)' : '4 Players'}.`);
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
};

function toggleArenaPauseState() {
    if (!setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match has not started yet. Cannot pause an inactive arena.");
        return;
    }

    isGamePaused = !isGamePaused;
    const pauseBtnElement = document.getElementById('pauseBtn');

    if (isGamePaused) {
        if (pauseBtnElement) {
            pauseBtnElement.innerText = '▶ Resume';
            pauseBtnElement.classList.add('paused-state');
        }
        displayEducationalLog("GAME PAUSED: Actions are suspended. Click 'Resume' to continue.");
    } else {
        if (pauseBtnElement) {
            pauseBtnElement.innerText = '⏸ Pause';
            pauseBtnElement.classList.remove('paused-state');
        }
        displayEducationalLog(`GAME RESUMED: Returning to active turn for ${currentTurn.toUpperCase()}.`);
        
        if (playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
                if (isGamePaused) return;
                if (!isDiceRolled) {
                    if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
                } else if (currentTurnMoves.length > 0) {
                    if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
                }
            }, 1000);
        }
    }
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
}

function lockSetupDropdowns() {
    if (setupConfigurationLocked) return;
    setupConfigurationLocked = true;
    matchOver = false;

    // New match: arm exactly one fresh provably-fair proof roll (first human turn).
    if (typeof resetOnchainProofRollUsed === 'function') resetOnchainProofRollUsed();
    
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement) {
            // 'you' maps to a human player; the isUser flag is set separately.
            playerProfiles[color].mode = selectElement.value === 'you' ? 'human' : selectElement.value;
            selectElement.disabled = true;
        }
    });

    const startBtn = document.getElementById('startMatchBtn');
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.background = '#333';
        startBtn.style.color = '#666';
        startBtn.style.cursor = 'not-allowed';
        startBtn.innerText = 'Match Active';
    }

    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = false;
    
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
}

function initiateArenaMatch() {
    if (setupConfigurationLocked) return;

    // Mandatory login: the match must be tied to the signed-in Dynamic user.
    const signedIn = !!(window.currentUser && (window.currentUser.dynamicId || window.currentUser.id));
    if (!signedIn) {
        displayEducationalLog("ERROR: Sign in to play. One seat must be assigned to the logged-in player (You).");
        if (typeof window.showAuthBanner === 'function') {
            window.showAuthBanner('Sign in to play GlobalFolkGames Ludo', true);
        }
        if (typeof window.openDynamicLogin === 'function') {
            window.openDynamicLogin();
        }
        return;
    }

    // Exactly one seat must be the logged-in user's seat ("You").
    const activeSeats = getActiveSeats();
    const userSeat = activeSeats.find(color => playerProfiles[color] && playerProfiles[color].isUser === true);
    if (!userSeat) {
        displayEducationalLog("ERROR: Assign the logged-in player to a seat — choose 'You' on one seat.");
        if (typeof window.showAuthBanner === 'function') {
            window.showAuthBanner('Choose "You" on a seat to begin the match', true);
        }
        return;
    }

    let humanCount = 0;
    activeSeats.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        const value = selectElement ? selectElement.value : playerProfiles[color].mode;
        if (value === 'human' || value === 'you') humanCount++;
    });

    if (humanCount === 0) {
        displayEducationalLog("ERROR: Integrity rule breach. At least one player seat must be Human.");
        return;
    }

    lockSetupDropdowns();
    displayEducationalLog(`${currentTurn.toUpperCase()}: Arena match successfully initiated. Roll dice.`);

    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        }, 1200);
    }
}

function passTurnSequence() {
    if (isGamePaused) return;
    if (matchOver) return;

    // Endgame guard: when all active seats are finished the loop must STOP.
    if (typeof window.allSeatsFinished === 'function' && window.allSeatsFinished()) {
        return;
    }

    // Advance only within the ACTIVE seats (2P: green<->red, 4P: all four).
    const active = getActiveSeats();
    let nextIndex = (active.indexOf(currentTurn) + 1) % active.length;
    currentTurn = active[nextIndex];

    // ENDGAME auto-skip: a finished seat (all 4 tokens off the board) has its
    // turn auto-passed (~1.5s log) with NO dice roll and NO tap — for human
    // AND computer seats alike. No skip-remaining toggle; End Match is the
    // only speed escape hatch (per the locked spec).
    if (typeof window.isSeatFinished === 'function' && window.isSeatFinished(currentTurn)) {
        displayEducationalLog(`${currentTurn.toUpperCase()}: All tokens home - auto-skipping turn.`);
        if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
        setTimeout(() => {
            if (isGamePaused || matchOver) return;
            passTurnSequence();
        }, 1500);
        return;
    }

    isDiceRolled = false; 
    hasRolledThisTurn = false; 
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0; 
    lastDiceRoll2 = 0; 
    currentTurnMoves = [];
    consecutiveDoubleSixes = 0; 
    if (typeof hideVerifyLink === 'function') hideVerifyLink(); 

    const turnIndicator = document.getElementById('turn-indicator');
    if (turnIndicator) {
        turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
        turnIndicator.style.color = colorsMap[currentTurn];
    }
    
    displayEducationalLog(`${currentTurn.toUpperCase()}: New turn sequence initiated. Roll dice.`);
    if (typeof drawLudoLayout === 'function') drawLudoLayout(); 

    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused || matchOver) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        }, 1500);
    }
}

// ===== ENDGAME (M1 locked spec) =====
// Called by win-detection.js the moment ALL active seats are finished. Stops
// the loop, locks every action and hands control to the result ceremony.
window.markMatchOver = function () {
    matchOver = true;
    isDiceRolled = true;
    hasRolledThisTurn = true;
    displayDiceOnBoard = false;
    currentTurnMoves = [];
    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = true;
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
};

// The result ceremony overlay: 1st..4th finish order + "Play Again".
window.showResultCeremony = function () {
    const overlay = document.getElementById('result-ceremony-overlay');
    if (!overlay) return;

    const order = (typeof window.getFinishOrder === 'function') ? window.getFinishOrder() : [];
    const listEl = document.getElementById('result-ceremony-list');
    if (listEl) {
        const medals = ['🥇', '🥈', '🥉', '4'];
        listEl.innerHTML = order.map((color, i) => {
            const medal = medals[i] || (i + 1);
            const isUser = window.playerProfiles && window.playerProfiles[color] && window.playerProfiles[color].isUser === true;
            const label = isUser ? 'You' : (window.playerProfiles && window.playerProfiles[color] && window.playerProfiles[color].mode === 'human' ? 'Human' : 'Computer');
            const name = color.charAt(0).toUpperCase() + color.slice(1);
            return `<div class="ceremony-row"><span class="ceremony-medal">${medal}</span><span class="ceremony-seat" style="color:${colorsMap[color]}">${name}</span><span class="ceremony-actor">${label}</span></div>`;
        }).join('');
    }

    const msgEl = document.getElementById('result-ceremony-msg');
    if (msgEl) {
        const winner = order && order[0];
        const winnerIsUser = winner && window.playerProfiles && window.playerProfiles[winner] && window.playerProfiles[winner].isUser === true;
        msgEl.innerText = winnerIsUser
            ? 'You win! Match complete — all seats finished.'
            : 'Match complete — all seats finished.';
    }

    overlay.classList.add('visible');
};

// "Play Again": start a fresh match with the SAME locked seat setup (no
// re-lock, no reload). Clears the finish order + match-over state, resets the
// board and drops straight back to the first turn.
window.playAgainAfterCeremony = function () {
    const overlay = document.getElementById('result-ceremony-overlay');
    if (overlay) overlay.classList.remove('visible');

    if (typeof window.resetWinDetection === 'function') window.resetWinDetection();
    if (typeof resetOnchainProofRollUsed === 'function') resetOnchainProofRollUsed();
    matchOver = false;
    currentTurn = 'green';
    isDiceRolled = false;
    hasRolledThisTurn = false;
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0;
    lastDiceRoll2 = 0;
    currentTurnMoves = [];
    consecutiveDoubleSixes = 0;
    if (typeof hideVerifyLink === 'function') hideVerifyLink();

    // Reset every token back to its home yard slot.
    Object.keys(window.tokens).forEach(color => {
        const home = HOME_YARDS[color];
        window.tokens[color].forEach((token, idx) => {
            token.pathIndex = -1;
            token.stepsWalked = 0;
            if (home && home[idx]) {
                token.c = home[idx].c;
                token.r = home[idx].r;
            }
        });
    });

    const turnIndicator = document.getElementById('turn-indicator');
    if (turnIndicator) {
        turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
        turnIndicator.style.color = colorsMap[currentTurn];
    }

    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = false;

    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
    if (typeof drawLudoLayout === 'function') drawLudoLayout();

    displayEducationalLog(`${currentTurn.toUpperCase()}: New match started. Roll dice.`);
    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused || matchOver) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        }, 1200);
    }
};

// End Match / ABANDONED: closes the match in game state as status=abandoned
// (never rewarded, never emits the seam), then clears the cached board.
window.endMatchAbandon = function () {
    if (typeof window.setMatchStatus === 'function') {
        window.setMatchStatus('abandoned');
    }
    matchOver = true;
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    const overlay = document.getElementById('result-ceremony-overlay');
    if (overlay) overlay.classList.remove('visible');

    // Best-effort on tab close: clear the cached board so no stale match
    // resumes, then reload to the fresh setup.
    localStorage.removeItem('gfg_ludo_persistence_state');
    displayEducationalLog('MATCH ABANDONED: Match closed as abandoned (never rewarded).');
    setTimeout(() => window.location.reload(), 500);
};

// Best-effort: if the tab closes mid-match, record status=abandoned so a
// reload never resumes a match that was abandoned (and it can never reward).
window.addEventListener('beforeunload', function () {
    try {
        if (setupConfigurationLocked && !matchOver && window.getMatchStatus && window.getMatchStatus() === 'in-progress') {
            if (typeof window.setMatchStatus === 'function') window.setMatchStatus('abandoned');
            if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
        }
    } catch (e) { /* best-effort only */ }
});

document.addEventListener('DOMContentLoaded', () => {
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement) {
            selectElement.value = playerProfiles[color].isUser ? 'you' : playerProfiles[color].mode;
            selectElement.addEventListener('change', (e) => {
                if (e.target.value === 'you') {
                    // A new seat became the user seat — release any previous one.
                    turnSequence.forEach(c => {
                        if (c !== color && playerProfiles[c].isUser) {
                            playerProfiles[c].isUser = false;
                            const prevEl = document.getElementById(`type-${c}`);
                            if (prevEl) prevEl.value = playerProfiles[c].mode;
                        }
                    });
                    playerProfiles[color].mode = 'human';
                    playerProfiles[color].isUser = true;
                } else {
                    playerProfiles[color].mode = e.target.value;
                    playerProfiles[color].isUser = false;
                }
                if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
            });
        }
    });

    setTimeout(() => {
        if (typeof loadGameStateFromStorage === 'function') {
            const stateFound = loadGameStateFromStorage();
            if (!stateFound) {
                displayEducationalLog("PERSISTENCE: Ready for fresh match setup.");
            }
        }
    }, 200);
});
