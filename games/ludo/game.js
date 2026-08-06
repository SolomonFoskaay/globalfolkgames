// Game State Core Engine Pointers
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

function isTokenInHomeYard(color, token) {
    if (color === 'green' && token.c < 6 && token.r < 6) return true;
    if (color === 'yellow' && token.c > 8 && token.r < 6) return true;
    if (color === 'blue' && token.c > 8 && token.r > 8) return true;
    if (color === 'red' && token.c < 6 && token.r > 8) return true;
    return false;
}

function isTokenMovable(color, token, index) {
    if (color !== currentTurn || !isDiceRolled || currentTurnMoves.length === 0) return false;
    const inYard = isTokenInHomeYard(color, token);
    return currentTurnMoves.some(m => inYard ? m === 6 : true);
}

function rollDiceEngine() {
    if (isDiceRolled && hasRolledThisTurn) return;
    isDiceRolled = true;
    hasRolledThisTurn = true;
    displayDiceOnBoard = true;

    document.getElementById('val-total').innerText = 'Rolling...';

    // Inject parameters inside the physics script tracking array
    physicalDice = [
        { x: 260, y: 280, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 },
        { x: 310, y: 290, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 }
    ];

    if (physicsAnimationLoop) cancelAnimationFrame(physicsAnimationLoop);
    runDicePhysicsCalculations(); // Invoke static layout physics script runner
}

function finalizeDiceScores() {
    lastDiceRoll1 = physicalDice[0].value;
    lastDiceRoll2 = physicalDice[1].value;
    let totalSum = lastDiceRoll1 + lastDiceRoll2;

    document.getElementById('val-d1').innerText = lastDiceRoll1;
    document.getElementById('val-d2').innerText = lastDiceRoll2;
    document.getElementById('val-total').innerText = `= Total: ${totalSum}`;

    currentTurnMoves = [lastDiceRoll1, lastDiceRoll2];
    const uppercaseColor = currentTurn.toUpperCase();
    console.log(`[${uppercaseColor}] Roll Finalized: Die 1 = ${lastDiceRoll1}, Die 2 = ${lastDiceRoll2} (= Total: ${totalSum})`);

    if (lastDiceRoll1 === 6 && lastDiceRoll2 === 6) {
        consecutiveDoubleSixes++;
        console.log(`[${uppercaseColor}] Double Six! Bonus Streak: ${consecutiveDoubleSixes}/3`);
    } else {
        consecutiveDoubleSixes = 0;
    }

    setTimeout(() => {
        displayDiceOnBoard = false;
        let activeTokensList = tokens[currentTurn];
        let hasAnyValidMove = activeTokensList.some((t, idx) => isTokenMovable(currentTurn, t, idx));

        if (!hasAnyValidMove) {
            console.log(`[${uppercaseColor}] No valid moves available. Auto-passing turn.`);
            setTimeout(() => { passTurnSequence(); }, 1200);
        }
    }, 3500);
}

// Override board.js draw core to paint elements in clean succession
if (typeof drawLudoLayout === 'function') {
    window.drawLudoLayout = function() {
        if (!canvas) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let r = 0; r < GRID_SIZE; r++) {
            for (let c = 0; c < GRID_SIZE; c++) {
                ctx.strokeStyle = COLORS.gray; ctx.lineWidth = 1;
                ctx.strokeRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }
        }
        drawBigYard(0, 0, COLORS.green); drawBigYard(0, 9, COLORS.red);
        drawBigYard(9, 0, COLORS.yellow); drawBigYard(9, 9, COLORS.blue);
        for (let c = 1; c < 6; c++) drawCell(c, 7, COLORS.green); drawCell(1, 6, COLORS.green);
        for (let r = 1; r < 6; r++) drawCell(7, r, COLORS.yellow); drawCell(8, 1, COLORS.yellow);
        for (let c = 9; c < 14; c++) drawCell(c, 7, COLORS.blue); drawCell(13, 8, COLORS.blue);
        for (let r = 9; r < 14; r++) drawCell(7, r, COLORS.red); drawCell(6, 13, COLORS.red);
        drawCenterTriangles();
        drawAllTokens();
        renderPhysicalDiceCubes(); // Renders dice blocks smoothly on top
    };
}

function handleCanvasClick(event) {
    if (!isDiceRolled || currentTurnMoves.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const clickedCol = Math.floor(mouseX / CELL_SIZE);
    const clickedRow = Math.floor(mouseY / CELL_SIZE);

    let activeTokens = tokens[currentTurn];
    let selectedTokenIndex = activeTokens.findIndex((token, idx) => token.c === clickedCol && token.r === clickedRow && isTokenMovable(currentTurn, token, idx));

    if (selectedTokenIndex !== -1) {
        const uppercaseColor = currentTurn.toUpperCase();
        let currentPiece = activeTokens[selectedTokenIndex];
        let isInsideYard = isTokenInHomeYard(currentTurn, currentPiece);
        let appliedMoveValue = isInsideYard ? 6 : (currentTurnMoves.includes(6) ? 6 : currentTurnMoves[0]);

        if (isInsideYard) {
            const startPositionsMap = { green: {c: 1, r: 6}, yellow: {c: 8, r: 1}, blue: {c: 13, r: 8}, red: {c: 6, r: 13} };
            activeTokens[selectedTokenIndex] = startPositionsMap[currentTurn];
            console.log(`[${uppercaseColor}] Used 6 to release token [${selectedTokenIndex}] onto tracks.`);
        } else {
            currentPiece.c += appliedMoveValue;
            console.log(`[${uppercaseColor}] Moved token [${selectedTokenIndex}] forward by ${appliedMoveValue} steps.`);
        }

        let spentIndex = currentTurnMoves.indexOf(appliedMoveValue);
        if (spentIndex !== -1) currentTurnMoves.splice(spentIndex, 1);

        drawLudoLayout();

        if (currentTurnMoves.length > 0) {
            console.log(`[${uppercaseColor}] 1 Move remaining. Select another blinking token.`);
            if (!activeTokens.some((t, idx) => isTokenMovable(currentTurn, t, idx))) passTurnSequence();
            return;
        }

        if (consecutiveDoubleSixes > 0 && consecutiveDoubleSixes < 3) {
            console.log(`[${uppercaseColor}] Double Six Bonus Granted! Roll again.`);
            isDiceRolled = false; hasRolledThisTurn = false;
        } else {
            passTurnSequence();
        }
    }
}

function passTurnSequence() {
    let nextIndex = (turnSequence.indexOf(currentTurn) + 1) % turnSequence.length;
    currentTurn = turnSequence[nextIndex];
    isDiceRolled = false; hasRolledThisTurn = false; displayDiceOnBoard = false;
    lastDiceRoll1 = 0; lastDiceRoll2 = 0; currentTurnMoves = [];
    
    const turnIndicator = document.getElementById('turn-indicator');
    turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
    turnIndicator.style.color = colorsMap[currentTurn];
}

document.addEventListener('DOMContentLoaded', () => {
    const ludoCanvasElement = document.getElementById('ludoCanvas');
    if (ludoCanvasElement) ludoCanvasElement.addEventListener('click', handleCanvasClick);
});
