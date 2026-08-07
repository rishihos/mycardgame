const socket = io();

// ===== BUG FIX: multi-tab-in-one-browser identity clash =====
// localStorage is SHARED across every tab of the same browser, so opening
// 4 tabs to test locally meant all 4 "players" silently shared one
// playerId - the server kept re-pointing that single seat's socket to
// whichever tab last connected, leaving the other tabs frozen with stale
// state (looked like "invisible cards" / a phantom left-player turn).
// sessionStorage is per-tab (a normal new tab, not a duplicated one, always
// starts empty), so each tab now gets its own player identity automatically.
let myPlayerId = sessionStorage.getItem('code10_playerId');
let myName = localStorage.getItem('code10_playerName') || '';
let currentRoom = null;
let gameState = null;
let selectedCardIndex = -1;
let isRoomCreator = false;
let lastLobbyPlayers = [];
let prevPowerSuit = null;
let prevMyHandCount = 0;

if (!myPlayerId) {
    myPlayerId = 'P_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    sessionStorage.setItem('code10_playerId', myPlayerId);
}

const views = {
    landing: document.getElementById('landing-page'),
    lobby: document.getElementById('lobby-page'),
    game: document.getElementById('game-page')
};

function showView(viewName) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[viewName].classList.add('active');
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}

function getSuitSymbol(suit) {
    switch (suit) {
        case 'spades': return '♠';
        case 'hearts': return '♥';
        case 'diamonds': return '♦';
        case 'clubs': return '♣';
        default: return '';
    }
}

function get10CardHTML(suit) {
    const isRed = suit === 'hearts' || suit === 'diamonds';
    return `<div class="ten-icon ${isRed ? 'red' : ''}">10${getSuitSymbol(suit)}</div>`;
}

/* ============================= SOUND SYSTEM ============================= */
const SoundManager = (() => {
    let ctx = null;
    let enabled = localStorage.getItem('code10_soundOn') !== 'false';

    function getCtx() {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function tone(freq, duration, type = 'sine', gainStart = 0.15, delay = 0) {
        if (!enabled) return;
        try {
            const c = getCtx();
            const osc = c.createOscillator();
            const gain = c.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(gainStart, c.currentTime + delay);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + duration);
            osc.connect(gain); gain.connect(c.destination);
            osc.start(c.currentTime + delay);
            osc.stop(c.currentTime + delay + duration + 0.02);
        } catch (e) { /* ignore - audio not critical */ }
    }

    function noiseBurst(duration, gainStart = 0.12, delay = 0) {
        if (!enabled) return;
        try {
            const c = getCtx();
            const bufferSize = Math.floor(c.sampleRate * duration);
            const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
            const src = c.createBufferSource();
            src.buffer = buffer;
            const gain = c.createGain();
            gain.gain.setValueAtTime(gainStart, c.currentTime + delay);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + duration);
            src.connect(gain); gain.connect(c.destination);
            src.start(c.currentTime + delay);
        } catch (e) { /* ignore */ }
    }

    return {
        isEnabled: () => enabled,
        toggle() {
            enabled = !enabled;
            localStorage.setItem('code10_soundOn', enabled);
            if (enabled) { try { getCtx(); } catch (e) {} }
            return enabled;
        },
        shuffle() { for (let i = 0; i < 7; i++) noiseBurst(0.08, 0.07, i * 0.07); },
        deal() { for (let i = 0; i < 5; i++) noiseBurst(0.06, 0.1, i * 0.06); },
        throwCard() { noiseBurst(0.07, 0.15); tone(600, 0.05, 'triangle', 0.05, 0.02); },
        trickWin() { tone(523, 0.15, 'triangle'); tone(659, 0.15, 'triangle', 0.15, 0.12); tone(784, 0.25, 'triangle', 0.15, 0.24); },
        powerReveal() { tone(440, 0.3, 'sawtooth', 0.1); tone(880, 0.4, 'sine', 0.12, 0.1); },
        victory() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, 'triangle', 0.15, i * 0.14)); }
    };
})();

