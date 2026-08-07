function checkCaptureMechanic(currentPiece, selectedTokenIndex, activeTokens) {
    // 1. Exception Check: Block captures if token is in home yard (-1) OR safe in the inner center lane (-2)
    if (currentPiece.pathIndex < 0) return;

    const upperColor = currentTurn.toUpperCase();
    
    // 2. Exception Check: Stays side-by-side with zero capture if landing on any of the 4 home-release safe boxes
    const isTargetOnStartingSafeBox = Object.values(START_INDEX).includes(currentPiece.pathIndex);
    if (isTargetOnStartingSafeBox) {
        return;
    }
    
    // 3. Scan path coordinate markers for active opponent capture evaluation
    turnSequence.forEach(oppColor => {
        // Exception Check: Only target opposing colors! Tokens belonging to the same player stack side-by-side safely
        if (oppColor !== currentTurn) {
            tokens[oppColor].forEach((oppToken, oppIdx) => {
                
                // Match tracking steps positions on common pathway layout cells
                if (oppToken.pathIndex === currentPiece.pathIndex && oppToken.stepsWalked < 52) {
                    
                    let hasAnotherMovableToken = activeTokens.some((t, idx) => idx !== selectedTokenIndex && isTokenMovable(currentTurn, t, idx)) || currentTurnMoves.length > 1;
                    
                    if (hasAnotherMovableToken) {
                        // Core "pe" logic action: kick enemy piece back to their starting yard slot coordinates
                        oppToken.pathIndex = -1;
                        oppToken.stepsWalked = 0;
                        oppToken.c = HOME_YARDS[oppColor][oppIdx].c;
                        oppToken.r = HOME_YARDS[oppColor][oppIdx].r;

                        // Localized linguistic broadcast overlay alert
                        displayEducationalLog(`${upperColor} "${"pe"}" ${oppColor.toUpperCase()}! Token returned to base yard.`);

                        // Fast-track win bonus: the capturing token that "pe" opponent also completes its circuit and exits the board.
                        if (currentPiece.stepsWalked < 57) {
                            currentPiece.stepsWalked = 57;
                            currentPiece.pathIndex = -2;
                            currentPiece.c = 7;
                            currentPiece.r = 7;
                            displayEducationalLog(`${upperColor}: Capture completed the circuit and the token exited the board.`);
                        }
                    }
                }
            });
        }
    });
}

if (typeof drawLudoLayout === 'function') {
    const originalDrawLudo = drawLudoLayout;
    window.drawLudoLayout = function() {
        originalDrawLudo();
        if (typeof renderPhysicalDiceCubes === 'function') {
            renderPhysicalDiceCubes();
        }
    };
}
