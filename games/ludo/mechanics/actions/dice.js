function rollDiceEngine() {
    if (isDiceRolled && hasRolledThisTurn) return;
    isDiceRolled = true;
    hasRolledThisTurn = true;
    displayDiceOnBoard = true;

    document.getElementById('val-total').innerText = 'Rolling...';
    displayEducationalLog(`${currentTurn.toUpperCase()}: Rolling dice...`);

    physicalDice = [
        { x: 260, y: 280, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 },
        { x: 310, y: 290, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 }
    ];

    if (physicsAnimationLoop) cancelAnimationFrame(physicsAnimationLoop);
    runDicePhysicsCalculations();
}

function finalizeDiceScores() {
    lastDiceRoll1 = physicalDice[0].value;
    lastDiceRoll2 = physicalDice[1].value;
    let totalSum = lastDiceRoll1 + lastDiceRoll2;

    document.getElementById('val-d1').innerText = lastDiceRoll1;
    document.getElementById('val-d2').innerText = lastDiceRoll2;
    document.getElementById('val-total').innerText = `= Total: ${totalSum}`;

    currentTurnMoves = [lastDiceRoll1, lastDiceRoll2];
    const upperColor = currentTurn.toUpperCase();

    if (lastDiceRoll1 === 6 && lastDiceRoll2 === 6) {
        consecutiveDoubleSixes++;
        displayEducationalLog(`${upperColor}: Rolled a double 6! Bonus turn loaded.`);
    } else {
        consecutiveDoubleSixes = 0;
        displayEducationalLog(`${upperColor}: Rolled ${lastDiceRoll1} and ${lastDiceRoll2}. Select a blinking token.`);
    }

    setTimeout(() => {
        displayDiceOnBoard = false;

        if (!hasAnyValidMoveForCurrentTurn()) {
            displayEducationalLog(`${upperColor}: No valid options available. Auto-passing turn.`);
            setTimeout(passTurnSequence, 1200);
        }
    }, 3500);
}

function hasAnyValidMoveForCurrentTurn() {
    return tokens[currentTurn].some((token, index) => isTokenMovable(currentTurn, token, index));
}
