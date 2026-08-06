function checkCaptureMechanic(currentPiece, selectedTokenIndex, activeTokens) {
    if (currentPiece.pathIndex < 0) return;

    const upperColor = currentTurn.toUpperCase();
    const isTargetOnStartingSafeBox = Object.values(START_INDEX).includes(currentPiece.pathIndex);
    
    if (!isTargetOnStartingSafeBox) {
        turnSequence.forEach(oppColor => {
            if (oppColor !== currentTurn) {
                tokens[oppColor].forEach((oppToken, oppIdx) => {
                    if (oppToken.pathIndex === currentPiece.pathIndex && oppToken.stepsWalked < 52) {
                        
                        let hasAnotherMovableToken = activeTokens.some((t, idx) => idx !== selectedTokenIndex && isTokenMovable(currentTurn, t, idx)) || currentTurnMoves.length > 1;
                        
                        if (hasAnotherMovableToken) {
                            oppToken.pathIndex = -1;
                            oppToken.stepsWalked = 0;
                            oppToken.c = HOME_YARDS[oppColor][oppIdx].c;
                            oppToken.r = HOME_YARDS[oppColor][oppIdx].r;
                            
                            // Cultural linguistic broadcast update
                            displayEducationalLog(`${upperColor} "${"pe"}" ${oppColor.toUpperCase()}! Token returned to base yard.`);
                        }
                    }
                });
            }
        });
    }
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
