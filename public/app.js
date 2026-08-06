const socket = io();
let myPlayerId = sessionStorage.getItem('code10_playerId');
let myName = sessionStorage.getItem('code10_playerName') || '';
let currentRoom = null;
let gameState = null;
let selectedCardIndex = -1;

if (!myPlayerId) {
    myPlayerId = 'P_' + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('code10_playerId', myPlayerId);
}

// ---- Audio Manager using Web Audio API for synthetic SFX (no missing files issue) ----
class AudioManager {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = 1; this.sfx = 1; this.music = 0.5; this.muted = false;
        this.loadSettings();
    }
    loadSettings() {
        this.master = parseFloat(localStorage.getItem('aud_master') ?? 1);
        this.sfx = parseFloat(localStorage.getItem('aud_sfx') ?? 1);
        this.music = parseFloat(localStorage.getItem('aud_music') ?? 0.5);
        this.muted = localStorage.getItem('aud_mute') === 'true';
        document.getElementById('master-vol').value = this.master;
        document.getElementById('sfx-vol').value = this.sfx;
        document.getElementById('music-vol').value = this.music;
        document.getElementById('mute-all-toggle').checked = this.muted;
    }
    saveSettings() {
        this.master = parseFloat(document.getElementById('master-vol').value);
        this.sfx = parseFloat(document.getElementById('sfx-vol').value);
        this.music = parseFloat(document.getElementById('music-vol').value);
        this.muted = document.getElementById('mute-all-toggle').checked;
        localStorage.setItem('aud_master', this.master);
        localStorage.setItem('aud_sfx', this.sfx);
        localStorage.setItem('aud_music', this.music);
        localStorage.setItem('aud_mute', this.muted);
    }
    playTone(freq, type, duration) {
        if(this.muted || this.master === 0 || this.sfx === 0) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type; osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(this.master * this.sfx * 0.1, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + duration);
    }
    playClick() { this.playTone(600, 'sine', 0.1); }
    playCardThrow() { this.playTone(300, 'triangle', 0.15); }
    playShuffle() { 
        if(this.muted) return;
        for(let i=0; i<10; i++) setTimeout(() => this.playTone(150 + Math.random()*100, 'square', 0.05), i*40);
    }
    playDeal() { this.playTone(400, 'sine', 0.05); }
    playWinRound() { this.playTone(800, 'sine', 0.3); setTimeout(()=>this.playTone(1000, 'sine', 0.4), 150); }
    playMatchStart() { this.playTone(500, 'square', 0.5); }
}
const audio = new AudioManager();

const views = { landing: document.getElementById('landing-page'), lobby: document.getElementById('lobby-page'), game: document.getElementById('game-page') };
function showView(viewName) { Object.values(views).forEach(v => v.classList.remove('active')); views[viewName].classList.add('active'); }
function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 3000); }
function getSuitSymbol(suit) { switch(suit) { case 'spades': return '♠'; case 'hearts': return '♥'; case 'diamonds': return '♦'; case 'clubs': return '♣'; default: return ''; } }
function get10CardHTML(suit) { const isRed = suit === 'hearts' || suit === 'diamonds'; return `<div class="ten-icon ${isRed ? 'red' : ''}">10${getSuitSymbol(suit)}</div>`; }

socket.emit('joinLobby', { playerId: myPlayerId, playerName: myName });

document.getElementById('btn-play-now').addEventListener('click', () => { audio.playClick(); showView('lobby'); document.getElementById('player-name').value = myName; });
document.getElementById('btn-create-room').addEventListener('click', () => {
    audio.playClick();
    myName = document.getElementById('player-name').value.trim() || 'Player';
    sessionStorage.setItem('code10_playerName', myName); socket.playerName = myName;
    socket.emit('createRoom');
});
document.getElementById('btn-join-room').addEventListener('click', () => {
    audio.playClick();
    const code = document.getElementById('room-code-input').value.trim();
    if (code.length === 5) {
        myName = document.getElementById('player-name').value.trim() || 'Player';
        sessionStorage.setItem('code10_playerName', myName); socket.playerName = myName;
        socket.emit('joinRoom', code);
    } else showToast("Invalid room code");
});
document.getElementById('btn-leave-room').addEventListener('click', () => { audio.playClick(); socket.emit('leaveRoom'); document.getElementById('room-details').classList.add('hidden'); document.querySelector('.lobby-controls').classList.remove('hidden'); currentRoom = null; });
document.getElementById('btn-start-game').addEventListener('click', () => { audio.playClick(); socket.emit('startGame'); });

