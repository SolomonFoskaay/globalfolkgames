let canvas;
let ctx;

const GRID_SIZE = 15;
let CELL_SIZE; 

const COLORS = {
    green: '#2ecc71',
    yellow: '#f1c40f',
    blue: '#3498db',
    red: '#e74c3c',
    white: '#ffffff',
    gray: '#2c3e50',
    dark: '#1a1a1a'
};

// Animation clock variables to control blinking states of valid targets
let globalBlinkAlpha = 1.0;
let blinkGrowing = false;

function drawLudoLayout() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Structural pathway grids
    for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
            ctx.strokeStyle = COLORS.gray;
            ctx.lineWidth = 1;
            ctx.strokeRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
    }

    // 2. Corner Base Yards
    drawBigYard(0, 0, COLORS.green);      
    drawBigYard(0, 9, COLORS.red);        
    drawBigYard(9, 0, COLORS.yellow);     
    drawBigYard(9, 9, COLORS.blue);       

    // 3. Pathways lines
    for (let c = 1; c < 6; c++) drawCell(c, 7, COLORS.green);
    drawCell(1, 6, COLORS.green); 

    for (let r = 1; r < 6; r++) drawCell(7, r, COLORS.yellow);
    drawCell(8, 1, COLORS.yellow); 

    for (let c = 9; c < 14; c++) drawCell(c, 7, COLORS.blue);
    drawCell(13, 8, COLORS.blue); 

    for (let r = 9; r < 14; r++) drawCell(7, r, COLORS.red);
    drawCell(6, 13, COLORS.red); 

    // 4. Draw Center Goal Triangles (Re-activated)
    drawCenterTriangles();

    // 5. Draw All Tokens on board layout layers
    drawAllTokens();
}

function drawCell(col, row, color) {
    ctx.fillStyle = color;
    ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    ctx.strokeStyle = COLORS.gray;
    ctx.strokeRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
}

function drawBigYard(startCol, startRow, color) {
    ctx.fillStyle = color;
    ctx.fillRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);
    ctx.strokeStyle = COLORS.white;
    ctx.lineWidth = 2;
    ctx.strokeRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);

    ctx.fillStyle = COLORS.white;
    ctx.beginPath();
    ctx.arc((startCol + 3) * CELL_SIZE, (startRow + 3) * CELL_SIZE, CELL_SIZE * 2, 0, Math.PI * 2);
    ctx.fill();
}

function drawCenterTriangles() {
    const centerStart = 6 * CELL_SIZE;
    const centerEnd = 9 * CELL_SIZE;
    const mid = 7.5 * CELL_SIZE;

    ctx.fillStyle = COLORS.green;
    ctx.beginPath();
    ctx.moveTo(centerStart, centerStart);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerStart, centerEnd);
    ctx.fill();

    ctx.fillStyle = COLORS.yellow;
    ctx.beginPath();
    ctx.moveTo(centerStart, centerStart);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerEnd, centerStart);
    ctx.fill();

    ctx.fillStyle = COLORS.blue;
    ctx.beginPath();
    ctx.moveTo(centerEnd, centerStart);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerEnd, centerEnd);
    ctx.fill();

    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.moveTo(centerStart, centerEnd);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerEnd, centerEnd);
    ctx.fill();
}

function drawAllTokens() {
    Object.keys(tokens).forEach(color => {
        tokens[color].forEach((token, index) => {
            const centerX = (token.c * CELL_SIZE) + (CELL_SIZE / 2);
            const centerY = (token.r * CELL_SIZE) + (CELL_SIZE / 2);
            const radius = CELL_SIZE * 0.35;

            // Check if this token belongs to the active turn player and is eligible to be moved
            let canThisPieceMove = false;
            if (typeof isTokenMovable === 'function') {
                canThisPieceMove = isTokenMovable(color, token, index);
            }

            ctx.save();
            // Apply pulsating opacity effect only to playable selections
            if (canThisPieceMove) {
                ctx.globalAlpha = globalBlinkAlpha;
                // Draw a glowing exterior circle halo vector ring
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius + 4, 0, Math.PI * 2);
                ctx.fill();
            }

            // Draw Token Base Shadow
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.beginPath();
            ctx.arc(centerX + 2, centerY + 2, radius, 0, Math.PI * 2);
            ctx.fill();

            // Draw Token Core Body
            ctx.fillStyle = COLORS[color];
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Crown center point dot
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    });
}

// 60FPS background clock engine loop specifically to animate blinking styles smoothly
function runBlinkAnimationEngine() {
    if (blinkGrowing) {
        globalBlinkAlpha += 0.04;
        if (globalBlinkAlpha >= 1.0) blinkGrowing = false;
    } else {
        globalBlinkAlpha -= 0.04;
        if (globalBlinkAlpha <= 0.3) blinkGrowing = true;
    }
    
    // Request canvas layout refresh updates if context is running
    if (canvas && ctx) {
        drawLudoLayout();
    }
    requestAnimationFrame(runBlinkAnimationEngine);
}

function initBoard() {
    canvas = document.getElementById('ludoCanvas');
    if (!canvas) return; 
    ctx = canvas.getContext('2d');
    CELL_SIZE = canvas.width / GRID_SIZE; 
    drawLudoLayout();
}

document.addEventListener('DOMContentLoaded', () => {
    initBoard();
    runBlinkAnimationEngine(); // Kick off animation processing ticks
});
