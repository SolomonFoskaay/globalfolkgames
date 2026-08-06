// Game Core State Controller Matrix Pointers
let currentTurn = 'green';
let lastDiceRoll1 = 0;
let lastDiceRoll2 = 0;
let isDiceRolled = false;
let displayDiceOnBoard = false;

const turnSequence = ['green', 'yellow', 'blue', 'red'];
const colorsMap = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };

let physicalDice = [];
let physicsAnimationLoop;

// Helper function to check if a token is still locked inside its home base quadrants
function isTokenInHomeYard(color, token) {
    if (color === 'green' && token.c < 6 && token.r < 6) return true;
    if (color === 'yellow' && token.c > 8 && token.r < 6) return true;
    if (color === 'blue' && token.c > 8 && token.r > 8) return true;
    if (color === 'red' && token.c < 6 && token.r > 8) return true;
    return false;
}

// Global rule selector evaluated dynamically inside board.js loops
function isTokenMovable(color, token, index) {
    if (color !== currentTurn || !isDiceRolled) return false;

    const inYard = isTokenInHomeYard(color, token);
    
    // Traditional Folk Rule entry checker: If stuck inside yard, requires a 6 on either die
    if (inYard) {
        if (lastDiceRoll1 === 6 || lastDiceRoll2 === 6) return true;
        return false; 
    }
    
    // If already open on shared tracks, pieces are always eligible to move
    return true;
}

function rollDiceEngine() {
    if (isDiceRolled) return;
    isDiceRolled = true;
    displayDiceOnBoard = true;

    // Reset layout panel readouts
    document.getElementById('val-d1').innerText = '-';
    document.getElementById('val-d2').innerText = '-';
    document.getElementById('val-total').innerText = 'Rolling...';

    physicalDice = [
        { x: 260, y: 280, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 },
        { x: 310, y: 290, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 }
    ];

    if (physicsAnimationLoop) cancelAnimationFrame(physicsAnimationLoop);
    updateDicePhysics();
}

function updateDicePhysics() {
    let piecesStillMoving = false;

    physicalDice.forEach(die => {
        die.x += die.vx;
        die.y += die.vy;
        die.vx *= 0.94;
        die.vy *= 0.94;

        if (Math.abs(die.vx) > 0.15 || Math.abs(die.vy) > 0.15) {
            die.value = Math.floor(Math.random() * 6) + 1;
            piecesStillMoving = true;
        }

        const size = 35;
        if (die.x < 0 || die.x > 600 - size) { die.vx *= -1; die.x = Math.max(0, Math.min(die.x, 600 - size)); }
        if (die.y < 0 || die.y > 600 - size) { die.vy *= -1; die.y = Math.max(0, Math.min(die.y, 600 - size)); }
    });

    if (piecesStillMoving) {
        physicsAnimationLoop = requestAnimationFrame(updateDicePhysics);
    } else {
        // Core values locked and perfectly matched with rendered pip faces
        lastDiceRoll1 = physicalDice[0].value;
        lastDiceRoll2 = physicalDice[1].value;
        let totalSum = lastDiceRoll1 + lastDiceRoll2;

        // Populate permanent text indicators immediately
        document.getElementById('val-d1').innerText = lastDiceRoll1;
        document.getElementById('val-d2').innerText = lastDiceRoll2;
        document.getElementById('val-total').innerText = `= Total: ${totalSum}`;

        console.log(`Roll finalized: Die 1 = ${lastDiceRoll1}, Die 2 = ${lastDiceRoll2} (= Total: ${totalSum})`);

        // Extended Visibility clock: In-board dice stay clean and readable on screen for 3.5 seconds
        setTimeout(() => {
            displayDiceOnBoard = false; // Hide from canvas drawing stack
            
            // Check if active player has ANY valid moves to make
            let activeTokensList = tokens[currentTurn];
            let hasAnyValidMove = activeTokensList.some((t, idx) => isTokenMovable(currentTurn, t, idx));

            // If player rolled no 6s and all tokens are stuck in the base yard -> auto-pass turn sequence safely
            if (!hasAnyValidMove) {
                console.log(`System notice: No available moves for ${currentTurn}. Auto-passing turn queue.`);
                setTimeout(() => { passTurnSequence(); }, 1500);
            }
        }, 3500);
    }
}

// Modify your global draw loops inside board.js to conditionally paint dice blocks
const originalDrawLudoLayout = typeof drawLudoLayout === 'function' ? drawLudoLayout : null;
if (typeof drawLudoLayout === 'function') {
    window.drawLudoLayout = function() {
        // Fire original canvas drawings layout layers
        if (canvas) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Re-map primitive block render cycles
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

            // Inject the floating physical 3D text dice blocks onto canvas layer if display flags are active
            if (displayDiceOnBoard && physicalDice.length === 2) {
                physicalDice.forEach(die => {
                    const size = 32;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(die.x, die.y, size, size);
                    ctx.strokeStyle = '#000000'; ctx.lineWidth = 2;
                    ctx.strokeRect(die.x, die.y, size, size);
                    
                    ctx.fillStyle = '#000000'; ctx.font = 'bold 20px sans-serif';
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    const dicePipFaces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
                    ctx.fillText(dicePipFaces[die.value - 1], die.x + (size / 2), die.y + (size / 2));
                });
            }
        }
    };
}

function handleCanvasClick(event) {
    if (!isDiceRolled || lastDiceRoll1 === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const clickedCol = Math.floor(mouseX / CELL_SIZE);
    const clickedRow = Math.floor(mouseY / CELL_SIZE);

    let activeTokens = tokens[currentTurn];
    let selectedTokenIndex = activeTokens.findIndex((token, idx) => token.c === clickedCol && token.r === clickedRow && isTokenMovable(currentTurn, token, idx));

    if (selectedTokenIndex !== -1) {
        console.log(`Action: Moving eligible piece token index [${selectedTokenIndex}]`);
        
        // Traditional entry jump script logic handler: Take piece out of base circle yard
        if (isTokenInHomeYard(currentTurn, activeTokens[selectedTokenIndex])) {
            const startPositionsMap = { green: {c: 1, r: 6}, yellow: {c: 8, r: 1}, blue: {c: 13, r: 8}, red: {c: 6, r: 13} };
            activeTokens[selectedTokenIndex] = startPositionsMap[currentTurn];
        } else {
            // Placeholder track push step: translate piece linearly 1 cell forward
            activeTokens[selectedTokenIndex].c += 1;
        }

        passTurnSequence();
    }
}

function passTurnSequence() {
    let nextIndex = (turnSequence.indexOf(currentTurn) + 1) % turnSequence.length;
    currentTurn = turnSequence[nextIndex];
    isDiceRolled = false;
    displayDiceOnBoard = false;
    lastDiceRoll1 = 0; lastDiceRoll2 = 0;

    const turnIndicator = document.getElementById('turn-indicator');
    turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
    turnIndicator.style.color = colorsMap[currentTurn];
}

document.addEventListener('DOMContentLoaded', () => {
    const ludoCanvasElement = document.getElementById('ludoCanvas');
    if (ludoCanvasElement) ludoCanvasElement.addEventListener('click', handleCanvasClick);
});