function updateSoundButtons() {
    const on = SoundManager.isEnabled();
    document.querySelectorAll('#btn-sound-toggle, #btn-sound-toggle-game').forEach(btn => {
        if (!btn) return;
        btn.classList.toggle('sound-off', !on);
        btn.textContent = btn.id === 'btn-sound-toggle' ? (on ? '🔊 Sound' : '🔇 Sound') : (on ? '🔊' : '🔇');
    });
}
document.getElementById('btn-sound-toggle')?.addEventListener('click', () => { SoundManager.toggle(); updateSoundButtons(); });
document.getElementById('btn-sound-toggle-game')?.addEventListener('click', () => { SoundManager.toggle(); updateSoundButtons(); });
updateSoundButtons();

/* ============================= CONFETTI ============================= */
function launchConfetti() {
    const layer = document.getElementById('confetti-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const colors = ['#fbbf24', '#f59e0b', '#ef4444', '#ffffff', '#22c55e'];
    for (let i = 0; i < 60; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + '%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDuration = (2 + Math.random() * 1.5) + 's';
        piece.style.animationDelay = (Math.random() * 0.5) + 's';
        layer.appendChild(piece);
    }
    setTimeout(() => { layer.innerHTML = ''; }, 4000);
}

/* ============================= LOBBY / LANDING ============================= */
socket.emit('joinLobby', { playerId: myPlayerId, playerName: myName });

document.getElementById('btn-play-now').addEventListener('click', () => {
    showView('lobby');
    document.getElementById('player-name').value = myName;
});

document.getElementById('btn-create-room').addEventListener('click', () => {
    myName = document.getElementById('player-name').value.trim() || 'Player';
    localStorage.setItem('code10_playerName', myName);
    socket.playerName = myName;
    socket.emit('createRoom');
});

document.getElementById('btn-join-room').addEventListener('click', () => {
    const code = document.getElementById('room-code-input').value.trim();
    if (code.length === 5) {
        myName = document.getElementById('player-name').value.trim() || 'Player';
        localStorage.setItem('code10_playerName', myName);
        socket.playerName = myName;
        socket.emit('joinRoom', code);
    } else showToast('Invalid room code');
});

document.getElementById('btn-leave-room').addEventListener('click', () => {
    socket.emit('leaveRoom');
    document.getElementById('room-details').classList.add('hidden');
    document.querySelector('.lobby-controls').classList.remove('hidden');
    currentRoom = null;
});

document.getElementById('btn-copy-code').addEventListener('click', () => {
    if (!currentRoom) return;
    const finish = () => showToast('Room code copied!');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(currentRoom).then(finish).catch(finish);
    } else {
        try {
            const ta = document.createElement('textarea');
            ta.value = currentRoom;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        } catch (e) { /* ignore */ }
        finish();
    }
});

document.getElementById('btn-start-game').addEventListener('click', () => socket.emit('startGame'));

socket.on('errorMsg', (msg) => showToast(msg));