// Audio Settings UI
document.querySelectorAll('[id^=btn-audio-settings]').forEach(btn => btn.onclick = () => document.getElementById('audio-settings-modal').classList.remove('hidden'));
document.getElementById('btn-close-audio').onclick = () => { audio.saveSettings(); document.getElementById('audio-settings-modal').classList.add('hidden'); };

socket.on('errorMsg', (msg) => showToast(msg));
socket.on('lobbyUpdate', (data) => {
    currentRoom = data.roomCode; document.getElementById('display-room-code').textContent = data.roomCode;
    document.getElementById('player-count').textContent = `${data.players.length}/4`;
    
    let isRoomCreator = data.players.find(p => p.id === myPlayerId && p.position === 0);
    const list = document.getElementById('player-list'); list.innerHTML = '';
    
    data.players.forEach(p => {
        let controls = '';
        if (isRoomCreator && p.id !== myPlayerId) {
            const opposite = p.team === 'Team 1' ? 'Team 2' : 'Team 1';
            controls = `<div class="host-controls"><button onclick="socket.emit('assignTeam', {targetPlayerId: '${p.id}', newTeam: '${opposite}'})">Move to ${opposite}</button></div>`;
        }
        const tName = data.teamNames[p.team] || p.team;
        list.innerHTML += `<li><div>${p.position === 0 ? '👑 ' : ''}${p.name} <span class="team-badge">${tName}</span> <span style="color:${p.connected ? '#4ade80' : '#ef4444'}">●</span></div>${controls}</li>`;
    });

    if(isRoomCreator) {
        document.getElementById('team-names-config').classList.remove('hidden');
        document.getElementById('input-t1-name').value = data.teamNames['Team 1'];
        document.getElementById('input-t2-name').value = data.teamNames['Team 2'];
        document.getElementById('input-t1-name').onchange = (e) => socket.emit('updateTeamNames', {t1Name: e.target.value, t2Name: null});
        document.getElementById('input-t2-name').onchange = (e) => socket.emit('updateTeamNames', {t1Name: null, t2Name: e.target.value});
        if(data.canStart) document.getElementById('btn-start-game').classList.remove('hidden');
        else document.getElementById('btn-start-game').classList.add('hidden');
    } else {
        document.getElementById('team-names-config').classList.add('hidden');
        document.getElementById('btn-start-game').classList.add('hidden');
    }
    document.querySelector('.lobby-controls').classList.add('hidden');
    document.getElementById('room-details').classList.remove('hidden');
});

socket.on('gameStarted', () => { audio.playShuffle(); showView('game'); document.getElementById('game-room-code').textContent = currentRoom; });
socket.on('cardThrownSound', () => audio.playCardThrow());

socket.on('gameStateUpdate', (state) => {
    gameState = state;
    const me = gameState.players.find(p => p.id === myPlayerId);
    if (me && !me.isTurn) selectedCardIndex = -1;
    document.getElementById('play-area').className = 'play-area'; 
    document.getElementById('trick-winner-overlay').classList.add('hidden');
    renderGame();
});

function getRelativePosition(myPos, targetPos) {
    const diff = (targetPos - myPos + 4) % 4;
    if (diff === 0) return 'bottom'; if (diff === 1) return 'left'; if (diff === 2) return 'top'; return 'right';
}

function createCardHTML(card, index, isMine = false, hide = false) {
    if (hide) { return `<div class="playing-card card-back"></div>`; }
    const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
    const symbol = getSuitSymbol(card.suit);
    const sel = (isMine && selectedCardIndex === index) ? 'selected' : '';
    const click = isMine ? `onclick="selectOrPlayCard(${index})"` : '';
    return `<div class="playing-card ${isRed ? 'red-suit' : ''} ${sel}" ${click}><div class="card-top">${card.rank}${symbol}</div><div class="card-center">${symbol}</div><div class="card-bottom">${card.rank}${symbol}</div></div>`;
}

