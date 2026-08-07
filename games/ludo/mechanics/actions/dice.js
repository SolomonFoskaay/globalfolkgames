function rollDiceEngine(source) {
    if (!setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match inactive. Click 'Start Arena Match' button first.");
        return;
    }

    // Intercept if user suspended the active arena engine
    if (isGamePaused) {
        displayEducationalLog("PAUSED: Match is suspended. Click 'Resume' to continue.");
        return;
    }

    if (playerProfiles[currentTurn].mode === 'computer' && source !== 'AI_CONFIRMED') {
        displayEducationalLog(`ANTI-CHEAT: Automated computer turn loop active. Manual bypass blocked.`);
        return;
    }

    if (isDiceRolled && hasRolledThisTurn) return;
    isDiceRolled = true;
    hasRolledThisTurn = true;
    displayDiceOnBoard = true;

    const totalDisplay = document.getElementById('val-total');
    if (totalDisplay) totalDisplay.innerText = 'Rolling...';
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

    const d1Box = document.getElementById('val-d1');
    const d2Box = document.getElementById('val-d2');
    const totalBox = document.getElementById('val-total');

    if (d1Box) d1Box.innerText = lastDiceRoll1;
    if (d2Box) d2Box.innerText = lastDiceRoll2;
    if (totalBox) totalBox.innerText = `= Total: ${totalSum}`;

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
        if (isGamePaused) return; // Suspend processing if paused during the roll sequence
        displayDiceOnBoard = false;

        if (!hasAnyValidMoveForCurrentTurn()) {
            displayEducationalLog(`${upperColor}: No valid options available. Auto-passing turn.`);
            setTimeout(passTurnSequence, 1500);
        } else {
            if (playerProfiles[currentTurn].mode === 'computer') {
                setTimeout(() => {
                    if (isGamePaused) return;
                    if (typeof executeAutomatedComputerMove === 'function') {
                        executeAutomatedComputerMove();
                    }
                }, 1500);
            }
        }
    }, 3500);
}

function hasAnyValidMoveForCurrentTurn() {
    if (!tokens || !tokens[currentTurn]) return false;
    return tokens[currentTurn].some((token, index) => isTokenMovable(currentTurn, token, index));
}
