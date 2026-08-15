// Global Vector Objects shared with the controller engine
let physicalDice = [];
let physicsAnimationLoop;

// Die body size in board pixels (100% bigger than the original 46px so the
// dice are clearly readable on small phone screens). Physics positions are
// the die's TOP-LEFT corner in the 600x600 board space.
const DICE_SIZE = 92;

// ============================ Natural dice sounds ============================
// Synthesised with the Web Audio API (no binary assets to ship or license).
// Every sound is a soft-fail: a browser without audio support or a blocked
// autoplay policy must NEVER block a dice roll.

let _diceAudioCtx = null;

function _getDiceAudioCtx() {
    try {
        if (!_diceAudioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            _diceAudioCtx = new AC();
        }
        if (_diceAudioCtx.state === 'suspended') _diceAudioCtx.resume();
        return _diceAudioCtx;
    } catch (e) {
        return null;
    }
}

// Rattle when the dice are thrown: a burst of filtered-noise clicks (the dice
// knocking together in the hand) ending with two high ticks (hitting the table).
function playDiceRattle() {
    try {
        const ctx = _getDiceAudioCtx();
        if (!ctx) return;
        const master = ctx.createGain();
        master.gain.value = 0.16;
        master.connect(ctx.destination);
        const t0 = ctx.currentTime;

        // ~7 short filtered-noise bursts = dice shaking together.
        for (let i = 0; i < 7; i++) {
            const t = t0 + i * 0.085 + Math.random() * 0.02;
            const dur = 0.045;
            const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
            const buf = ctx.createBuffer(1, len, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let j = 0; j < len; j++) data[j] = (Math.random() * 2 - 1) * (1 - j / len);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 900 + Math.random() * 1800;
            bp.Q.value = 1.1;
            const g = ctx.createGain();
            g.gain.setValueAtTime(1, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            src.connect(bp); bp.connect(g); g.connect(master);
            src.start(t); src.stop(t + dur);
        }

        // Two short high ticks when the dice land on the table.
        for (let i = 0; i < 2; i++) {
            const t = t0 + 0.62 + i * 0.055;
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = 1700 + i * 250;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.5, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
            osc.connect(g); g.connect(master);
            osc.start(t); osc.stop(t + 0.05);
        }
    } catch (e) { /* Audio is cosmetic — never block a roll. */ }
}

// Short click when a die hits a board edge or another die. Throttled so a
// chain of bounces sounds like a rattle, not machine-gun fire.
let _lastDiceTick = 0;

function playDiceTick() {
    try {
        const ctx = _getDiceAudioCtx();
        if (!ctx) return;
        const now = performance.now();
        if (now - _lastDiceTick < 70) return;
        _lastDiceTick = now;
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 2400;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.04);
    } catch (e) { /* cosmetic */ }
}

// ============================== Dice physics loop ==============================

function runDicePhysicsCalculations() {
    let piecesStillMoving = false;
    const size = DICE_SIZE;
    const halfSize = size / 2;

    physicalDice.forEach(die => {
        die.x += die.vx;
        die.y += die.vy;
        die.vx *= 0.94; // Natural velocity decay friction
        die.vy *= 0.94;
        die.rot = (die.rot || 0) + (die.rotV || 0);
        die.rotV = (die.rotV || 0) * 0.94;
        die.rot *= 0.94; // Tumble settles back to level

        // Shuffle temporary face numbers while velocity vectors are active
        // (unless this die is locked to a provably-fair VRF result)
        if (Math.abs(die.vx) > 0.15 || Math.abs(die.vy) > 0.15) {
            if (die.finalValue == null) die.value = Math.floor(Math.random() * 6) + 1;
            piecesStillMoving = true;
        } else if (die.finalValue != null) {
            // Velocity stopped -> snap to the VRF-locked face
            die.value = die.finalValue;
        }

        // Boundary Collisions: Bounce off 600x600 canvas parameters like a
        // real die hitting the wooden rim — reverse with ~20% energy loss so
        // it visibly rebounds instead of just stopping.
        let bounced = false;
        if (die.x < 0 || die.x > 600 - size) { die.vx = -die.vx * 0.8; die.x = Math.max(0, Math.min(die.x, 600 - size)); bounced = true; }
        if (die.y < 0 || die.y > 600 - size) { die.vy = -die.vy * 0.8; die.y = Math.max(0, Math.min(die.y, 600 - size)); bounced = true; }
        if (bounced && (Math.abs(die.vx) > 1.5 || Math.abs(die.vy) > 1.5)) playDiceTick();
    });

    // Dice-vs-dice collision: the two dice bounce apart instead of overlapping.
    if (physicalDice.length === 2) {
        const a = physicalDice[0];
        const b = physicalDice[1];
        const dx = (b.x + halfSize) - (a.x + halfSize);
        const dy = (b.y + halfSize) - (a.y + halfSize);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = 2 * halfSize;
        if (dist < minDist && dist > 0.001) {
            const nx = dx / dist;
            const ny = dy / dist;
            const overlap = (minDist - dist) / 2;
            a.x -= nx * overlap; a.y -= ny * overlap;
            b.x += nx * overlap; b.y += ny * overlap;

            // Equal-mass elastic exchange along the collision normal.
            const relV = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
            if (relV < 0) {
                const impulse = -relV * 0.92; // restitution
                a.vx += impulse * nx; a.vy += impulse * ny;
                b.vx -= impulse * nx; b.vy -= impulse * ny;
                // Re-clamp after the push-apart so dice stay on the board.
                a.x = Math.max(halfSize, Math.min(a.x, 600 - size));
                a.y = Math.max(halfSize, Math.min(a.y, 600 - size));
                b.x = Math.max(halfSize, Math.min(b.x, 600 - size));
                b.y = Math.max(halfSize, Math.min(b.y, 600 - size));
                playDiceTick();
            }
        }
    }

    if (piecesStillMoving) {
        physicsAnimationLoop = requestAnimationFrame(runDicePhysicsCalculations);
    } else {
        // Velocity stopped -> lock stable final calculation parameters
        finalizeDiceScores();
    }
}

