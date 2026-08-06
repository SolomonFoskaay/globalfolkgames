// State Tracking Variables
let currentTurn = 'green';
let lastDiceRoll1 = 0;
let lastDiceRoll2 = 0;
let isDiceRolled = false;
let displayDiceOnBoard = false;

let currentTurnMoves = []; 
let consecutiveDoubleSixes = 0; 
let hasRolledThisTurn = false;

const turnSequence = ['green', 'yellow', 'blue', 'red'];
const colorsMap = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };

function displayEducationalLog(message) {
    const logBox = document.getElementById('ludo-log');
    if (logBox) logBox.innerHTML = message;
    console.log(message);
}

function passTurnSequence() {
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
    turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
    turnIndicator.style.color = colorsMap[currentTurn];
    
    displayEducationalLog(`${currentTurn.toUpperCase()}: New turn sequence initiated. Roll dice.`);
    drawLudoLayout(); 
}