// Feature: room creator can arrange seats (which also fixes teams, since
// seat 1/3 = Team 1 and seat 2/4 = Team 2, partners sit opposite).
function movePlayer(index, direction) {
    const ids = lastLobbyPlayers.map(p => p.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    socket.emit('reorderPlayers', ids);
}

socket.on('lobbyUpdate', (data) => {
    currentRoom = data.roomCode;
    lastLobbyPlayers = data.players;
    isRoomCreator = data.creatorId === myPlayerId;

    document.getElementById('display-room-code').textContent = data.roomCode;
    document.getElementById('player-count').textContent = `${data.players.length}/4`;

    const list = document.getElementById('player-list');
    list.innerHTML = '';

    data.players.forEach((p, index) => {
        const li = document.createElement('li');

        const left = document.createElement('div');
        left.className = 'player-row-left';
        left.innerHTML = `<span class="seat-badge">${index + 1}</span>
            <span>${p.id === data.creatorId ? '👑 ' : ''}${p.name}</span>
            <span class="team-tag">(${p.team})</span>
            <span style="color:${p.connected ? '#4ade80' : '#ef4444'}">●</span>`;
        li.appendChild(left);

        if (isRoomCreator && data.state === 'LOBBY' && data.players.length > 1) {
            const controls = document.createElement('div');
            controls.className = 'reorder-controls';
            const up = document.createElement('button');
            up.textContent = '↑';
            up.disabled = index === 0;
            up.onclick = () => movePlayer(index, -1);
            const down = document.createElement('button');
            down.textContent = '↓';
            down.disabled = index === data.players.length - 1;
            down.onclick = () => movePlayer(index, 1);
            controls.appendChild(up);
            controls.appendChild(down);
            li.appendChild(controls);
        }

        list.appendChild(li);
    });

    document.getElementById('creator-hint').classList.toggle('hidden', !isRoomCreator);
    document.querySelector('.lobby-controls').classList.add('hidden');
    document.getElementById('room-details').classList.remove('hidden');

    if (data.canStart && isRoomCreator) document.getElementById('btn-start-game').classList.remove('hidden');
    else document.getElementById('btn-start-game').classList.add('hidden');

    // Rematch support: if a finished game's players return to LOBBY state,
    // make sure everyone actually sees the lobby screen (not stuck on the
    // game-over modal / old game view).
    if (data.state === 'LOBBY' && views.game.classList.contains('active')) {
        document.getElementById('game-over-modal').classList.add('hidden');
        showView('lobby');
    }
});

/* ============================= GAME START ============================= */
socket.on('gameStarted', () => {
    showView('game');
    document.getElementById('game-room-code').textContent = currentRoom;
    prevPowerSuit = null;
    prevMyHandCount = 0;
    selectedCardIndex = -1;

    // Shuffle & deal animation + sound before the first state paints
    const overlay = document.getElementById('shuffle-overlay');
    overlay.classList.remove('hidden');
    SoundManager.shuffle();
    setTimeout(() => SoundManager.deal(), 500);
    setTimeout(() => overlay.classList.add('hidden'), 1100);
});

socket.on('gameStateUpdate', (state) => {
    gameState = state;

    const me = gameState.players.find(p => p.id === myPlayerId);
    if (me && !me.isTurn) selectedCardIndex = -1;

    // Clear sweep animations from table
    const playArea = document.getElementById('play-area');
    playArea.className = 'play-area';
    document.getElementById('trick-winner-overlay').classList.add('hidden');

    // Sound + animation cue: Power Colour just got revealed
    if (gameState.powerSuit && !prevPowerSuit) {
        SoundManager.powerReveal();
        const banner = document.getElementById('power-color-banner') || document.querySelector('.power-color-banner');
        if (banner) {
            banner.classList.remove('power-reveal-pop');
            void banner.offsetWidth; // restart animation
            banner.classList.add('power-reveal-pop');
        }
    }
    // Sound cue: remaining 8 cards just landed (5 -> 13)
    if (gameState.myHand.length > prevMyHandCount && prevMyHandCount > 0 && prevMyHandCount <= 5) {
        SoundManager.deal();
    }
    prevPowerSuit = gameState.powerSuit;
    prevMyHandCount = gameState.myHand.length;

    renderGame();
});

function getRelativePosition(myPos, targetPos) {
    const diff = (targetPos - myPos + 4) % 4;
    if (diff === 0) return 'bottom';
    if (diff === 1) return 'left';
    if (diff === 2) return 'top';
    if (diff === 3) return 'right';
}

function createCardHTML(card, index, isMine = false, dealDelay = 0) {
    const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
    const symbol = getSuitSymbol(card.suit);
    const div = document.createElement('div');
    div.className = `playing-card ${isRed ? 'red-suit' : ''} card-deal-in`;
    div.style.animationDelay = dealDelay + 'ms';

    if (isMine && selectedCardIndex === index) {
        div.classList.add('selected');
    }

    div.innerHTML = `<div class="card-top">${card.rank}${symbol}</div><div class="card-center">${symbol}</div><div class="card-bottom">${card.rank}${symbol}</div>`;

    if (isMine) {
        div.onclick = () => selectOrPlayCard(index);
    }
    return div;
}

function createCardBackHTML(dealDelay = 0) {
    const div = document.createElement('div');
    div.className = 'playing-card card-back card-deal-in';
    div.style.animationDelay = dealDelay + 'ms';
    return div;
}

function renderGame() {
    if (!gameState) return;
    const me = gameState.players.find(p => p.id === myPlayerId);
    if (!me) return;

    // HUD Update
    document.getElementById('round-display').textContent = gameState.roundNumber;

    // Score Boards Update
    const t1 = gameState.scores['Team 1'];
    document.getElementById('t1-rounds').textContent = t1.roundsWon;
    document.getElementById('t1-tens-count').textContent = t1.capturedTenCards.length;
    document.getElementById('t1-tens-list').innerHTML = t1.capturedTenCards.map(s => get10CardHTML(s)).join('');

    const t2 = gameState.scores['Team 2'];
    document.getElementById('t2-rounds').textContent = t2.roundsWon;
    document.getElementById('t2-tens-count').textContent = t2.capturedTenCards.length;
    document.getElementById('t2-tens-list').innerHTML = t2.capturedTenCards.map(s => get10CardHTML(s)).join('');

    // Public Power Colour Banner
    const powerColourEl = document.getElementById('game-power-colour');
    if (gameState.powerSuit) {
        const isRed = ['hearts', 'diamonds'].includes(gameState.powerSuit);
        powerColourEl.innerHTML = `<span class="${isRed ? 'red' : ''}">${gameState.powerSuit.toUpperCase()} ${getSuitSymbol(gameState.powerSuit)}</span>`;
    } else {
        const selector = gameState.players.find(p => p.id === gameState.firstSelectorId);
        powerColourEl.textContent = gameState.isSelector ? 'Hidden (choose it!)' : `Hidden (waiting on ${selector ? selector.name : '...'})`;
    }

    // Turn indicator - shows whose turn it is by NAME (feature request)
    const turnEl = document.getElementById('turn-indicator');
    const activePlayer = gameState.players.find(p => p.isTurn);
    if (activePlayer && gameState.gameState === 'PLAYING') {
        const isMe = activePlayer.id === myPlayerId;
        turnEl.textContent = isMe ? "🎯 Your Turn" : `🎯 ${activePlayer.name}'s Turn`;
        turnEl.classList.toggle('my-turn', isMe);
        turnEl.classList.remove('hidden');
    } else {
        turnEl.classList.add('hidden');
    }

    // Clear Tables
    ['my-hand', 'hand-partner', 'hand-left', 'hand-right', 'play-area'].forEach(id => document.getElementById(id).innerHTML = '');

    // Render Players
    gameState.players.forEach(p => {
        const relPos = getRelativePosition(me.position, p.position);
        let spotId, handId;
        switch (relPos) {
            case 'bottom': spotId = 'my-label'; handId = 'my-hand'; break;
            case 'top': spotId = 'spot-partner'; handId = 'hand-partner'; break;
            case 'left': spotId = 'spot-left'; handId = 'hand-left'; break;
            case 'right': spotId = 'spot-right'; handId = 'hand-right'; break;
        }

        const label = document.querySelector(`#${spotId === 'my-label' ? spotId : spotId + ' .player-label'}`);
        label.textContent = `${p.id === gameState.firstSelectorId ? '⭐ ' : ''}${p.name} (${p.team}) ${!p.connected ? '[Offline]' : ''}`;
        if (p.isTurn) label.classList.add('active-turn'); else label.classList.remove('active-turn');

        const handContainer = document.getElementById(handId);
        if (relPos === 'bottom') {
            gameState.myHand.forEach((card, index) => handContainer.appendChild(createCardHTML(card, index, true, index * 25)));
        } else {
            for (let i = 0; i < p.cardCount; i++) handContainer.appendChild(createCardBackHTML(i * 15));
        }
    });

    // Render Played Cards (now tagged with the owner's name - feature request)
    gameState.currentTrick.forEach(tc => {
        const p = gameState.players.find(p => p.id === tc.playerId);
        const relPos = getRelativePosition(me.position, p.position);
        const cardEl = createCardHTML(tc.card, -1, false);
        cardEl.classList.remove('card-deal-in');
        cardEl.classList.add('played-card');
        cardEl.classList.add(`played-${relPos}`);
        cardEl.setAttribute('data-owner-pos', p.position);

        const nameTag = document.createElement('div');
        nameTag.className = 'played-card-name';
        nameTag.textContent = p.name;
        cardEl.appendChild(nameTag);

        document.getElementById('play-area').appendChild(cardEl);
    });

    // Show "PLAY CARD" button only if a card is selected and it's my turn
    const playBtn = document.getElementById('btn-play-selected');
    if (selectedCardIndex !== -1 && me.isTurn) {
        playBtn.classList.remove('hidden');
    } else {
        playBtn.classList.add('hidden');
    }

    // Power Colour Modal Logic - shown to whoever is the designated selector
    const modal = document.getElementById('power-colour-modal');
    if (gameState.gameState === 'WAITING_FOR_POWER_COLOUR' && gameState.isSelector && !gameState.powerSuit) {
        modal.classList.remove('hidden');
    } else {
        modal.classList.add('hidden');
        if (gameState.gameState === 'WAITING_FOR_POWER_COLOUR' && !gameState.isSelector) {
            const selector = gameState.players.find(p => p.id === gameState.firstSelectorId);
            showToast(`Waiting for ${selector ? selector.name : 'the selector'} to choose the Power Colour...`);
        }
    }
}

// Send Selected Power Colour
document.querySelectorAll('.suit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        socket.emit('selectPowerColour', e.target.getAttribute('data-suit'));
        document.getElementById('power-colour-modal').classList.add('hidden');
    });
});

