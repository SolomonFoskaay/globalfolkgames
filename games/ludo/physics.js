// Global Vector Objects shared with the controller engine
let physicalDice = [];
let physicsAnimationLoop;

function runDicePhysicsCalculations() {
    let piecesStillMoving = false;

    physicalDice.forEach(die => {
        die.x += die.vx;
        die.y += die.vy;
        die.vx *= 0.94; // Natural velocity decay friction
        die.vy *= 0.94;

        // Shuffle temporary face numbers while velocity vectors are active
        if (Math.abs(die.vx) > 0.15 || Math.abs(die.vy) > 0.15) {
            die.value = Math.floor(Math.random() * 6) + 1;
            piecesStillMoving = true;
        }

        // Boundary Collisions: Bounce off 600x600 canvas parameters
        const size = 35;
        if (die.x < 0 || die.x > 600 - size) { die.vx *= -1; die.x = Math.max(0, Math.min(die.x, 600 - size)); }
        if (die.y < 0 || die.y > 600 - size) { die.vy *= -1; die.y = Math.max(0, Math.min(die.y, 600 - size)); }
    });

    if (piecesStillMoving) {
        physicsAnimationLoop = requestAnimationFrame(runDicePhysicsCalculations);
    } else {
        // Velocity stopped -> lock stable final calculation parameters
        finalizeDiceScores();
    }
}

function renderPhysicalDiceCubes() {
    if (!displayDiceOnBoard || physicalDice.length !== 2) return;

    physicalDice.forEach(die => {
        const size = 32;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(die.x, die.y, size, size);
        ctx.strokeStyle = '#000000'; 
        ctx.lineWidth = 2;
        ctx.strokeRect(die.x, die.y, size, size);
        
        ctx.fillStyle = '#000000'; 
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center'; 
        ctx.textBaseline = 'middle';
        
        const dicePipFaces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        ctx.fillText(dicePipFaces[die.value - 1], die.x + (size / 2), die.y + (size / 2));
        ctx.restore();
    });
}
