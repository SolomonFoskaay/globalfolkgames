// Clockwise 360-degree board layout cell coordinates
const COMMON_PATH = [
    {c:1, r:6}, {c:2, r:6}, {c:3, r:6}, {c:4, r:6}, {c:5, r:6}, 
    {c:6, r:5}, {c:6, r:4}, {c:6, r:3}, {c:6, r:2}, {c:6, r:1}, {c:6, r:0}, 
    {c:7, r:0}, 
    {c:8, r:0}, {c:8, r:1}, {c:8, r:2}, {c:8, r:3}, {c:8, r:4}, {c:8, r:5}, 
    {c:9, r:6}, {c:10, r:6}, {c:11, r:6}, {c:12, r:6}, {c:13, r:6}, {c:14, r:6}, 
    {c:14, r:7}, 
    {c:14, r:8}, {c:13, r:8}, {c:12, r:8}, {c:11, r:8}, {c:10, r:8}, {c:9, r:8}, 
    {c:8, r:9}, {c:8, r:10}, {c:8, r:11}, {c:8, r:12}, {c:8, r:13}, {c:8, r:14}, 
    {c:7, r:14}, 
    {c:6, r:14}, {c:6, r:13}, {c:6, r:12}, {c:6, r:11}, {c:6, r:10}, {c:6, r:9}, 
    {c:5, r:8}, {c:4, r:8}, {c:3, r:8}, {c:2, r:8}, {c:1, r:8}, {c:0, r:8}, 
    {c:0, r:7}
];

const START_INDEX = { green: 0, yellow: 13, blue: 26, red: 39 };
const MAX_COMMON_STEPS = 51;

let tokens = {
    green:  [{c:2, r:2, pathIndex: -1, stepsWalked: 0}, {c:3, r:2, pathIndex: -1, stepsWalked: 0}, {c:2, r:3, pathIndex: -1, stepsWalked: 0}, {c:3, r:3, pathIndex: -1, stepsWalked: 0}],
    yellow: [{c:11, r:2, pathIndex: -1, stepsWalked: 0}, {c:12, r:2, pathIndex: -1, stepsWalked: 0}, {c:11, r:3, pathIndex: -1, stepsWalked: 0}, {c:12, r:3, pathIndex: -1, stepsWalked: 0}],
    blue:   [{c:11, r:11, pathIndex: -1, stepsWalked: 0}, {c:12, r:11, pathIndex: -1, stepsWalked: 0}, {c:11, r:12, pathIndex: -1, stepsWalked: 0}, {c:12, r:12, pathIndex: -1, stepsWalked: 0}],
    red:    [{c:2, r:11, pathIndex: -1, stepsWalked: 0}, {c:3, r:11, pathIndex: -1, stepsWalked: 0}, {c:2, r:12, pathIndex: -1, stepsWalked: 0}, {c:3, r:12, pathIndex: -1, stepsWalked: 0}]
};

const HOME_YARDS = {
    green:  [{c:2, r:2}, {c:3, r:2}, {c:2, r:3}, {c:3, r:3}],
    yellow: [{c:11, r:2}, {c:12, r:2}, {c:11, r:3}, {c:12, r:3}],
    blue:   [{c:11, r:11}, {c:12, r:11}, {c:11, r:12}, {c:12, r:12}],
    red:    [{c:2, r:11}, {c:3, r:11}, {c:2, r:12}, {c:3, r:12}]
};

function isTokenInHomeYard(color, token) {
    return token.pathIndex === -1;
}

function isTokenMovable(color, token, index) {
    if (color !== currentTurn || !isDiceRolled || currentTurnMoves.length === 0) return false;
    const inYard = isTokenInHomeYard(color, token);
    return currentTurnMoves.some(m => inYard ? m === 6 : true);
}
