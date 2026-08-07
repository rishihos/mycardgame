class GameLogic {
    /**
     * @param {Array} players - room.players (already has id, name, team, position)
     * @param {String} firstSelectorId - playerId who picks the Power Colour & leads trick 1.
     *   Rule: the winning team of the PREVIOUS game supplies this player on a rematch.
     *   For the very first game of a room, this is the room creator.
     */
    constructor(players, firstSelectorId) {
        this.players = players;
        this.players.sort((a, b) => a.position - b.position);

        this.hands = {};
        this.pendingCards = {}; // the 8 cards held back until Power Colour is chosen
        this.currentTrick = [];
        this.leadSuit = null;
        this.roundNumber = 1;
        this.isGameOver = false;
        this.winningTeam = null;
        this.powerSuit = null;

        this.scores = {
            'Team 1': { roundsWon: 0, capturedTenCards: [] },
            'Team 2': { roundsWon: 0, capturedTenCards: [] }
        };

        // Whoever selects the Power Colour also plays the first card.
        const selector = this.players.find(p => p.id === firstSelectorId);
        this.firstSelectorId = selector ? selector.id : this.players[0].id;
        this.turn = selector ? selector.position : 0;

        this.gameState = 'WAITING_FOR_POWER_COLOUR';
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

        // Fisher-Yates shuffle (server-authoritative, never trust the client)
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }

        // Feature: only the first 5 cards are dealt/visible up-front so the
        // Power Colour selector has to decide with partial information.
        // The remaining 8 cards per player are held server-side and only
        // dealt out once the Power Colour has been chosen.
        this.players.forEach(p => {
            this.hands[p.id] = deck.splice(0, 5);
            this.sortHand(this.hands[p.id]);
        });
        this.players.forEach(p => {
            this.pendingCards[p.id] = deck.splice(0, 8);
        });
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

        // Only the designated selector (room creator on game 1, or a member
        // of the previous winning team on a rematch) may choose.
        if (playerId !== this.firstSelectorId) return false;
        if (!['hearts', 'diamonds', 'clubs', 'spades'].includes(suit)) return false;

        this.powerSuit = suit;

        // Deal the remaining 8 cards to every player now (all 13 visible).
        this.players.forEach(p => {
            this.hands[p.id] = this.hands[p.id].concat(this.pendingCards[p.id] || []);
            this.pendingCards[p.id] = [];
            this.sortHand(this.hands[p.id]);
        });

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

        // Feature: only 4 ten-cards exist in total, so capturing 3 of them
        // is an unbeatable majority - the game ends right away.
        if (this.scores[trickResult.winningTeam].capturedTenCards.length >= 3) {
            this.isGameOver = true;
            this.winningTeam = trickResult.winningTeam;
            this.gameState = 'GAME_OVER';
            return;
        }

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

        let resultText = '';
        let winningTeam = this.winningTeam;

        if (winningTeam) {
            resultText = `${winningTeam.toUpperCase()} WINS THE GAME`;
        } else if (t1Score > t2Score) {
            resultText = "TEAM 1 WINS THE GAME";
            winningTeam = 'Team 1';
        } else if (t2Score > t1Score) {
            resultText = "TEAM 2 WINS THE GAME";
            winningTeam = 'Team 2';
        } else {
            resultText = "THE GAME IS A DRAW";
        }

        const html = `
            ${resultText}<br><br>
            <span style="font-size:1.5rem; color:#fff;">TEAM 1: ${t1Score} TEN CARDS</span><br>
            <span style="font-size:1.5rem; color:#fff;">TEAM 2: ${t2Score} TEN CARDS</span>
        `;

        return { html, winningTeam };
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
            roundNumber: this.roundNumber,
            firstSelectorId: this.firstSelectorId,
            isSelector: playerId === this.firstSelectorId
        };
    }
}
module.exports = GameLogic;