// Select and Play System
function selectOrPlayCard(index) {
    const me = gameState.players.find(p => p.id === myPlayerId);
    if (!gameState || !me.isTurn) return showToast('Not your turn!');

    if (selectedCardIndex === index) {
        executePlayCard();
    } else {
        selectedCardIndex = index;
        renderGame();
    }
}

document.getElementById('btn-play-selected').addEventListener('click', executePlayCard);

function executePlayCard() {
    if (selectedCardIndex !== -1) {
        SoundManager.throwCard();
        socket.emit('playCard', selectedCardIndex);
        selectedCardIndex = -1;
        document.getElementById('btn-play-selected').classList.add('hidden');
    }
}

/* ============================= TRICK / GAME END ============================= */
socket.on('trickEndAnimation', (trickResult) => {
    SoundManager.trickWin();

    const cardsOnTable = document.querySelectorAll('.played-card');
    cardsOnTable.forEach(card => {
        if (parseInt(card.getAttribute('data-owner-pos')) === trickResult.winningPosition) {
            card.classList.add('highlight-winner');
        }
    });

    const overlay = document.getElementById('trick-winner-overlay');
    overlay.textContent = `${trickResult.winnerName.toUpperCase()} WINS THE ROUND`;
    overlay.classList.remove('hidden');

    const me = gameState.players.find(p => p.id === myPlayerId);
    const relPos = getRelativePosition(me.position, trickResult.winningPosition);

    setTimeout(() => {
        const playArea = document.getElementById('play-area');
        playArea.classList.add(`sweep-${relPos}`);
    }, 1500);
});

