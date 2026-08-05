// Game Core State Vectors
let currentTurn = 'green'; // Green always initiates the Ludo matrix
let lastDiceRoll = 0;
let isDiceRolled = false;

const diceFaces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const turnSequence = ['green', 'yellow', 'blue', 'red'];

function rollDiceEngine() {
    if (isDiceRolled) return; // Prevent double clicking while turn executes

    isDiceRolled = true;
    const diceBtn = document.getElementById('diceBtn');
    const resultDisplay = document.getElementById('diceResult');
    const turnIndicator = document.getElementById('turn-indicator');

    let rollCount = 0;
    // Simulate a visual rolling shuffle animation effect loop
    const rollInterval = setInterval(() => {
        const temporaryRandom = Math.floor(Math.random() * 6);
        diceBtn.innerText = diceFaces[temporaryRandom];
        rollCount++;

        if (rollCount > 6) {
            clearInterval(rollInterval);
            
            // Generate actual calculation result (1 to 6)
            lastDiceRoll = Math.floor(Math.random() * 6) + 1;
            diceBtn.innerText = diceFaces[lastDiceRoll - 1];
            resultDisplay.innerText = lastDiceRoll;

            console.log(`Standalone System Log: ${currentTurn} rolled a verified ${lastDiceRoll}`);

            // Automatically switch turn order sequence if no moves occur
            setTimeout(() => {
                passTurnSequence();
            }, 1200);
        }
    }, 80);
}

function passTurnSequence() {
    let nextIndex = (turnSequence.indexOf(currentTurn) + 1) % turnSequence.length;
    currentTurn = turnSequence[nextIndex];
    isDiceRolled = false;

    // Update floating HUD element markers
    const turnIndicator = document.getElementById('turn-indicator');
    const resultDisplay = document.getElementById('diceResult');
    
    turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
    resultDisplay.innerText = '-';

    // Update target color display states
    const colorsMap = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };
    turnIndicator.style.color = colorsMap[currentTurn];
}
