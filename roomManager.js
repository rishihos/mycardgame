const GameLogic = require('./gameLogic');

class RoomManager {
    constructor(io) {
        this.io = io;
        this.rooms = {};
        this.playerToRoom = {};
    }

    generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 5; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return this.rooms[code] ? this.generateRoomCode() : code;
    }

    createRoom(socket) {
        const roomCode = this.generateRoomCode();
        this.rooms[roomCode] = {
            id: roomCode,
            players: [],
            game: null,
            state: 'LOBBY',
            creatorId: socket.playerId, // fixed reference to the creator, independent of seat position
            lastWinnerTeam: null
        };
        this.joinRoom(socket, roomCode);
    }

    joinRoom(socket, roomCode) {
        const room = this.rooms[roomCode];
        if (!room) return socket.emit('errorMsg', 'Room not found.');

        if (room.state !== 'LOBBY' && !this.isReconnecting(socket.playerId, room)) {
            return socket.emit('errorMsg', 'Game already in progress.');
        }

        const existingPlayer = room.players.find(p => p.id === socket.playerId);
        if (existingPlayer) {
            // BUG FIX: if this playerId already has a live, connected socket
            // elsewhere (e.g. the SAME browser opened in two tabs sharing the
            // same stored player id), silently stealing the seat caused the
            // classic "invisible cards" / "auto left player" glitch - only the
            // most-recently-opened tab kept receiving updates while the older
            // tab froze on stale data. Reject the duplicate connection instead.
            if (
                existingPlayer.connected &&
                existingPlayer.socket &&
                existingPlayer.socket.id !== socket.id &&
                existingPlayer.socket.connected
            ) {
                return socket.emit('errorMsg', 'This player is already connected in another tab/window. Close it first, or open this game in a new browser tab (not a duplicated one) to join as a different player.');
            }
            existingPlayer.socket = socket;
            existingPlayer.connected = true;
            if (socket.playerName) existingPlayer.name = socket.playerName;
        } else {
            if (room.players.length >= 4) return socket.emit('errorMsg', 'Room is full.');
            // Team 1 = Positions 0 and 2. Team 2 = Positions 1 and 3.
            const team = room.players.length % 2 === 0 ? 'Team 1' : 'Team 2';
            room.players.push({
                id: socket.playerId,
                socket: socket,
                name: socket.playerName || `Player ${room.players.length + 1}`,
                team: team,
                position: room.players.length,
                connected: true
            });
        }

        socket.join(roomCode);
        this.playerToRoom[socket.playerId] = roomCode;

        if (room.state === 'GAME') {
            socket.emit('gameStarted');
            this.sendGameState(room);
        } else {
            this.updateLobby(room);
        }
    }

    isReconnecting(playerId, room) {
        return room.players.some(p => p.id === playerId);
    }

    handleReconnect(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        if (roomCode && this.rooms[roomCode]) {
            this.joinRoom(socket, roomCode);
        }
    }

    leaveRoom(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        if (roomCode && this.rooms[roomCode]) {
            const room = this.rooms[roomCode];
            const wasCreator = room.creatorId === socket.playerId;
            room.players = room.players.filter(p => p.id !== socket.playerId);
            delete this.playerToRoom[socket.playerId];
            socket.leave(roomCode);

            if (room.players.length === 0) {
                delete this.rooms[roomCode];
            } else {
                if (wasCreator) {
                    // Hand creator duties to the next-lowest seat so the
                    // room isn't stuck without anyone able to start/arrange.
                    room.players.sort((a, b) => a.position - b.position);
                    room.creatorId = room.players[0].id;
                }
                if (room.state === 'GAME') {
                    this.io.to(roomCode).emit('errorMsg', `${socket.playerName || 'A player'} abandoned the game.`);
                    room.state = 'LOBBY';
                    room.game = null;
                }
                this.updateLobby(room);
            }
        }
    }

    handleDisconnect(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        if (roomCode && this.rooms[roomCode]) {
            const player = this.rooms[roomCode].players.find(p => p.id === socket.playerId);
            // Only mark disconnected if THIS socket is still the one on record
            // (avoids a stale/duplicate tab's disconnect wiping out a newer,
            // legitimately-connected session for the same player).
            if (player && player.socket && player.socket.id === socket.id) {
                player.connected = false;
                this.updateLobby(this.rooms[roomCode]);
                if (this.rooms[roomCode].state === 'GAME') {
                    this.sendGameState(this.rooms[roomCode]);
                }
            }
        }
    }

    updateLobby(room) {
        const playerList = room.players
            .slice()
            .sort((a, b) => a.position - b.position)
            .map(p => ({
                id: p.id,
                name: p.name,
                team: p.team,
                connected: p.connected,
                position: p.position
            }));

        this.io.to(room.id).emit('lobbyUpdate', {
            roomCode: room.id,
            players: playerList,
            canStart: room.players.length === 4,
            creatorId: room.creatorId,
            state: room.state
        });
    }

    // Feature: room creator can rearrange seats before the game starts.
    // Seat/position also determines team (0 & 2 = Team 1, 1 & 3 = Team 2),
    // so rearranging seats is how the creator decides who plays with whom.
    reorderPlayers(socket, orderedIds) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (!room) return;

        if (room.creatorId !== socket.playerId) {
            return socket.emit('errorMsg', 'Only the room creator can arrange players.');
        }
        if (room.state !== 'LOBBY') {
            return socket.emit('errorMsg', 'Cannot rearrange players after the game has started.');
        }
        if (!Array.isArray(orderedIds) || orderedIds.length !== room.players.length) {
            return socket.emit('errorMsg', 'Invalid seating arrangement.');
        }
        const currentIds = new Set(room.players.map(p => p.id));
        const newIds = new Set(orderedIds);
        if (currentIds.size !== newIds.size || ![...currentIds].every(id => newIds.has(id))) {
            return socket.emit('errorMsg', 'Invalid seating arrangement.');
        }

        orderedIds.forEach((id, index) => {
            const player = room.players.find(p => p.id === id);
            player.position = index;
            player.team = index % 2 === 0 ? 'Team 1' : 'Team 2';
        });

        this.updateLobby(room);
    }

    startGame(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];

        if (!room || room.players.length !== 4) return;

        if (room.creatorId !== socket.playerId) {
            return socket.emit('errorMsg', 'Only the room creator can start the game.');
        }

        // Feature: after a game finishes, the winning team supplies the
        // Power Colour selector (and first-trick leader) for the rematch.
        // On the very first game of a room, it's the room creator.
        let firstSelectorId = room.creatorId;
        if (room.lastWinnerTeam) {
            const teamPlayers = room.players
                .filter(p => p.team === room.lastWinnerTeam)
                .sort((a, b) => a.position - b.position);
            if (teamPlayers.length) firstSelectorId = teamPlayers[0].id;
        }

        room.state = 'GAME';
        room.game = new GameLogic(room.players, firstSelectorId);
        this.io.to(roomCode).emit('gameStarted');
        this.sendGameState(room);
    }

    // Lets everyone return to the lobby after a game ends WITHOUT leaving the
    // room, so the same 4 players can immediately play again (rematch).
    returnToLobby(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (!room) return;
        room.state = 'LOBBY';
        room.game = null;
        this.updateLobby(room);
    }

    handlePowerColourSelection(socket, suit) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];

        if (room && room.game && room.game.setPowerColour(socket.playerId, suit)) {
            this.sendGameState(room);
        } else {
            socket.emit('errorMsg', 'Invalid action.');
        }
    }

    handlePlayCard(socket, cardIndex) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];

        if (room && room.game) {
            const result = room.game.playCard(socket.playerId, cardIndex);

            if (result.error) {
                socket.emit('errorMsg', result.error);
            } else {
                // Send state so players see the played card on the table
                this.sendGameState(room);

                if (result.trickComplete) {
                    const trickResult = room.game.determineTrickWinner();

                    // Trigger the UI animation for trick winner
                    this.io.to(roomCode).emit('trickEndAnimation', trickResult);

                    // Wait for 3 seconds before clearing the table and updating scores
                    setTimeout(() => {
                        room.game.resolveTrick(trickResult);
                        this.sendGameState(room);
                        if (room.game.isGameOver) {
                            const winnerInfo = room.game.getWinner();
                            room.lastWinnerTeam = winnerInfo.winningTeam;
                            this.io.to(roomCode).emit('gameOver', winnerInfo.html);
                        }
                    }, 3000);
                }
            }
        }
    }

    sendGameState(room) {
        if (!room.game) return;
        room.players.forEach(p => {
            if (p.connected && p.socket) {
                p.socket.emit('gameStateUpdate', room.game.getGameStateForPlayer(p.id));
            }
        });
    }
}

module.exports = RoomManager;
