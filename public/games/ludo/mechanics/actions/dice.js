// Dice source indicator: 'onchain' (MagicBlock VRF on Solana) or 'offchain' (local)
let activeDiceSource = 'offchain';

// Provably-fair roll policy (Scope A): EVERY dice roll resolves on the
// MagicBlock ER VRF (gasless, fast queue):
//   - the signed-in player's seat ("You") rolls via the player's own delegated
//     dice PDA on every turn;
//   - computer seats roll via the server-side house key (POST /api/roll),
//     which is also delegated once and rolls gasless on the same ER queue;
//   - there is NO offline fallback for core dice: a failed roll is retried,
//     and if the chain is genuinely down the match pauses with a banner and
//     auto-resumes (with an alert) once the on-chain network returns.
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

// === On-chain outage handling (no offline fallback) ===
// If the roll cannot be resolved on-chain we retry a few times, then PAUSE the
// match with a visible banner instead of ever rolling locally. An 8s monitor
// pings the stack; when the network returns we alert and auto-resume the
// paused turn (computer seats re-trigger, the human's turn gets re-armed).
const MAX_ROLL_ATTEMPTS = 3;
const ONCHAIN_RETRY_DELAY_MS = 1500;
const CHAIN_MONITOR_INTERVAL_MS = 8000;

let isChainDown = false;
let chainMonitorTimer = null;

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Renders a clickable "verify on-chain" link under the dice row. Cleared by
// each new turn (passTurnSequence) via hideVerifyLink().
function showVerifyLink(linkHtml) {
    if (!linkHtml) return;
    const el = document.getElementById('verify-tx-link');
    if (!el) return;
    el.innerHTML = linkHtml;
    el.style.display = 'block';
}

function hideVerifyLink() {
    const el = document.getElementById('verify-tx-link');
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
}

function showChainDownBanner(message, persistent = false) {
    if (typeof window.showAuthBanner === 'function') window.showAuthBanner(message, true);
    const el = document.getElementById('chain-down-banner');
    if (el) {
        el.textContent = message;
        el.classList.toggle('persistent', persistent);
        el.style.display = 'block';
    }
}

