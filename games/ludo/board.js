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

let globalBlinkAlpha = 1.0;
let blinkGrowing = false;

function drawLudoLayout() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
            ctx.strokeStyle = COLORS.gray; ctx.lineWidth = 1;
            ctx.strokeRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
    }

    drawBigYard(0, 0, COLORS.green);      
    drawBigYard(0, 9, COLORS.red);        
    drawBigYard(9, 0, COLORS.yellow);     
    drawBigYard(9, 9, COLORS.blue);       

    for (let c = 1; c < 6; c++) drawCell(c, 7, COLORS.green);
    drawCell(1, 6, COLORS.green); 

    for (let r = 1; r < 6; r++) drawCell(7, r, COLORS.yellow);
    drawCell(8, 1, COLORS.yellow); 

    for (let c = 9; c < 14; c++) drawCell(c, 7, COLORS.blue);
    drawCell(13, 8, COLORS.blue); 

    for (let r = 9; r < 14; r++) drawCell(7, r, COLORS.red);
    drawCell(6, 13, COLORS.red); 

    drawCenterTriangles();
    drawAllTokens();
}

function drawCell(col, row, color) {
    ctx.fillStyle = color; ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    ctx.strokeStyle = COLORS.gray; ctx.strokeRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
}

function drawBigYard(startCol, startRow, color) {
    ctx.fillStyle = color; ctx.fillRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);
    ctx.strokeStyle = COLORS.white; ctx.lineWidth = 2;
    ctx.strokeRect(startCol * CELL_SIZE, startRow * CELL_SIZE, CELL_SIZE * 6, CELL_SIZE * 6);
    ctx.fillStyle = COLORS.white; ctx.beginPath();
    ctx.arc((startCol + 3) * CELL_SIZE, (startRow + 3) * CELL_SIZE, CELL_SIZE * 2, 0, Math.PI * 2); ctx.fill();
}

function drawCenterTriangles() {
    const centerStart = 6 * CELL_SIZE; const centerEnd = 9 * CELL_SIZE; const mid = 7.5 * CELL_SIZE;
    ctx.fillStyle = COLORS.green; ctx.beginPath(); ctx.moveTo(centerStart, centerStart); ctx.lineTo(mid, mid); ctx.lineTo(centerStart, centerEnd); ctx.fill();
    ctx.fillStyle = COLORS.yellow; ctx.beginPath(); ctx.moveTo(centerStart, centerStart); ctx.lineTo(mid, mid); ctx.lineTo(centerEnd, centerStart); ctx.fill();
    ctx.fillStyle = COLORS.blue; ctx.beginPath(); ctx.moveTo(centerEnd, centerStart); ctx.lineTo(mid, mid); ctx.lineTo(centerEnd, centerEnd); ctx.fill();
    ctx.fillStyle = COLORS.red; ctx.beginPath(); ctx.moveTo(centerStart, centerEnd); ctx.lineTo(mid, mid); ctx.lineTo(centerEnd, centerEnd); ctx.fill();
}

function drawAllTokens() {
    // 1. Cluster all active pieces by their current grid cell position
    let gridOccupancyMap = {};

    Object.keys(tokens).forEach(color => {
        tokens[color].forEach((token, index) => {
            if (token.stepsWalked >= 57) return; // Hide completed tokens that reached the center

            const coordKey = `${token.c}_${token.r}`;
            if (!gridOccupancyMap[coordKey]) gridOccupancyMap[coordKey] = [];
            gridOccupancyMap[coordKey].push({ color: color, token: token, index: index });
        });
    });

    // 2. Render clustered pieces with dynamic side-by-side offsets
    Object.keys(gridOccupancyMap).forEach(coordKey => {
        let occupants = gridOccupancyMap[coordKey];
        let totalOccupantsCount = occupants.length;

        occupants.forEach((piece, subIndex) => {
            let baseCenterX = (piece.token.c * CELL_SIZE) + (CELL_SIZE / 2);
            let baseCenterY = (piece.token.r * CELL_SIZE) + (CELL_SIZE / 2);
            let radius = CELL_SIZE * 0.35;

            // Apply dynamic rendering offsets if multiple tokens occupy the same cell
            if (totalOccupantsCount > 1 && piece.token.pathIndex !== -1) {
                radius = CELL_SIZE * 0.18; // Shrink pawn radius
                
                // Distribute layout coordinates symmetrically in a 2x2 grid format inside the cell square
                let offsetShift = CELL_SIZE * 0.22;
                if (subIndex === 0) { baseCenterX -= offsetShift; baseCenterY -= offsetShift; }
                if (subIndex === 1) { baseCenterX += offsetShift; baseCenterY -= offsetShift; }
                if (subIndex === 2) { baseCenterX -= offsetShift; baseCenterY += offsetShift; }
                if (subIndex === 3) { baseCenterX += offsetShift; baseCenterY += offsetShift; }
            }

            let canThisPieceMove = false;
            if (typeof isTokenMovable === 'function') {
                canThisPieceMove = isTokenMovable(piece.color, piece.token, piece.index);
            }

            ctx.save();
            if (canThisPieceMove) {
                ctx.globalAlpha = globalBlinkAlpha;
                ctx.fillStyle = '#ffffff'; ctx.beginPath();
                ctx.arc(baseCenterX, baseCenterY, radius + 3, 0, Math.PI * 2); ctx.fill();
            }

            ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(baseCenterX + 1, baseCenterY + 1, radius, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = COLORS[piece.color]; ctx.beginPath(); ctx.arc(baseCenterX, baseCenterY, radius, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
            ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(baseCenterX, baseCenterY, radius * 0.4, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        });
    });
}

function runBlinkAnimationEngine() {
    if (blinkGrowing) {
        globalBlinkAlpha += 0.05; if (globalBlinkAlpha >= 1.0) blinkGrowing = false;
    } else {
        globalBlinkAlpha -= 0.05; if (globalBlinkAlpha <= 0.3) blinkGrowing = true;
    }
    if (canvas && ctx) drawLudoLayout();
    requestAnimationFrame(runBlinkAnimationEngine);
}

function initBoard() {
    canvas = document.getElementById('ludoCanvas'); if (!canvas) return;
    ctx = canvas.getContext('2d'); CELL_SIZE = canvas.width / GRID_SIZE;
    drawLudoLayout();
}

document.addEventListener('DOMContentLoaded', () => { initBoard(); runBlinkAnimationEngine(); });
