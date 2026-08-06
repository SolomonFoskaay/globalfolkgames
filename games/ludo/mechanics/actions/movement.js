function handleCanvasClick(event) {
    if (!isDiceRolled || currentTurnMoves.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const clickedCol = Math.floor(mouseX / CELL_SIZE);
    const clickedRow = Math.floor(mouseY / CELL_SIZE);

    let activeTokens = tokens[currentTurn];
    
    let selectedTokenIndex = activeTokens.findIndex((token, idx) => {
        if (token.stepsWalked >= 57) return false; 
        return token.c === clickedCol && token.r === clickedRow && isTokenMovable(currentTurn, token, idx);
    });

    if (selectedTokenIndex !== -1) {
        const upperColor = currentTurn.toUpperCase();
        let currentPiece = activeTokens[selectedTokenIndex];
        let isInsideYard = isTokenInHomeYard(currentTurn, currentPiece);
        let appliedMoveValue = isInsideYard ? 6 : (currentTurnMoves.includes(6) ? 6 : currentTurnMoves[0]);

        if (isInsideYard) {
            currentPiece.pathIndex = START_INDEX[currentTurn];
            currentPiece.stepsWalked = 0;
            currentPiece.c = COMMON_PATH[currentPiece.pathIndex].c;
            currentPiece.r = COMMON_PATH[currentPiece.pathIndex].r;
            displayEducationalLog(`${upperColor}: Released token out onto safe tracking tile.`);
        } else {
            if (currentPiece.stepsWalked + appliedMoveValue > 57) {
                displayEducationalLog(`${upperColor}: Dice value overflows home center requirements.`);
                return; 
            }

            currentPiece.stepsWalked += appliedMoveValue;
            
            if (currentPiece.stepsWalked >= 52) {
                currentPiece.pathIndex = -2; 
                let laneOffset = currentPiece.stepsWalked - 51;

                if (currentTurn === 'green') { currentPiece.c = laneOffset; currentPiece.r = 7; }
                if (currentTurn === 'yellow') { currentPiece.c = 7; currentPiece.r = laneOffset; }
                if (currentTurn === 'blue') { currentPiece.c = 14 - laneOffset; currentPiece.r = 7; }
                if (currentTurn === 'red') { currentPiece.c = 7; currentPiece.r = 14 - laneOffset; }

                if (currentPiece.stepsWalked === 57) {
                    displayEducationalLog(`${upperColor}: Token reached absolute home center goal!`);
                } else {
                    displayEducationalLog(`${upperColor}: Token advanced inside safe home lane.`);
                }
            } else {
                currentPiece.pathIndex = (currentPiece.pathIndex + appliedMoveValue) % 52;
                currentPiece.c = COMMON_PATH[currentPiece.pathIndex].c;
                currentPiece.r = COMMON_PATH[currentPiece.pathIndex].r;
                displayEducationalLog(`${upperColor}: Token advanced clockwise along track.`);
            }
        }

        checkCaptureMechanic(currentPiece, selectedTokenIndex, activeTokens);

        let spentIndex = currentTurnMoves.indexOf(appliedMoveValue);
        if (spentIndex !== -1) currentTurnMoves.splice(spentIndex, 1);

        drawLudoLayout();

        if (currentTurnMoves.length > 0) {
            displayEducationalLog(`${upperColor}: One move remaining. Select another blinking token.`);
            let hasValidRemainingMove = activeTokens.some((t, idx) => isTokenMovable(currentTurn, t, idx));
            if (!hasValidRemainingMove) {
                displayEducationalLog(`${upperColor}: No valid options left for remaining values. Passing turn.`);
                setTimeout(passTurnSequence, 1200);
            }
            return;
        }

        if (consecutiveDoubleSixes > 0 && consecutiveDoubleSixes < 3) {
            displayEducationalLog(`${upperColor}: "Shoki" double six bonus turn! Roll again.`);
            isDiceRolled = false; hasRolledThisTurn = false;
        } else {
            passTurnSequence();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const ludoCanvasElement = document.getElementById('ludoCanvas');
    if (ludoCanvasElement) ludoCanvasElement.addEventListener('click', handleCanvasClick);
});