function ensureChainBannerElement() {
    if (document.getElementById('chain-down-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'chain-down-banner';
    banner.className = 'chain-down-banner';
    document.body.appendChild(banner);
}

function hideChainDownBanner() {
    const el = document.getElementById('chain-down-banner');
    if (el) el.style.display = 'none';
}

async function pingOnchainStack() {
    try {
        if (window.magicblockDice && typeof window.magicblockDice.ping === 'function') {
            return await window.magicblockDice.ping();
        }
    } catch (e) {
        console.warn('[VRF] chain ping failed:', e);
    }
    // Fallback: if the VRF ping helper is not ready yet, probe the relay's
    // passive health route (never triggers a roll).
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch('/api/endpoints', { signal: ctrl.signal });
        clearTimeout(timer);
        return res.ok;
    } catch (e) {
        return false;
    }
}

// Pause the ongoing turn (do NOT consume it) until the on-chain stack returns.
function enterChainDownState() {
    if (isChainDown) return;
    isChainDown = true;

    // Give back the turn so a roll can re-trigger when the network returns.
    isDiceRolled = false;
    hasRolledThisTurn = false;
    displayDiceOnBoard = false;
    currentTurnMoves = [];
    if (typeof hideVerifyLink === 'function') hideVerifyLink();

    const totalDisplay = document.getElementById('val-total');
    if (totalDisplay) totalDisplay.innerText = 'Awaiting network';
    const diceBtn = document.getElementById('diceBtn');
    if (diceBtn) diceBtn.disabled = true;

    ensureChainBannerElement();
    showChainDownBanner('On-chain dice are unavailable. Your match is paused and will resume automatically when the network returns.', true);
    displayEducationalLog(`${currentTurn.toUpperCase()}: On-chain dice unreachable. Match paused - will auto-resume when the network is back.`);

    if (!chainMonitorTimer) {
        chainMonitorTimer = setInterval(async () => {
            const ok = await pingOnchainStack();
            if (!ok || !isChainDown) return;
            // Network is back: stop monitoring and resume the paused turn.
            clearInterval(chainMonitorTimer);
            chainMonitorTimer = null;
            isChainDown = false;
            hideChainDownBanner();
            if (typeof window.showAuthBanner === 'function') window.showAuthBanner('On-chain dice are back - resuming your match.');
            displayEducationalLog(`${currentTurn.toUpperCase()}: On-chain dice are back. Resuming...`);
            const btn2 = document.getElementById('diceBtn');
            if (btn2) btn2.disabled = false;
            setTimeout(() => {
                if (isGamePaused) return;
                if (playerProfiles[currentTurn] && playerProfiles[currentTurn].mode === 'computer') {
                    if (typeof triggerAutomatedComputerDiceRoll === 'function') triggerAutomatedComputerDiceRoll();
                } else {
                    if (typeof rollDiceEngine === 'function') rollDiceEngine();
                }
            }, 1200);
        }, CHAIN_MONITOR_INTERVAL_MS);
    }
    return;
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

    // On-chain outage pause: never consume the turn nor roll locally.
    if (isChainDown) {
        displayEducationalLog(`${currentTurn.toUpperCase()}: On-chain dice are down. Waiting for the network to recover...`);
        return;
    }

    isDiceRolled = true;
    hasRolledThisTurn = true;
    displayDiceOnBoard = true;
    activeDiceSource = 'offchain'; // reset until the VRF path confirms otherwise

    const totalDisplay = document.getElementById('val-total');
    if (totalDisplay) totalDisplay.innerText = 'Rolling...';
    displayEducationalLog(`${currentTurn.toUpperCase()}: Rolling dice...`);

    // === PROVABLY-FAIR DICE (every roll, every seat — NO offline fallback) ===
    // Scope A: ALL dice now resolve on the MagicBlock ER VRF (fast, gasless
    // queue):
    //   - "You" (signed-in user): every roll via the player's own delegated
    //     dice PDA (session key signs silently).
    //   - Every other seat (computers + any extra local human): the server's
    //     house key rolls via POST /api/roll (sponsored+delegated once; the
    //     key never leaves the server). Result carries roll1/roll2/seed/sig.
    // If VRF / the relay is unreachable the roll is retried a few times; if it
    // is STILL down the match pauses (banner + monitor) and auto-resumes when
    // the on-chain network returns. Play NEVER falls back to local randomness.
    const isUserSeat = playerProfiles[currentTurn] && playerProfiles[currentTurn].isUser === true;
    let rollValues = null;
    for (let attempt = 1; attempt <= MAX_ROLL_ATTEMPTS && !rollValues; attempt++) {
        if (attempt > 1) await sleepMs(ONCHAIN_RETRY_DELAY_MS);
        if (isUserSeat && window.magicblockDice && window.magicblockDice.available()) {
            try {
                if (totalDisplay) totalDisplay.innerText = 'VRF roll...';
                displayEducationalLog(`${currentTurn.toUpperCase()}: Requesting provably-fair roll [MagicBlock VRF on Solana Blockchain]...`);
                const v = await window.magicblockDice.roll();
                if (Array.isArray(v) && v.length === 2) {
                    rollValues = v;
                    activeDiceSource = 'onchain';
                    onchainProofRollUsedThisMatch = true;
                    lastProofRollSignature = (window.magicblockDice && window.magicblockDice.getLastProofRollSignature)
                        ? window.magicblockDice.getLastProofRollSignature() : null;
                    const explorerUrl = lastProofRollSignature
                        ? (window.gfgExplorer && window.gfgExplorer.txUrl(lastProofRollSignature)) : null;
                    console.log(`[MagicBlock VRF on Solana Blockchain] Your roll resolved on-chain: ${rollValues[0]} + ${rollValues[1]}`);
                    console.log(`[Proof roll TX] ${explorerUrl ? explorerUrl : lastProofRollSignature}`);
                    displayEducationalLog(`${currentTurn.toUpperCase()}: VRF roll ${rollValues[0]} + ${rollValues[1]} ${currentDiceSourceTag()}`);
                    if (window.gfgExplorer && typeof window.gfgExplorer.txLink === 'function') {
                        showVerifyLink(window.gfgExplorer.txLink(lastProofRollSignature, 'Verify this roll on-chain'));
                    }
                }
            } catch (err) {
                console.error(`[VRF] roll attempt ${attempt}/${MAX_ROLL_ATTEMPTS} failed (retrying):`, err);
                rollValues = null;
            }
        } else {
            // Non-user seat (computer, or an extra local human): house roll.
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
                            ? (window.gfgExplorer && window.gfgExplorer.txUrl(data.signature)) : null;
                        console.log(`[MagicBlock VRF on Solana Blockchain] Computer roll resolved on-chain: ${data.roll1} + ${data.roll2} (seed ${data.seed})`);
                        console.log(`[Computer roll TX] ${explorerUrl ? explorerUrl : data.signature}`);
                        displayEducationalLog(`${currentTurn.toUpperCase()}: VRF computer roll ${data.roll1} + ${data.roll2} [MagicBlock VRF on Solana Blockchain]`);
                        if (window.gfgExplorer && typeof window.gfgExplorer.txLink === 'function') {
                            showVerifyLink(window.gfgExplorer.txLink(data.signature, 'Verify computer roll on-chain'));
                        }
                    }
                }
            } catch (err) {
                console.error(`[VRF] computer roll attempt ${attempt}/${MAX_ROLL_ATTEMPTS} failed (retrying):`, err);
                rollValues = null;
            }
        }
    }

    // NO local fallback: if every on-chain attempt failed, pause and wait.
    if (!rollValues || rollValues.length !== 2) {
        enterChainDownState();
        return;
    }

    if (physicsAnimationLoop) cancelAnimationFrame(physicsAnimationLoop);

    // Dice are locked to the on-chain result (physics snaps to finalValue at rest)
    physicalDice = [
        { x: 260, y: 280, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: rollValues[0], finalValue: rollValues[0] },
        { x: 310, y: 290, vx: (Math.random() * 12) - 6, vy: (Math.random() * 12) - 6, value: rollValues[1], finalValue: rollValues[1] }
    ];

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