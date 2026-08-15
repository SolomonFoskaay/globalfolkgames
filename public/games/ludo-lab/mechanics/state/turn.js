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

// Endgame state (M1 locked spec, amended 2026-08-15): once the match is decided
// — at most ONE active seat left unfinished, the trailing seat auto-last — the
// loop STOPS (no infinite cycling, no reset-only ending) and a result ceremony
// 1st..Nth + "Play Again" is shown. matchOver guards every action.
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

// Match mode: '2p' (exactly TWO seats, user picks any two colours) or '4p'
// (all four). Selectable BEFORE the match locks; after lock it is frozen.
// The locked spec's COMPLETED DEFINITION requires every ACTIVE seat to finish
// (2P: both chosen seats, 4P: all four), so the turn loop, endgame, ceremony
// and seam all derive from the ACTIVE seats only.
let matchMode = '4p';
const ALL_SEATS = ['green', 'yellow', 'blue', 'red'];
let activeSeats = ALL_SEATS.slice();   // mutable: the seats actually in the match

// Active seats for the current mode (what the turn loop, endgame and seam use).
function getActiveSeats() {
    return activeSeats.slice();
}
window.getActiveSeats = getActiveSeats;

// Public: select 2P / 4P before the match locks. In 2P, the user picks ANY two
// colours (defaults to green + red); in 4P all four seats are active.
window.selectMatchMode = function (mode) {
    if (setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match already active. Mode cannot be changed.");
        return;
    }
    matchMode = (mode === '2p') ? '2p' : '4p';

    if (matchMode === '4p') {
        activeSeats = ALL_SEATS.slice();
    } else {
        // Keep any previous 2P choice; first time defaults to green + red.
        if (activeSeats.length !== 2) {
            activeSeats = ['green', 'red'];
        }
    }

    ensureUserOnActiveSeat();
    syncModeUI();
    displayEducationalLog(`Match mode: ${matchMode === '2p' ? '2 Players - tap a colour to pick your two seats' : '4 Players'}.`);
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
};

// Public: tap a seat colour to toggle it in/out of the match (2P only).
// During selection 1..2 seats stay active (so the pair can be freely swapped:
// remove one, add another); locking enforces EXACTLY two (initiateArenaMatch).
window.toggleActiveSeat = function (color) {
    if (setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match already active. Seats cannot be changed.");
        return;
    }
    if (matchMode !== '2p') {
        displayEducationalLog("Seat choice applies in 2 Players mode.");
        return;
    }

    const index = activeSeats.indexOf(color);
    if (index === -1) {
        // Adding beyond two is blocked — a 3rd seat has no turn slot in 2P.
        if (activeSeats.length >= 2) {
            displayEducationalLog("2 Players: exactly two seats play. Tap one of the active colours to swap it out first.");
            return;
        }
        activeSeats.push(color);
    } else {
        // Removing the last active seat is blocked — every match needs a seat.
        if (activeSeats.length <= 1) {
            displayEducationalLog("2 Players: at least one seat must stay active.");
            return;
        }
        activeSeats.splice(index, 1);
    }

    ensureUserOnActiveSeat();
    syncModeUI();
    displayEducationalLog(`2 Players: ${activeSeats.map(c => c.toUpperCase()).join(' vs ')}.`);
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();
};

// Keep the signed-in 'You' seat on an ACTIVE seat (never on a disabled one).
function ensureUserOnActiveSeat() {
    const userOnActive = activeSeats.find(color => playerProfiles[color] && playerProfiles[color].isUser === true);
    if (!userOnActive) {
        ALL_SEATS.forEach(color => { if (playerProfiles[color]) playerProfiles[color].isUser = false; });
        const first = activeSeats[0] || 'green';
        playerProfiles[first] = { mode: 'human', isUser: true };
    }
}

// Restore the previously chosen active seats (2P corner choice) on reload.
window.setActiveSeats = function (colors) {
    if (setupConfigurationLocked) return;
    if (Array.isArray(colors) && colors.length > 0) {
        activeSeats = colors.filter(color => ALL_SEATS.indexOf(color) !== -1);
        if (activeSeats.length !== 2) {
            activeSeats = ['green', 'red'];
        }
        ensureUserOnActiveSeat();
        syncModeUI();
    }
};

// Reflect the active/inactive seats in the setup slots: inactive seats get a
// bold INACTIVE badge and a greyed (disabled) dropdown; active seats are live.
function syncModeUI() {
    const btn2 = document.getElementById('mode-2p');
    const btn4 = document.getElementById('mode-4p');
    if (btn2) btn2.classList.toggle('active', matchMode === '2p');
    if (btn4) btn4.classList.toggle('active', matchMode === '4p');

    ALL_SEATS.forEach(color => {
        const slot = document.getElementById(`slot-${color}`);
        const selectElement = document.getElementById(`type-${color}`);
        const statusEl = document.getElementById(`seat-status-${color}`);
        const active = activeSeats.indexOf(color) !== -1;
        if (slot) slot.classList.toggle('inactive', !active);
        if (selectElement) {
            selectElement.disabled = !active;
            selectElement.value = playerProfiles[color].isUser ? 'you' : playerProfiles[color].mode;
        }
        if (statusEl) statusEl.style.display = active ? 'none' : 'inline';
    });
}

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

    // 2P mode locks with EXACTLY two active seats (corner choice is complete).
    if (matchMode === '2p' && activeSeats.length !== 2) {
        displayEducationalLog("ERROR: 2 Players needs exactly two active seats — tap the colour pills to pick your two.");
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

    // 2P fix: a fresh match must start on the signed-in user's seat (never an
    // inactive seat). Reset turn flags so the new turn starts clean.
    currentTurn = userSeat;
    isDiceRolled = false;
    hasRolledThisTurn = false;
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0;
    lastDiceRoll2 = 0;
    currentTurnMoves = [];

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

    // Endgame guard: once the match is decided (at most ONE active seat left
    // unfinished) the loop must STOP — the trailing seat is auto-last.
    if (typeof window.isMatchComplete === 'function' && window.isMatchComplete()) {
        return;
    }

    // Advance only within the ACTIVE seats (2P: the two chosen seats, 4P: all four).
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
            ? 'You win! Match complete.'
            : 'Match complete.';
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

// REFRESH-SAFE RESUME: no `beforeunload` abandonment. A reload mid-match must
// resume the exact same board (the stale-match clear lives in persistence.js:
// only an in-progress match untouched for 24h+ is treated as abandoned).

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
