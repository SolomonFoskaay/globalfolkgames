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
    const userSeat = turnSequence.find(color => playerProfiles[color] && playerProfiles[color].isUser === true);
    if (!userSeat) {
        displayEducationalLog("ERROR: Assign the logged-in player to a seat — choose 'You' on one seat.");
        if (typeof window.showAuthBanner === 'function') {
            window.showAuthBanner('Choose "You" on a seat to begin the match', true);
        }
        return;
    }

    let humanCount = 0;
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        const value = selectElement ? selectElement.value : playerProfiles[color].mode;
        if (value === 'human' || value === 'you') humanCount++;
    });

    if (humanCount === 0) {
        displayEducationalLog("ERROR: Integrity rule breach. At least one player seat must be Human.");
        return;
    }

    // M10 LIVES GATE: block the match start when today's free-play lives are
    // exhausted (refill at GMT+00). Reads window.gfgLives (loaded every page
    // via the header); when the module is absent play is NOT blocked.
    if (typeof window.gfgLives === 'object' && window.gfgLives && typeof window.gfgLives.get === 'function') {
        const lives = window.gfgLives.get();
        if (lives && lives.livesLeft <= 0) {
            const mins = Math.ceil((lives.resetsInMs || 0) / 60000);
            displayEducationalLog(`ERROR: No lives left for today. Lives refill at midnight (GMT+00)${mins > 0 ? `, about ${mins} min away` : ''}.`);
            if (typeof window.showAuthBanner === 'function') {
                window.showAuthBanner(`No lives left today. Your meter refills at midnight (GMT), roughly ${mins > 0 ? mins + ' minutes' : 'soon'}.\n\nBecome a Level-2 subscriber for 10 lives a day instead of 5.`, true);
            }
            return;
        }
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

    let nextIndex = (turnSequence.indexOf(currentTurn) + 1) % turnSequence.length;
    currentTurn = turnSequence[nextIndex];
    
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
            if (isGamePaused) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
        }, 1500);
    }
}

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
