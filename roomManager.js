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
        this.rooms[roomCode] = { id: roomCode, players: [], game: null, state: 'LOBBY' };
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
            existingPlayer.socket = socket;
            existingPlayer.connected = true;
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
            room.players = room.players.filter(p => p.id !== socket.playerId);
            delete this.playerToRoom[socket.playerId];
            socket.leave(roomCode);
            
            if (room.players.length === 0) {
                delete this.rooms[roomCode];
            } else {
                if (room.state === 'GAME') {
                    this.io.to(roomCode).emit('errorMsg', `${socket.playerName} abandoned the game.`);
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
            if (player) {
                player.connected = false;
                this.updateLobby(this.rooms[roomCode]);
                if (this.rooms[roomCode].state === 'GAME') {
                    this.sendGameState(this.rooms[roomCode]);
                }
            }
        }
    }
    
    updateLobby(room) {
        // FIXED BUG: Included 'id' so the client knows who the room creator is
        const playerList = room.players.map(p => ({ 
            id: p.id, 
            name: p.name, 
            team: p.team, 
            connected: p.connected, 
            position: p.position 
        }));
        
        this.io.to(room.id).emit('lobbyUpdate', { 
            roomCode: room.id, 
            players: playerList, 
            canStart: room.players.length === 4 
        });
    }
    
    startGame(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        
        if (!room || room.players.length !== 4) return;
        
        // Ensure only the room creator (Position 0) can start
        const player = room.players.find(p => p.id === socket.playerId);
        if (player.position !== 0) {
            return socket.emit('errorMsg', 'Only the room creator can start the game.');
        }

        room.state = 'GAME';
        room.game = new GameLogic(room.players);
        this.io.to(roomCode).emit('gameStarted');
        this.sendGameState(room);
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
                            this.io.to(roomCode).emit('gameOver', room.game.getWinner());
                        }
                    }, 3000);
                }
            }
        }
    }
    
    sendGameState(room) {
        if (!room.game) return;
        room.players.forEach(p => {
            if (p.connected) {
                p.socket.emit('gameStateUpdate', room.game.getGameStateForPlayer(p.id));
            }
        });
    }
}

module.exports = RoomManager;
    
