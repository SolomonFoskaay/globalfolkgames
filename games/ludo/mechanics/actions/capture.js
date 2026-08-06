function checkCaptureMechanic(currentPiece, selectedTokenIndex, activeTokens) {
    if (currentPiece.pathIndex < 0) return;

    const upperColor = currentTurn.toUpperCase();
    const isTargetOnStartingSafeBox = Object.values(START_INDEX).includes(currentPiece.pathIndex);
    
    // Starting lanes are safe from captures
    if (!isTargetOnStartingSafeBox) {
        turnSequence.forEach(oppColor => {
            if (oppColor !== currentTurn) {
                tokens[oppColor].forEach((oppToken, oppIdx) => {
                    if (oppToken.pathIndex === currentPiece.pathIndex) {
                        
                        // Check if current player has another movable piece or move values remaining
                        let hasAnotherMovableToken = activeTokens.some((t, idx) => idx !== selectedTokenIndex && isTokenMovable(currentTurn, t, idx)) || currentTurnMoves.length > 1;
                        
                        if (hasAnotherMovableToken) {
                            // Run the capture action ("pe")
                            oppToken.pathIndex = -1;
                            oppToken.stepsWalked = 0;
                            oppToken.c = HOME_YARDS[oppColor][oppIdx].c;
                            oppToken.r = HOME_YARDS[oppColor][oppIdx].r;
                            displayEducationalLog(`${upperColor}: Captured an opponent token via "${"pe"}". Sent home.`);
                        }
                    }
                });
            }
        });
    }
}

// Ensure drawLudoLayout wraps physical dice renderer safely
if (typeof drawLudoLayout === 'function') {
    const originalDrawLudo = drawLudoLayout;
    window.drawLudoLayout = function() {
        originalDrawLudo();
        if (typeof renderPhysicalDiceCubes === 'function') {
            renderPhysicalDiceCubes();
        }
    };
}
