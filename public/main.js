// Local variables tracking current tab states
let selectedLevel = 1;
let selectedStatus = 'current';

// Mock list of campaigns to simulate database records
const sampleCampaigns = [
    { level: 1, status: 'current', title: '🇳🇬 Ludo Training Ground', desc: 'Practice and master token pathways against local AI algorithms. Free forever.' },
    { level: 2, status: 'current', title: '🇳🇬 Active Daily Airtime Cup', desc: 'Pool active! Top 8 leaderboard winners share N1,500 direct mobile recharges.' },
    { level: 2, status: 'upcoming', title: '🇳🇬 Tomorrow Airtime Sprint', desc: 'Pool lock initializes at 08:00 WAT. Secure your eligibility balance tokens.' },
    { level: 2, status: 'past', title: '🇳🇬 Monday Airtime Opener Results', desc: 'Match completed. Top Winners: Obi_92, Segun_Fx, Crypt_King.' }
];

function drawDashboardContent() {
    const outputBox = document.getElementById('campaign-display-box');
    outputBox.innerHTML = ''; // Clear display area

    // Filter array items matching selected user tab positions
    const filteredMatches = sampleCampaigns.filter(item => item.level === selectedLevel && item.status === selectedStatus);

    if (filteredMatches.length === 0) {
        outputBox.innerHTML = `<div class="game-card"><p>No active tournament records found in this zone layout.</p></div>`;
        return;
    }

    filteredMatches.forEach(campaign => {
        const cardElement = document.createElement('div');
        cardElement.className = 'game-card';
        cardElement.innerHTML = `
            <h3>${campaign.title}</h3>
            <p>${campaign.desc}</p>
            <button class="launch-btn" onclick="goToLudoWorkspace()">Enter Game Arena</button>
        `;
        outputBox.appendChild(cardElement);
    });
}

function goToLudoWorkspace() {
    // alert("Preping Game: Launching game now.... tab okay!");
    // Redirects user directly into the isolated Ludo game folder architecture
    window.location.href = "games/ludo/index.html";
}

// Click event loops for tab controls
document.querySelectorAll('.tab-btn').forEach(button => {
    button.addEventListener('click', (event) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        event.target.classList.add('active');
        selectedLevel = parseInt(event.target.dataset.level);
        drawDashboardContent();
    });
});

document.querySelectorAll('.sub-tab-btn').forEach(button => {
    button.addEventListener('click', (event) => {
        document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
        event.target.classList.add('active');
        selectedStatus = event.target.dataset.status;
        drawDashboardContent();
    });
});

// Run display engine setup automatically on page load
drawDashboardContent();
