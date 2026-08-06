class GameLogic {
    constructor(players) {
        this.players = players; 
        this.hands = {}; 
        this.turn = 0; 
        this.powerSuit = null;
        this.currentTrick = []; 
        this.leadSuit = null;
        this.roundNumber = 1;
        
        // Exact Score Tracking
        this.scores = {
            'Team 1': { roundsWon: 0, capturedTenCards: [] },
            'Team 2': { roundsWon: 0, capturedTenCards: [] }
        };
        
        this.gameState = 'WAITING_FOR_POWER_COLOUR'; 
        this.isGameOver = false;
        
        this.dealCards();
    }

    dealCards() {
        const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
        const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
        let deck = [];
        suits.forEach(suit => {
            ranks.forEach((rank, index) => {
                deck.push({ suit, rank, value: index + 2, isTen: rank === '10' });
            });
        });
        
        // Fisher-Yates shuffle
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        
        // Sort players by position to maintain order
        this.players.sort((a,b) => a.position - b.position);
        
        this.players.forEach(p => {
            this.hands[p.id] = deck.splice(0, 13);
            this.sortHand(this.hands[p.id]);
        });
        
        // Room creator (Player 1) starts first
        this.turn = 0; 
    }

    sortHand(hand) {
        const suitOrder = { hearts: 1, spades: 2, diamonds: 3, clubs: 4 };
        hand.sort((a, b) => {
            if (suitOrder[a.suit] !== suitOrder[b.suit]) return suitOrder[a.suit] - suitOrder[b.suit];
            return b.value - a.value;
        });
    }

    setPowerColour(playerId, suit) {
        if (this.gameState !== 'WAITING_FOR_POWER_COLOUR') return false;
        
        // Only Room Creator (Player 1 / Position 0) can select
        const player = this.players.find(p => p.id === playerId);
        if (!player || player.position !== 0) return false;
        
        this.powerSuit = suit;
        this.gameState = 'PLAYING';
        return true;
    }

    playCard(playerId, cardIndex) {
        if (this.gameState !== 'PLAYING') return { error: "Action not allowed at this time." };
        if (this.players[this.turn].id !== playerId) return { error: "Wait for your turn." };
        
        const hand = this.hands[playerId];
        const card = hand[cardIndex];
        if (!card) return { error: "Invalid card." };
        
        // Rule: Must follow lead suit if possible
        if (this.currentTrick.length > 0) {
            if (hand.some(c => c.suit === this.leadSuit) && card.suit !== this.leadSuit) {
                return { error: "You must follow the Lead Suit." };
            }
        } else {
            this.leadSuit = card.suit;
        }
        
        // Move card from hand to trick
        hand.splice(cardIndex, 1);
        this.currentTrick.push({ playerId, card });
        
        if (this.currentTrick.length === 4) {
            this.gameState = 'TRICK_END';
            return { trickComplete: true };
        }
        
        // Next player's turn
        this.turn = (this.turn + 1) % 4;
        return { success: true };
    }

    determineTrickWinner() {
        let winningCard = this.currentTrick[0];
        let powerColourPlayed = this.currentTrick.some(tc => tc.card.suit === this.powerSuit);
        
        this.currentTrick.forEach(tc => {
            if (powerColourPlayed) {
                if (tc.card.suit === this.powerSuit && (winningCard.card.suit !== this.powerSuit || tc.card.value > winningCard.card.value)) {
                    winningCard = tc;
                }
            } else {
                if (tc.card.suit === this.leadSuit && tc.card.value > winningCard.card.value) {
                    winningCard = tc;
                }
            }
        });

        const winnerPlayer = this.players.find(p => p.id === winningCard.playerId);
        
        return {
            winnerName: winnerPlayer.name,
            winningTeam: winnerPlayer.team,
            winningPlayerId: winnerPlayer.id,
            winningPosition: winnerPlayer.position,
            winningCardRank: winningCard.card.rank,
            winningCardSuit: winningCard.card.suit
        };
    }

    resolveTrick(trickResult) {
        // Collect 10s and update scores
        this.currentTrick.forEach(tc => { 
            if (tc.card.isTen) {
                this.scores[trickResult.winningTeam].capturedTenCards.push(tc.card.suit);
            }
        });
        
        this.scores[trickResult.winningTeam].roundsWon++;
        this.roundNumber++;
        
        // Winner starts next round
        this.turn = trickResult.winningPosition;
        this.currentTrick = [];
        this.leadSuit = null;
        
        if (this.hands[this.players[0].id].length === 0) {
            this.isGameOver = true;
            this.gameState = 'GAME_OVER';
        } else {
            this.gameState = 'PLAYING';
        }
    }

    getWinner() {
        const t1Score = this.scores['Team 1'].capturedTenCards.length;
        const t2Score = this.scores['Team 2'].capturedTenCards.length;
        
        let resultHTML = '';
        if (t1Score > t2Score) resultHTML = "TEAM 1 WINS THE GAME";
        else if (t2Score > t1Score) resultHTML = "TEAM 2 WINS THE GAME";
        else resultHTML = "THE GAME IS A DRAW";

        return `
            ${resultHTML}<br><br>
            <span style="font-size:1.5rem; color:#fff;">TEAM 1: ${t1Score} TEN CARDS</span><br>
            <span style="font-size:1.5rem; color:#fff;">TEAM 2: ${t2Score} TEN CARDS</span>
        `;
    }

    getGameStateForPlayer(playerId) {
        const clientPlayers = this.players.map(p => ({
            id: p.id, 
            name: p.name, 
            team: p.team, 
            position: p.position,
            cardCount: this.hands[p.id] ? this.hands[p.id].length : 0,
            connected: p.connected, 
            isTurn: this.players[this.turn].id === p.id
        }));
        
        return {
            myPosition: this.players.find(p => p.id === playerId).position,
            myHand: this.hands[playerId] || [],
            players: clientPlayers, 
            currentTrick: this.currentTrick,
            leadSuit: this.leadSuit, 
            scores: this.scores, 
            gameState: this.gameState,
            powerSuit: this.powerSuit,
            roundNumber: this.roundNumber
        };
    }
}
module.exports = GameLogic;
