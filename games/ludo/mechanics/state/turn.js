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
    if (logBox) {
        logBox.innerText = message;
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            const retryBox = document.getElementById('ludo-log');
            if (retryBox) retryBox.innerText = message;
        });
    }
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
        
        // If the game is resumed during a computer player's turn, re-evaluate and trigger its actions
        if (playerProfiles[currentTurn].mode === 'computer') {
            setTimeout(() => {
                if (isGamePaused) return; // Guard check against rapid clicking
                if (!isDiceRolled) {
                    if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
                } else if (currentTurnMoves.length > 0) {
                    if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
                }
            }, 1000);
        }
    }
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
    if (diceBtn) {
        diceBtn.disabled = false;
    }
}

function initiateArenaMatch() {
    if (setupConfigurationLocked) return;

    let humanCount = 0;
    turnSequence.forEach(color => {
        const selectElement = document.getElementById(`type-${color}`);
        if (selectElement && selectElement.value === 'human') {
            humanCount++;
        }
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
            if (typeof triggerAutomatedComputerDiceRoll === 'function') {
                triggerAutomatedComputerDiceRoll();
            }
        }, 1200);
    }
}

function passTurnSequence() {
    if (isGamePaused) return; // Freeze turn cycling if game is paused

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
    drawLudoLayout(); 

    if (playerProfiles[currentTurn].mode === 'computer') {
        setTimeout(() => {
            if (isGamePaused) return;
            if (typeof triggerAutomatedComputerDiceRoll === 'function') {
                triggerAutomatedComputerDiceRoll();
            }
        }, 1500);
    }
}

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
});
