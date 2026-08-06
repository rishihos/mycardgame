class GameLogic {
    constructor(players, teamNames, previousWinner) {
        this.players = players; 
        this.teamNames = teamNames;
        this.hands = {}; 
        this.turn = 0; 
        this.powerSuit = null;
        this.currentTrick = []; 
        this.leadSuit = null;
        this.roundNumber = 1;
        this.scores = { 'Team 1': { roundsWon: 0, capturedTenCards: [] }, 'Team 2': { roundsWon: 0, capturedTenCards: [] } };
        this.isGameOver = false;
        this.winningTeamId = null;

        // PC Selection Rules
        if (previousWinner === 'Team 1' || previousWinner === 'Team 2') {
            this.gameState = 'WAITING_FOR_PC_DELEGATE';
            this.pcChooserPosition = null;
            this.choosingTeam = previousWinner;
        } else {
            this.gameState = 'WAITING_FOR_POWER_COLOUR'; 
            this.pcChooserPosition = 0; // Default to Room Creator
            this.turn = 0;
        }

        this.dealCards();
    }

    dealCards() {
        const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
        const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
        let deck = [];
        suits.forEach(suit => {
            ranks.forEach((rank, index) => { deck.push({ suit, rank, value: index + 2, isTen: rank === '10' }); });
        });
        
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        
        this.players.sort((a,b) => a.position - b.position);
        this.players.forEach(p => {
            this.hands[p.id] = deck.splice(0, 13);
            this.sortHand(this.hands[p.id]);
        });
    }

    sortHand(hand) {
        const suitOrder = { hearts: 1, spades: 2, diamonds: 3, clubs: 4 };
        hand.sort((a, b) => {
            if (suitOrder[a.suit] !== suitOrder[b.suit]) return suitOrder[a.suit] - suitOrder[b.suit];
            return b.value - a.value;
        });
    }

    delegatePC(requesterId, delegateId) {
        if (this.gameState !== 'WAITING_FOR_PC_DELEGATE') return false;
        const requester = this.players.find(p => p.id === requesterId);
        const delegate = this.players.find(p => p.id === delegateId);
        if (!requester || requester.team !== this.choosingTeam) return false;
        if (!delegate || delegate.team !== this.choosingTeam) return false;

        this.pcChooserPosition = delegate.position;
        this.turn = delegate.position;
        this.gameState = 'WAITING_FOR_POWER_COLOUR';
        return true;
    }

    setPowerColour(playerId, suit) {
        if (this.gameState !== 'WAITING_FOR_POWER_COLOUR') return false;
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.position !== this.pcChooserPosition) return false;
        
        this.powerSuit = suit;
        this.gameState = 'STARTING_MATCH'; // Animation phase
        return true;
    }

    startPlaying() {
        if (this.gameState === 'STARTING_MATCH') {
            this.gameState = 'PLAYING';
        }
    }

    playCard(playerId, cardIndex) {
        if (this.gameState !== 'PLAYING') return { error: "Action not allowed at this time." };
        if (this.players[this.turn].id !== playerId) return { error: "Wait for your turn." };
        
        const hand = this.hands[playerId];
        const card = hand[cardIndex];
        if (!card) return { error: "Invalid card." };
        
        if (this.currentTrick.length > 0) {
            if (hand.some(c => c.suit === this.leadSuit) && card.suit !== this.leadSuit) return { error: "You must follow the Lead Suit." };
        } else this.leadSuit = card.suit;
        
        hand.splice(cardIndex, 1);
        this.currentTrick.push({ playerId, card });
        
        if (this.currentTrick.length === 4) {
            this.gameState = 'TRICK_END';
            return { trickComplete: true };
        }
        this.turn = (this.turn + 1) % 4;
        return { success: true };
    }

    determineTrickWinner() {
        let winningCard = this.currentTrick[0];
        let powerColourPlayed = this.currentTrick.some(tc => tc.card.suit === this.powerSuit);
        
        this.currentTrick.forEach(tc => {
            if (powerColourPlayed) {
                if (tc.card.suit === this.powerSuit && (winningCard.card.suit !== this.powerSuit || tc.card.value > winningCard.card.value)) winningCard = tc;
            } else {
                if (tc.card.suit === this.leadSuit && tc.card.value > winningCard.card.value) winningCard = tc;
            }
        });
        const winnerPlayer = this.players.find(p => p.id === winningCard.playerId);
        return {
            winnerName: winnerPlayer.name, winningTeam: winnerPlayer.team,
            winningPlayerId: winnerPlayer.id, winningPosition: winnerPlayer.position,
            winningCardRank: winningCard.card.rank, winningCardSuit: winningCard.card.suit
        };
    }

    resolveTrick(trickResult) {
        this.currentTrick.forEach(tc => { 
            if (tc.card.isTen) this.scores[trickResult.winningTeam].capturedTenCards.push(tc.card.suit);
        });
        this.scores[trickResult.winningTeam].roundsWon++;
        this.roundNumber++;
        this.turn = trickResult.winningPosition;
        this.currentTrick = [];
        this.leadSuit = null;
        
        if (this.hands[this.players[0].id].length === 0) {
            this.isGameOver = true;
            this.gameState = 'GAME_OVER';
            
            const t1Score = this.scores['Team 1'].capturedTenCards.length;
            const t2Score = this.scores['Team 2'].capturedTenCards.length;
            if (t1Score > t2Score) this.winningTeamId = 'Team 1';
            else if (t2Score > t1Score) this.winningTeamId = 'Team 2';
            else this.winningTeamId = 'DRAW';
        } else this.gameState = 'PLAYING';
    }

    getWinnerHTML() {
        const t1Score = this.scores['Team 1'].capturedTenCards.length;
        const t2Score = this.scores['Team 2'].capturedTenCards.length;
        
        let resultHTML = '';
        if (this.winningTeamId === 'Team 1') resultHTML = `${this.teamNames['Team 1'].toUpperCase()} WINS THE GAME`;
        else if (this.winningTeamId === 'Team 2') resultHTML = `${this.teamNames['Team 2'].toUpperCase()} WINS THE GAME`;
        else resultHTML = "THE GAME IS A DRAW";

        return `
            ${resultHTML}<br><br>
            <span style="font-size:1.5rem; color:#fff;">${this.teamNames['Team 1']}: ${t1Score} TEN CARDS</span><br>
            <span style="font-size:1.5rem; color:#fff;">${this.teamNames['Team 2']}: ${t2Score} TEN CARDS</span>
        `;
    }

    getGameStateForPlayer(playerId) {
        const clientPlayers = this.players.map(p => ({
            id: p.id, name: p.name, team: p.team, position: p.position,
            cardCount: this.hands[p.id] ? this.hands[p.id].length : 0,
            connected: p.connected, isTurn: this.players[this.turn].id === p.id
        }));
        
        return {
            myPosition: this.players.find(p => p.id === playerId).position,
            myHand: this.hands[playerId] || [],
            players: clientPlayers, currentTrick: this.currentTrick,
            leadSuit: this.leadSuit, scores: this.scores, gameState: this.gameState,
            powerSuit: this.powerSuit, roundNumber: this.roundNumber,
            teamNames: this.teamNames, pcChooserPosition: this.pcChooserPosition,
            choosingTeam: this.choosingTeam
        };
    }
}
module.exports = GameLogic;