function renderGame() {
    if (!gameState) return;
    const me = gameState.players.find(p => p.id === myPlayerId);
    if (!me) return;

    document.getElementById('round-display').textContent = gameState.roundNumber;
    
    // Team names & scores
    document.getElementById('t1-title').textContent = gameState.teamNames['Team 1'];
    document.getElementById('t2-title').textContent = gameState.teamNames['Team 2'];
    ['Team 1', 'Team 2'].forEach((t, i) => {
        const id = i+1; const data = gameState.scores[t];
        document.getElementById(`t${id}-rounds`).textContent = data.roundsWon;
        document.getElementById(`t${id}-tens-count`).textContent = data.capturedTenCards.length;
        document.getElementById(`t${id}-tens-list`).innerHTML = data.capturedTenCards.map(s => get10CardHTML(s)).join('');
    });

    const pcEl = document.getElementById('game-power-colour');
    if (gameState.powerSuit) {
        const isRed = ['hearts','diamonds'].includes(gameState.powerSuit);
        pcEl.innerHTML = `<span class="${isRed ? 'red' : ''}">${gameState.powerSuit.toUpperCase()} ${getSuitSymbol(gameState.powerSuit)}</span>`;
    } else pcEl.textContent = 'Waiting...';

    ['my-hand', 'hand-partner', 'hand-left', 'hand-right', 'play-area'].forEach(id => document.getElementById(id).innerHTML = '');

    // Rule 1: Initial 5 cards visibility
    const hideRest = (gameState.gameState === 'WAITING_FOR_POWER_COLOUR' && me.position === gameState.pcChooserPosition);
    let flipClassTrigger = '';

    gameState.players.forEach(p => {
        const relPos = getRelativePosition(me.position, p.position);
        let spotId, handId;
        switch(relPos) { case 'bottom': spotId = 'my-label'; handId = 'my-hand'; break; case 'top': spotId = 'spot-partner'; handId = 'hand-partner'; break; case 'left': spotId = 'spot-left'; handId = 'hand-left'; break; case 'right': spotId = 'spot-right'; handId = 'hand-right'; break; }
        
        const label = document.querySelector(`#${spotId}`);
        label.innerHTML = `<div class="p-name">${p.position === 0 ? '👑 ' : ''}${p.name} ${!p.connected ? '[Offline]' : ''}</div><div class="p-team">${gameState.teamNames[p.team]}</div>`;
        if (p.isTurn) label.classList.add('active-turn'); else label.classList.remove('active-turn');

        const handContainer = document.getElementById(handId);
        if (relPos === 'bottom') {
            gameState.myHand.forEach((card, index) => {
                const hidden = (hideRest && index >= 5);
                const html = createCardHTML(card, index, true, hidden);
                handContainer.insertAdjacentHTML('beforeend', html);
            });
        } else {
            for (let i = 0; i < p.cardCount; i++) handContainer.insertAdjacentHTML('beforeend', `<div class="playing-card card-back"></div>`);
        }
    });

    gameState.currentTrick.forEach(tc => {
        const p = gameState.players.find(p => p.id === tc.playerId);
        const relPos = getRelativePosition(me.position, p.position);
        document.getElementById('play-area').insertAdjacentHTML('beforeend', `<div class="played-card played-${relPos}" data-owner-pos="${p.position}">${createCardHTML(tc.card, -1, false, false)}</div>`);
    });

    const playBtn = document.getElementById('btn-play-selected');
    if (selectedCardIndex !== -1 && me.isTurn && gameState.gameState === 'PLAYING') playBtn.classList.remove('hidden');
    else playBtn.classList.add('hidden');

    const modal = document.getElementById('power-colour-modal');
    if (gameState.gameState === 'WAITING_FOR_POWER_COLOUR' && me.position === gameState.pcChooserPosition && !gameState.powerSuit) modal.classList.remove('hidden');
    else modal.classList.add('hidden');

    const delegateModal = document.getElementById('delegate-pc-modal');
    if (gameState.gameState === 'WAITING_FOR_PC_DELEGATE' && me.team === gameState.choosingTeam) {
        delegateModal.classList.remove('hidden');
        const container = document.getElementById('delegate-btn-container');
        container.innerHTML = '';
        gameState.players.filter(p => p.team === me.team).forEach(p => {
            container.innerHTML += `<button class="primary-btn" onclick="socket.emit('delegatePC', '${p.id}')">${p.id === me.id ? 'I will choose' : p.name + ' will choose'}</button>`;
        });
    } else {
        delegateModal.classList.add('hidden');
    }
}

