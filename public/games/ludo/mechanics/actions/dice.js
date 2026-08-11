// Dice source indicator: 'onchain' (MagicBlock VRF on Solana) or 'offchain' (local)
let activeDiceSource = 'offchain';

// Bracket tag shown in the Ludo log + console so players know where the
// CURRENT dice click was resolved: on-chain (MagicBlock VRF on Solana) or not.
function currentDiceSourceTag() {
    return activeDiceSource === 'onchain'
        ? '[MagicBlock VRF on Solana Blockchain]'
        : '[Off-Chain Local Randomness]';
}

async function rollDiceEngine(source) {
    if (!setupConfigurationLocked) {
        displayEducationalLog("ERROR: Match inactive. Click 'Start Arena Match' button first.");
        return;
    }

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
    activeDiceSource = 'offchain'; // reset until the VRF path confirms otherwise

    const totalDisplay = document.getElementById('val-total');
    if (totalDisplay) totalDisplay.innerText = 'Rolling...';
    displayEducationalLog(`${currentTurn.toUpperCase()}: Rolling dice...`);

    // === PROVABLY-FAIR DICE (optional) ===
    // When the MagicBlock VRF module is configured + a wallet is connected,
    // request the true on-chain roll. Otherwise fall back to the existing
    // local randomness so the game keeps working identically.
    // Only HUMAN turns roll on-chain — computer turns always use local rolls.
    const isComputerTurn = playerProfiles[currentTurn] && playerProfiles[currentTurn].mode === 'computer';
    let rollValues = null;
    if (!isComputerTurn && window.magicblockDice && window.magicblockDice.available()) {
        try {
            if (totalDisplay) totalDisplay.innerText = 'VRF rolling...';
            displayEducationalLog(`${currentTurn.toUpperCase()}: Requesting on-chain randomness [MagicBlock VRF on Solana Blockchain]...`);
            rollValues = await window.magicblockDice.roll();
            if (Array.isArray(rollValues) && rollValues.length === 2) {
                activeDiceSource = 'onchain';
                console.log(`[MagicBlock VRF on Solana Blockchain] Dice roll resolved on-chain: ${rollValues[0]} + ${rollValues[1]}`);
                displayEducationalLog(`${currentTurn.toUpperCase()}: VRF result ${rollValues[0]} + ${rollValues[1]} ${currentDiceSourceTag()}`);
            }
        } catch (err) {
            console.error('[VRF] roll failed, using local fallback:', err);
            if (window.showAuthBanner) {
                window.showAuthBanner('On-chain dice unavailable — using local roll', true);
            }
            rollValues = null;
        }
    } else if (isComputerTurn) {
        activeDiceSource = 'offchain';
        console.log('[Off-Chain Local Randomness] Computer turn — rolling locally (VRF is human-only).');
    } else if (!window.magicblockDice || !window.magicblockDice.available()) {
        activeDiceSource = 'offchain';
        console.log('[Off-Chain Local Randomness] MagicBlock VRF on Solana not active — rolling locally.');
    }

    if (physicsAnimationLoop) cancelAnimationFrame(physicsAnimationLoop);

    if (rollValues && rollValues.length === 2) {
        // Dice are locked to the on-chain result (physics snaps to finalValue at rest)
        physicalDice = [
            { x: 260, y: 280, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: rollValues[0], finalValue: rollValues[0] },
            { x: 310, y: 290, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: rollValues[1], finalValue: rollValues[1] }
        ];
    } else {
        // Existing local-randomness behavior (identical to before)
        physicalDice = [
            { x: 260, y: 280, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 },
            { x: 310, y: 290, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: 1 }
        ];
    }

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
    const diceSourceTag = currentDiceSourceTag();

    if (lastDiceRoll1 === 6 && lastDiceRoll2 === 6) {
        consecutiveDoubleSixes++;
        displayEducationalLog(`${upperColor}: Rolled a double 6! Bonus turn loaded. ${diceSourceTag}`);
    } else {
        consecutiveDoubleSixes = 0;
        displayEducationalLog(`${upperColor}: Rolled ${lastDiceRoll1} and ${lastDiceRoll2}. Select a blinking token. ${diceSourceTag}`);
    }

    // Save state once dice scores are finalized
    if (typeof saveGameStateToStorage === 'function') saveGameStateToStorage();

    setTimeout(() => {
        if (isGamePaused) return; 
        displayDiceOnBoard = false;

        if (!hasAnyValidMoveForCurrentTurn()) {
            displayEducationalLog(`${upperColor}: No valid options available. Auto-passing turn.`);
            setTimeout(passTurnSequence, 1500);
        } else {
            if (playerProfiles[currentTurn].mode === 'computer') {
                setTimeout(() => {
                    if (isGamePaused) return;
                    if (typeof executeAutomatedComputerMove === 'function') executeAutomatedComputerMove();
                }, 1500);
            }
        }
    }, 3500);
}

function hasAnyValidMoveForCurrentTurn() {
    if (!tokens || !tokens[currentTurn]) return false;
    return tokens[currentTurn].some((token, index) => isTokenMovable(currentTurn, token, index));
}