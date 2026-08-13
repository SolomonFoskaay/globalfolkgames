// Dice source indicator: 'onchain' (MagicBlock VRF on Solana) or 'offchain' (local)
let activeDiceSource = 'offchain';

// Provably-fair roll policy (Scope A): EVERY dice roll resolves on the
// MagicBlock ER VRF (gasless, fast queue):
//   - the signed-in player's seat ("You") rolls via the player's own delegated
//     dice PDA on every turn;
//   - computer seats roll via the server-side house key (POST /api/roll),
//     which is also delegated once and rolls gasless on the same ER queue;
//   - any seat falls back to local randomness only if VRF / the relay is
//     unreachable, so the match never hard-stalls.
// The flag is set when any on-chain roll succeeds; the last on-chain roll's
// signature is the verifiable proof of play used by the win-reward gate.
let onchainProofRollUsedThisMatch = false;
let lastProofRollSignature = null;

// Reward gates: the Ludo win-detector uses these to confirm the proof-of-play
// before awarding the +100 points for a 1st-place user finish.
window.getOnchainProofUsedThisMatch = () => onchainProofRollUsedThisMatch;
window.getLastProofRollSignature = () => lastProofRollSignature;

// Called by the match-start flow (turn.js lockSetupDropdowns) when a NEW match
// begins, so each match gets exactly one fresh proof roll.
function resetOnchainProofRollUsed() {
    onchainProofRollUsedThisMatch = false;
}

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

    // === PROVABLY-FAIR DICE (every roll, every seat) ===
    // Scope A: ALL dice now resolve on the MagicBlock ER VRF (fast, gasless
    // queue) - not just the first user roll:
    //   - "You" (signed-in user): every roll via the player's own delegated
    //     dice PDA (session key signs silently).
    //   - Computer seats: the server's house key rolls via POST /api/roll
    //     (the house dice account is sponsored+delegated once; the key never
    //     leaves the server). Result carries roll1/roll2/seed/signature.
    // If VRF / the relay is unreachable the game falls back to local
    // randomness (tagged in the log) so play never hard-stalls.
    const isComputerTurn = playerProfiles[currentTurn] && playerProfiles[currentTurn].mode === 'computer';
    const isUserSeat = playerProfiles[currentTurn] && playerProfiles[currentTurn].isUser === true;
    let rollValues = null;
    if (isUserSeat && window.magicblockDice && window.magicblockDice.available()) {
        try {
            if (totalDisplay) totalDisplay.innerText = 'VRF roll...';
            displayEducationalLog(`${currentTurn.toUpperCase()}: Requesting provably-fair roll [MagicBlock VRF on Solana Blockchain]...`);
            rollValues = await window.magicblockDice.roll();
            if (Array.isArray(rollValues) && rollValues.length === 2) {
                activeDiceSource = 'onchain';
                onchainProofRollUsedThisMatch = true;
                lastProofRollSignature = (window.magicblockDice && window.magicblockDice.getLastProofRollSignature)
                    ? window.magicblockDice.getLastProofRollSignature() : null;
                const explorerUrl = lastProofRollSignature
                    ? `https://explorer.solana.com/tx/${lastProofRollSignature}?cluster=devnet`
                    : null;
                console.log(`[MagicBlock VRF on Solana Blockchain] Your roll resolved on-chain: ${rollValues[0]} + ${rollValues[1]}`);
                console.log(`[Proof roll TX] ${explorerUrl ? explorerUrl : lastProofRollSignature}`);
                displayEducationalLog(`${currentTurn.toUpperCase()}: VRF roll ${rollValues[0]} + ${rollValues[1]} ${currentDiceSourceTag()}`);
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
        try {
            if (totalDisplay) totalDisplay.innerText = 'VRF roll...';
            const res = await fetch('/api/roll', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (res.ok) {
                const data = await res.json();
                if (data && Number.isInteger(data.roll1) && Number.isInteger(data.roll2)) {
                    rollValues = [data.roll1, data.roll2];
                    activeDiceSource = 'onchain';
                    const explorerUrl = data.signature
                        ? `https://explorer.solana.com/tx/${data.signature}?cluster=devnet`
                        : null;
                    console.log(`[MagicBlock VRF on Solana Blockchain] Computer roll resolved on-chain: ${data.roll1} + ${data.roll2} (seed ${data.seed})`);
                    console.log(`[Computer roll TX] ${explorerUrl ? explorerUrl : data.signature}`);
                    displayEducationalLog(`${currentTurn.toUpperCase()}: VRF computer roll ${data.roll1} + ${data.roll2} [MagicBlock VRF on Solana Blockchain]`);
                }
            }
        } catch (err) {
            console.error('[VRF] computer roll failed, using local fallback:', err);
        }
        if (!rollValues) {
            console.log('[Off-Chain Local Randomness] Computer VRF roll unavailable — using local roll.');
        }
    } else if (isUserSeat) {
        activeDiceSource = 'offchain';
        console.log('[Off-Chain Local Randomness] Your turn — rolling locally (VRF not available).');
    } else {
        activeDiceSource = 'offchain';
        console.log('[Off-Chain Local Randomness] Local human seat — rolling locally.');
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