document.querySelectorAll('.suit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        audio.playClick();
        socket.emit('selectPowerColour', e.target.getAttribute('data-suit'));
        document.getElementById('power-colour-modal').classList.add('hidden');
    });
});

socket.on('startMatchAnimation', () => {
    audio.playMatchStart();
    const myHand = document.getElementById('my-hand').children;
    for(let i=5; i<myHand.length; i++) {
        myHand[i].classList.remove('card-back');
        myHand[i].classList.add('flip-reveal');
    }
    const overlay = document.getElementById('match-start-overlay');
    const txt = document.getElementById('countdown-text');
    overlay.classList.remove('hidden');
    let count = 3; txt.textContent = count;
    const intv = setInterval(() => {
        count--;
        if(count > 0) txt.textContent = count;
        else if (count === 0) txt.textContent = 'START!';
        else { clearInterval(intv); overlay.classList.add('hidden'); }
    }, 1000);
});

function selectOrPlayCard(index) {
    const me = gameState.players.find(p => p.id === myPlayerId);
    if (!gameState || !me.isTurn || gameState.gameState !== 'PLAYING') return;
    audio.playClick();
    if (selectedCardIndex === index) executePlayCard();
    else { selectedCardIndex = index; renderGame(); }
}
document.getElementById('btn-play-selected').addEventListener('click', executePlayCard);
function executePlayCard() { if (selectedCardIndex !== -1) { socket.emit('playCard', selectedCardIndex); selectedCardIndex = -1; document.getElementById('btn-play-selected').classList.add('hidden'); } }

socket.on('trickEndAnimation', (trickResult) => {
    audio.playWinRound();
    document.querySelectorAll('.played-card').forEach(card => {
        if (parseInt(card.getAttribute('data-owner-pos')) === trickResult.winningPosition) card.classList.add('highlight-winner');
    });
    const overlay = document.getElementById('trick-winner-overlay');
    overlay.textContent = `${trickResult.winnerName.toUpperCase()} WINS`;
    overlay.classList.remove('hidden');
    const me = gameState.players.find(p => p.id === myPlayerId);
    setTimeout(() => document.getElementById('play-area').classList.add(`sweep-${getRelativePosition(me.position, trickResult.winningPosition)}`), 1000);
});

socket.on('gameOver', (resultHTML) => {
    document.getElementById('winner-text').innerHTML = resultHTML;
    document.getElementById('game-over-modal').classList.remove('hidden');
    
    // Only show rematch to host
    const me = gameState.players.find(p => p.id === myPlayerId);
    if (me && me.position === 0) document.getElementById('btn-rematch').classList.remove('hidden');
    else document.getElementById('btn-rematch').classList.add('hidden');
});

document.getElementById('btn-rematch').addEventListener('click', () => { audio.playClick(); document.getElementById('game-over-modal').classList.add('hidden'); socket.emit('rematch'); });
document.getElementById('btn-return-lobby').addEventListener('click', () => { audio.playClick(); document.getElementById('game-over-modal').classList.add('hidden'); showView('lobby'); socket.emit('leaveRoom'); });
document.getElementById('btn-leave-game').addEventListener('click', () => { audio.playClick(); socket.emit('leaveRoom'); showView('lobby'); });

const rModal = document.getElementById('rules-modal');
document.getElementById('btn-rules-lobby').onclick = () => rModal.classList.remove('hidden');
document.getElementById('btn-rules-game').onclick = () => rModal.classList.remove('hidden');
document.getElementById('btn-close-rules').onclick = () => rModal.classList.add('hidden');
