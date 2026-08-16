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
        // (unless this die is locked to a provably-fair VRF result)
        if (Math.abs(die.vx) > 0.15 || Math.abs(die.vy) > 0.15) {
            if (die.finalValue == null) die.value = Math.floor(Math.random() * 6) + 1;
            piecesStillMoving = true;
        } else if (die.finalValue != null) {
            // Velocity stopped -> snap to the VRF-locked face
            die.value = die.finalValue;
        }

        // Boundary Collisions: Bounce off 600x600 canvas parameters
        const size = 46;
        if (die.x < 0 || die.x > 600 - size) { die.vx *= -1; die.x = Math.max(0, Math.min(die.x, 600 - size)); }
        if (die.y < 0 || die.y > 600 - size) { die.vy *= -1; die.y = Math.max(0, Math.min(die.y, 600 - size)); }
    });

    if (piecesStillMoving) {
        physicsAnimationLoop = requestAnimationFrame(runDicePhysicsCalculations);
        // Render every physics tick directly so the tumble animates even when
        // the blink loop is idle (it no longer redraws at 60fps forever).
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
    } else {
        // Velocity stopped -> lock stable final calculation parameters
        finalizeDiceScores();
        // Draw one settled frame so the VRF-locked faces show immediately and
        // stay on the canvas (the idle blink loop no longer wipes them).
        if (typeof drawLudoLayout === 'function') drawLudoLayout();
    }
}

function renderPhysicalDiceCubes() {
    if (!displayDiceOnBoard || physicalDice.length !== 2) return;

    physicalDice.forEach(die => {
        const size = 46;
        const x = die.x + (32 - size) / 2;
        const y = die.y + (32 - size) / 2;
        const r = Math.max(4, size * 0.12);
        const value = die.value;

        ctx.save();

        // Soft drop shadow so the dice pop off the board on any screen.
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 3;
        ctx.shadowOffsetY = 4;

        // White die body — one path so fill + stroke share the same rounded shape.
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + size, y, x + size, y + size, r);
        ctx.arcTo(x + size, y + size, x, y + size, r);
        ctx.arcTo(x, y + size, x, y, r);
        ctx.arcTo(x, y, x + size, y, r);
        ctx.closePath();

        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Bevel: a subtle inner highlight across the top edge for a real die feel.
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + r, y + 1.5);
        ctx.arcTo(x + size, y + 1.5, x + size, y + size, r);
        ctx.stroke();

        // Pips as real dots (position map per face) — reliable on every device,
        // unlike unicode die glyphs that render inconsistently on mobile.
        const pipMap = {
            1: [[0.5, 0.5]],
            2: [[0.28, 0.28], [0.72, 0.72]],
            3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
            4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
            5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
            6: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.5], [0.72, 0.5], [0.28, 0.72], [0.72, 0.72]]
        }[value] || [[0.5, 0.5]];

        const pipRadius = Math.max(3.5, size * 0.075);
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        pipMap.forEach(([fx, fy]) => {
            ctx.moveTo(x + size * fx + pipRadius, y + size * fy);
            ctx.arc(x + size * fx, y + size * fy, pipRadius, 0, Math.PI * 2);
        });
        ctx.fill();

        ctx.restore();
    });
}
