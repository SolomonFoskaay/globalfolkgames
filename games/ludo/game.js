// Game State Core Engine Mapping
let currentTurn = 'green';
let lastDiceRoll1 = 0;
let lastDiceRoll2 = 0;
let isDiceRolled = false;

const turnSequence = ['green', 'yellow', 'blue', 'red'];
const colorsMap = { green: '#2ecc71', yellow: '#f1c40f', blue: '#3498db', red: '#e74c3c' };

// Vector Object Array Mapping for Physical In-Board Rolling Dice
let physicalDice = [];
let physicsAnimationLoop;

function rollDiceEngine() {
    if (isDiceRolled) return;
    isDiceRolled = true;

    // Reset results readout HUD elements
    document.getElementById('diceResult').innerText = '...';

    // Initialize 2 separate physical dice objects with random velocities
    physicalDice = [
        {
            x: 300, y: 300, 
            vx: (Math.random() * 15) - 7.5, vy: (Math.random() * 15) - 7.5, 
            value: 1, alpha: 1, timer: 0
        },
        {
            x: 280, y: 320, 
            vx: (Math.random() * 15) - 7.5, vy: (Math.random() * 15) - 7.5, 
            value: 1, alpha: 1, timer: 0
        }
    ];

    // Initiate the 60FPS physics step calculation runner loop
    if (physicsAnimationLoop) cancelAnimationFrame(physicsAnimationLoop);
    updateDicePhysics();
}

function updateDicePhysics() {
    let componentsStillMoving = false;

    // Redraw base ludo layers
    drawLudoLayout();

    physicalDice.forEach((die, index) => {
        // Apply friction decay velocity
        die.x += die.vx;
        die.y += die.vy;
        die.vx *= 0.95;
        die.vy *= 0.95;

        // Shuffle face values while moving rapidly
        if (Math.abs(die.vx) > 0.2 || Math.abs(die.vy) > 0.2) {
            die.value = Math.floor(Math.random() * 6) + 1;
            componentsStillMoving = true;
        }

        // Handle Boundary Collisions (Bounce off 600x600 canvas perimeter)
        const size = 35;
        if (die.x < 0 || die.x > 600 - size) { die.vx *= -1; die.x = Math.max(0, Math.min(die.x, 600 - size)); }
        if (die.y < 0 || die.y > 600 - size) { die.vy *= -1; die.y = Math.max(0, Math.min(die.y, 600 - size)); }

        // Trigger Fade Out Sequence once velocity drops below threshold
        if (!componentsStillMoving) {
            die.timer += 1;
            if (die.timer > 60) { // Start fading after 1 second
                die.alpha -= 0.05;
            }
        }

        // Draw individual physical dice blocks on top of canvas grid
        if (die.alpha > 0) {
            ctx.save();
            ctx.globalAlpha = die.alpha;
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 10;
            
            // Draw Dice Body Cube
            ctx.fillRect(die.x, die.y, size, size);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            ctx.strokeRect(die.x, die.y, size, size);

            // Draw Pip Dot text
            ctx.fillStyle = '#000000';
            ctx.font = 'bold 22px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            const dicePipFaces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
            ctx.fillText(dicePipFaces[die.value - 1], die.x + (size / 2), die.y + (size / 2));
            ctx.restore();
        }
    });

    if (componentsStillMoving || physicalDice[0].alpha > 0) {
        physicsAnimationLoop = requestAnimationFrame(updateDicePhysics);
    } else {
        // Animation finished -> Lock final rolling scores
        lastDiceRoll1 = physicalDice[0].value;
        lastDiceRoll2 = physicalDice[1].value;
        
        document.getElementById('diceResult').innerText =
          `${lastDiceRoll1} + ${lastDiceRoll2} = ${lastDiceRoll1 + lastDiceRoll2}`;
        console.log(`Verified Roll: ${lastDiceRoll1} and ${lastDiceRoll2}`);

        // Temporarily auto-passes turn for testing until complete move paths are finished
        setTimeout(() => {
            passTurnSequence();
        }, 2000);
    }
}

function handleCanvasClick(event) {
    if (!isDiceRolled || lastDiceRoll1 === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const clickedCol = Math.floor(mouseX / CELL_SIZE);
    const clickedRow = Math.floor(mouseY / CELL_SIZE);

    let activeTokens = tokens[currentTurn];
    let selectedTokenIndex = activeTokens.findIndex(token => token.c === clickedCol && token.r === clickedRow);

    if (selectedTokenIndex !== -1) {
        console.log(`Pawn selection success index: ${selectedTokenIndex}`);
        passTurnSequence();
    }
}

function passTurnSequence() {
    let nextIndex = (turnSequence.indexOf(currentTurn) + 1) % turnSequence.length;
    currentTurn = turnSequence[nextIndex];
    isDiceRolled = false;
    lastDiceRoll1 = 0;
    lastDiceRoll2 = 0;

    const turnIndicator = document.getElementById('turn-indicator');
    const resultDisplay = document.getElementById('diceResult');
    
    turnIndicator.innerText = `${currentTurn.charAt(0).toUpperCase() + currentTurn.slice(1)}'s Turn`;
    resultDisplay.innerText = '-';
    turnIndicator.style.color = colorsMap[currentTurn];
    
    // Clear out dice remains to leave canvas tidy
    drawLudoLayout();
}

document.addEventListener('DOMContentLoaded', () => {
    const ludoCanvasElement = document.getElementById('ludoCanvas');
    if (ludoCanvasElement) {
        ludoCanvasElement.addEventListener('click', handleCanvasClick);
    }
});