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

// Fixed alignment coordinates to position Red in the Bottom-Left and Yellow in the Top-Right
let tokens = {
    green:  [{c: 2, r: 2}, {c: 3, r: 2}, {c: 2, r: 3}, {c: 3, r: 3}],
    yellow: [{c: 11, r: 2}, {c: 12, r: 2}, {c: 11, r: 3}, {c: 12, r: 3}],
    blue:   [{c: 11, r: 11}, {c: 12, r: 11}, {c: 11, r: 12}, {c: 12, r: 12}],
    red:    [{c: 2, r: 11}, {c: 3, r: 11}, {c: 2, r: 12}, {c: 3, r: 12}]
};

function drawLudoLayout() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Grid lines
    for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
            ctx.strokeStyle = COLORS.gray;
            ctx.lineWidth = 1;
            ctx.strokeRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
    }

    // 2. Corner Base Yards
    drawBigYard(0, 0, COLORS.green);      // Top Left
    drawBigYard(0, 9, COLORS.red);        // Bottom Left (Corrected)
    drawBigYard(9, 0, COLORS.yellow);     // Top Right (Corrected)
    drawBigYard(9, 9, COLORS.blue);       // Bottom Right

    // 3. Track Pathways and Safety Zones
    for (let c = 1; c < 6; c++) drawCell(c, 7, COLORS.green);
    drawCell(1, 6, COLORS.green); 

    // Top Track center points to Yellow Home
    for (let r = 1; r < 6; r++) drawCell(7, r, COLORS.yellow);
    drawCell(8, 1, COLORS.yellow); 

    for (let c = 9; c < 14; c++) drawCell(c, 7, COLORS.blue);
    drawCell(13, 8, COLORS.blue); 

    // Bottom Track center points to Red Home
    for (let r = 9; r < 14; r++) drawCell(7, r, COLORS.red);
    drawCell(6, 13, COLORS.red); 

    // 4. Goal Triangles
    drawCenterTriangles();

    // 5. Render Tokens
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

    // Green Center Triangle (Left)
    ctx.fillStyle = COLORS.green;
    ctx.beginPath();
    ctx.moveTo(centerStart, centerStart);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerStart, centerEnd);
    ctx.fill();

    // Yellow Center Triangle (Top)
    ctx.fillStyle = COLORS.yellow;
    ctx.beginPath();
    ctx.moveTo(centerStart, centerStart);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerEnd, centerStart);
    ctx.fill();

    // Blue Center Triangle (Right)
    ctx.fillStyle = COLORS.blue;
    ctx.beginPath();
    ctx.moveTo(centerEnd, centerStart);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerEnd, centerEnd);
    ctx.fill();

    // Red Center Triangle (Bottom)
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.moveTo(centerStart, centerEnd);
    ctx.lineTo(mid, mid);
    ctx.lineTo(centerEnd, centerEnd);
    ctx.fill();
}

function drawAllTokens() {
    Object.keys(tokens).forEach(color => {
        tokens[color].forEach(token => {
            const centerX = (token.c * CELL_SIZE) + (CELL_SIZE / 2);
            const centerY = (token.r * CELL_SIZE) + (CELL_SIZE / 2);
            const radius = CELL_SIZE * 0.35;

            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.beginPath();
            ctx.arc(centerX + 2, centerY + 2, radius, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = COLORS[color];
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.4, 0, Math.PI * 2);
            ctx.fill();
        });
    });
}

function initBoard() {
    canvas = document.getElementById('ludoCanvas');
    if (!canvas) return; 
    ctx = canvas.getContext('2d');
    CELL_SIZE = canvas.width / GRID_SIZE; 
    drawLudoLayout();
}

document.addEventListener('DOMContentLoaded', initBoard);

setTimeout(() => {
    passTurnSequence();
}, 10000);
