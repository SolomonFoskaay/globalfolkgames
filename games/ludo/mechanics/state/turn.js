// State Tracking Variables
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
const playerProfiles = {
    green: { mode: 'human' },
    yellow: { mode: 'computer' },
    blue: { mode: 'computer' },
    red: { mode: 'computer' }
};

const turnSequence = ['green', 'yellow', 'blue', 'red'];
const colorsMap = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };

function displayEducationalLog(message) {
    console.log(message);
    const logBox = document.getElementById('ludo-log');
    if (logBox) logBox.innerText = message;
}

/**
 * Commits the active volatile game variables directly into standard LocalStorage schema strings
 */
function saveGameStateToStorage() {
    // Rely on global variable pointers defined inside board.js and turn.js
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
        // Save the dynamic positioning coordinate fields for all color tokens from board.js
        tokensSnapshot: typeof tokens !== 'undefined' ? tokens : null
    };
    localStorage.setItem('gfg_ludo_persistence_state', JSON.stringify(statePayload));
}

/**
 * Parses and restores state matrices to resume active matches on refresh
 */
function loadGameStateFromStorage() {
    const rawData = localStorage.getItem('gfg_ludo_persistence_state');
    if (!rawData) return false;

    try {
        const savedState = JSON.parse(rawData);
        
        // Hydrate atomic variables
        currentTurn = savedState.currentTurn;
        lastDiceRoll1 = savedState.lastDiceRoll1;
        lastDiceRoll2 = savedState.lastDiceRoll2;
        isDiceRolled = savedState.isDiceRolled;
        currentTurnMoves = savedState.currentTurnMoves;
        consecutiveDoubleSixes = savedState.consecutiveDoubleSixes;
        hasRolledThisTurn = savedState.hasRolledThisTurn;
        isGamePaused = savedState.isGamePaused;
        setupConfigurationLocked = savedState.setupConfigurationLocked;
        
        // Restore player configuration structures
        for (let color in savedState.playerProfiles) {
            playerProfiles[color].mode = savedState.playerProfiles[color].mode;
        }

        // Restore game token coordinates in board.js if defined
        if (savedState.tokensSnapshot && typeof tokens !== 'undefined') {
            for (let color in tokens) {
                tokens[color] = savedState.tokensSnapshot[color];
            }
        }

        // Synchronize interface nodes
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

        // Re-align pause button styling states
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

        // Re-lock or reveal dropdown select containers 
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

        // If it was a computer's turn when the browser refreshed, resume automation pacing smoothly
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

/**
 * Wipes out storage keys and forces a layout boot reload to clear cached parameters
 */
function triggerManualArenaReset() {
    localStorage.removeItem('gfg_ludo_persistence_state');
    displayEducationalLog("SYSTEM RESET: Persistent cache cleared. Re-initializing arena canvas...");
    setTimeout(() => {
        window.location.reload();
    }, 800);
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
    saveGameStateToStorage();
}

function lockSetupDropdowns() {
    if (setupConfigurationLocked) return;
    setupConfigurationLocked = true;
    
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement) {
            playerProfiles[color].mode = selectElement.value;
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
    
    saveGameStateToStorage();
}

function initiateArenaMatch() {
    if (setupConfigurationLocked) return;

    let humanCount = 0;
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement && selectElement.value === 'human') humanCount++;
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

    let nextIndex = (turnSequence.indexOf(currentTurn) + 1) % turnSequence.length;
    currentTurn = turnSequence[nextIndex];
    
    isDiceRolled = false; 
    hasRolledThisTurn = false; 
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0; 
    lastDiceRoll2 = 0; 
    currentTurnMoves = [];
    consecutiveDoubleSixes = 0; 

    const turnIndicator = document.getElementById('turn-indicator');
    if (turnIndicator) {
        turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
        turnIndicator.style.color = colorsMap[currentTurn];
    }

    displayEducationalLog(`${currentTurn.toUpperCase()}: New turn sequence initiated. Roll dice.`);
    if (typeof drawLudoLayout === 'function') drawLudoLayout();

    saveGameStateToStorage();

    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') 
                triggerAutomatedComputerDiceRoll();
            }, 1500);
        }
    }
            
    // Coordinate loading sequences safely on document parse steps
    document.addEventListener('DOMContentLoaded', () => {
        turnSequence.forEach(color => {
            const selectElement = document.getElementById(`type-${color}`);
            if (selectElement) {
                playerProfiles[color].mode = selectElement.value;
                selectElement.addEventListener('change', (e) => {
                    playerProfiles[color].mode = e.target.value;
                });
            }
        });
        
    // Check if there is an existing persistent state payload available to recover
    setTimeout(() => {
        const stateFound = loadGameStateFromStorage();
        if (!stateFound) {
            displayEducationalLog("PERSISTENCE: No previous state found. Ready for fresh match setup.");
        }
    }, 200);
});