socket.on('gameOver', (resultHTML) => {
    document.getElementById('winner-text').innerHTML = resultHTML;
    document.getElementById('game-over-modal').classList.remove('hidden');
    SoundManager.victory();
    launchConfetti();
});

// Feature: winner-team-selects-next-power-colour rematch flow.
// Stays in the SAME room (does not leave), so the same 4 players continue
// and the server automatically hands Power Colour selection to a member of
// the team that just won.
document.getElementById('btn-play-again').addEventListener('click', () => {
    document.getElementById('game-over-modal').classList.add('hidden');
    socket.emit('returnToLobby');
});

document.getElementById('btn-return-lobby').addEventListener('click', () => {
    document.getElementById('game-over-modal').classList.add('hidden');
    showView('lobby');
    socket.emit('leaveRoom');
});

document.getElementById('btn-leave-game').addEventListener('click', () => {
    socket.emit('leaveRoom');
    showView('lobby');
});

// Rules Modal Events
const rulesModal = document.getElementById('rules-modal');
document.getElementById('btn-rules-lobby').onclick = () => rulesModal.classList.remove('hidden');
document.getElementById('btn-rules-game').onclick = () => rulesModal.classList.remove('hidden');
document.getElementById('btn-close-rules').onclick = () => rulesModal.classList.add('hidden');