// ============================== 3D dice rendering ==============================

function renderPhysicalDiceCubes() {
    if (!displayDiceOnBoard || physicalDice.length !== 2) return;

    physicalDice.forEach(die => {
        const size = DICE_SIZE;
        const x = die.x;
        const y = die.y;
        const cx = x + size / 2;
        const cy = y + size / 2;
        const r = Math.max(4, size * 0.12);
        const value = die.value;
        const rot = die.rot || 0;

        // How fast the die is currently spinning. While it tumbles, the cube
        // shows DEEPER side faces (it looks like it is flipping end over end);
        // when it settles the extrusion relaxes to a fixed 3D depth.
        const spin = Math.min(1, Math.abs(die.rotV || 0) / 10);
        const ext = size * (0.13 + 0.10 * spin);

        ctx.save();

        // Contact shadow on the board, drawn OUTSIDE the tumble rotation so it
        // stays planted under the die (sells the height of the cube).
        const shadowW = size * 0.44 * (1 - spin * 0.22);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(cx + 5, cy + size * 0.44, shadowW, size * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();

        // Small tumble rotation while in motion (settles back to level).
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.translate(-cx, -cy);

        // ---- Right face (side in shadow) ----
        // Both side faces share one depth vector d = (+ext, -ext), so the cube
        // is a proper axonometric projection receding toward the upper-right.
        const rightGrad = ctx.createLinearGradient(cx, cy, cx + ext, cy);
        rightGrad.addColorStop(0, '#cfd4da');
        rightGrad.addColorStop(1, '#9aa1ab');
        ctx.fillStyle = rightGrad;
        ctx.strokeStyle = 'rgba(15,15,19,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + size / 2, cy - size / 2);
        ctx.lineTo(cx + size / 2, cy + size / 2);
        ctx.lineTo(cx + size / 2 + ext, cy + size / 2 - ext);
        ctx.lineTo(cx + size / 2 + ext, cy - size / 2 - ext);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // ---- Top face (lit from above) ----
        const topGrad = ctx.createLinearGradient(cx, cy - size / 2 - ext, cx, cy - size / 2);
        topGrad.addColorStop(0, '#ffffff');
        topGrad.addColorStop(1, '#e9ebee');
        ctx.fillStyle = topGrad;
        ctx.strokeStyle = 'rgba(15,15,19,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - size / 2, cy - size / 2);
        ctx.lineTo(cx + size / 2, cy - size / 2);
        ctx.lineTo(cx + size / 2 + ext, cy - size / 2 - ext);
        ctx.lineTo(cx - size / 2 + ext, cy - size / 2 - ext);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Glossy streak along the top face (fake a specular reflection on the
        // polished cube).
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cx - size / 2 + 3, cy - size / 2 - 1.5);
        ctx.lineTo(cx + size / 2 + ext - 3, cy - size / 2 - ext + 1.5);
        ctx.stroke();

        // ---- Front face (the rolled value) ----
        const bodyGrad = ctx.createLinearGradient(x, y, x, y + size);
        bodyGrad.addColorStop(0, '#ffffff');
        bodyGrad.addColorStop(0.72, '#f3f4f6');
        bodyGrad.addColorStop(1, '#d9dce1');

        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + size, y, x + size, y + size, r);
        ctx.arcTo(x + size, y + size, x, y + size, r);
        ctx.arcTo(x, y + size, x, y, r);
        ctx.arcTo(x, y, x + size, y, r);
        ctx.closePath();

        ctx.fillStyle = bodyGrad;
        ctx.fill();
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Bevel: bright inner highlight along the top edge, dark shade along
        // the bottom — sells the "carved block" depth on any screen.
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + r, y + 1.5);
        ctx.arcTo(x + size, y + 1.5, x + size, y + size, r);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath();
        ctx.moveTo(x + r, y + size - 1.5);
        ctx.arcTo(x + size - 1.5, y + size - 1.5, x, y + size - 1.5, r);
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
        pipMap.forEach(([fx, fy]) => {
            const px = x + size * fx;
            const py = y + size * fy;

            // Tiny shadow offset so the pip reads as drilled into the die.
            ctx.fillStyle = 'rgba(0,0,0,0.22)';
            ctx.beginPath();
            ctx.arc(px + 1.2, py + 1.4, pipRadius, 0, Math.PI * 2);
            ctx.fill();

            // Radial-gradient pip body for a slightly rounded, inked look.
            const pipGrad = ctx.createRadialGradient(px - pipRadius * 0.3, py - pipRadius * 0.3, pipRadius * 0.15, px, py, pipRadius);
            pipGrad.addColorStop(0, '#3a3a3a');
            pipGrad.addColorStop(1, '#0f0f13');
            ctx.fillStyle = pipGrad;
            ctx.beginPath();
            ctx.arc(px, py, pipRadius, 0, Math.PI * 2);
            ctx.fill();
        });

        ctx.restore();
    });
}
