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
        for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        return this.rooms[code] ? this.generateRoomCode() : code;
    }
    
    createRoom(socket) {
        const roomCode = this.generateRoomCode();
        this.rooms[roomCode] = { 
            id: roomCode, 
            creatorId: socket.playerId, // SECURES CREATOR IDENTITY
            players: [], 
            game: null, 
            state: 'LOBBY',
            teamNames: { 'Team 1': 'Team 1', 'Team 2': 'Team 2' },
            previousWinner: null
        };
        this.joinRoom(socket, roomCode);
    }
    
    joinRoom(socket, roomCode) {
        const room = this.rooms[roomCode];
        if (!room) return socket.emit('errorMsg', 'Room not found.');
        if (room.state !== 'LOBBY' && !this.isReconnecting(socket.playerId, room)) return socket.emit('errorMsg', 'Game already in progress.');
        
        const existingPlayer = room.players.find(p => p.id === socket.playerId);
        if (existingPlayer) {
            existingPlayer.socket = socket;
            existingPlayer.connected = true;
        } else {
            if (room.players.length >= 4) return socket.emit('errorMsg', 'Room is full.');
            
            const takenSeats = room.players.map(p => p.position);
            let emptySeat = 0;
            while (takenSeats.includes(emptySeat)) { emptySeat++; }
            
            const team = (emptySeat === 0 || emptySeat === 2) ? 'Team 1' : 'Team 2';
            room.players.push({ id: socket.playerId, socket: socket, name: socket.playerName || `Player ${emptySeat + 1}`, team: team, position: emptySeat, connected: true });
        }
        
        socket.join(roomCode);
        this.playerToRoom[socket.playerId] = roomCode;
        if (room.state === 'GAME') {
            socket.emit('gameStarted');
            this.sendGameState(room);
        } else this.updateLobby(room);
    }
    
    assignTeam(socket, targetPlayerId, newTeam) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (!room || room.state !== 'LOBBY') return;
        
        if (socket.playerId !== room.creatorId) return; // FIX APPLIED

        const target = room.players.find(p => p.id === targetPlayerId);
        if (!target || target.team === newTeam) return;

        const teamPlayers = room.players.filter(p => p.team === newTeam);
        if (teamPlayers.length >= 2) return socket.emit('errorMsg', `${newTeam} is full. Move someone out first.`);

        const allowedSeats = newTeam === 'Team 1' ? [0, 2] : [1, 3];
        const takenSeats = room.players.map(p => p.position);
        const newSeat = allowedSeats.find(seat => !takenSeats.includes(seat));

        target.team = newTeam;
        target.position = newSeat;
        this.updateLobby(room);
    }

    updateTeamNames(socket, t1Name, t2Name) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (!room || room.state !== 'LOBBY') return;
        if (socket.playerId !== room.creatorId) return; // FIX APPLIED
        
        if(t1Name) room.teamNames['Team 1'] = t1Name.substring(0, 15);
        if(t2Name) room.teamNames['Team 2'] = t2Name.substring(0, 15);
        this.updateLobby(room);
    }
    
    isReconnecting(playerId, room) { return room.players.some(p => p.id === playerId); }
    handleReconnect(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        if (roomCode && this.rooms[roomCode]) this.joinRoom(socket, roomCode);
    }
    leaveRoom(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        if (roomCode && this.rooms[roomCode]) {
            const room = this.rooms[roomCode];
            room.players = room.players.filter(p => p.id !== socket.playerId);
            delete this.playerToRoom[socket.playerId];
            socket.leave(roomCode);
            if (room.players.length === 0) delete this.rooms[roomCode];
            else {
                if (room.state === 'GAME') {
                    this.io.to(roomCode).emit('errorMsg', `${socket.playerName} abandoned the game.`);
                    room.state = 'LOBBY'; room.game = null;
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
                if (this.rooms[roomCode].state === 'GAME') this.sendGameState(this.rooms[roomCode]);
            }
        }
    }
    updateLobby(room) {
        const playerList = room.players.map(p => ({ id: p.id, name: p.name, team: p.team, connected: p.connected, position: p.position, isCreator: p.id === room.creatorId }));
        const t1Count = room.players.filter(p => p.team === 'Team 1').length;
        const t2Count = room.players.filter(p => p.team === 'Team 2').length;
        const canStart = room.players.length === 4 && t1Count === 2 && t2Count === 2;

        this.io.to(room.id).emit('lobbyUpdate', { roomCode: room.id, players: playerList, canStart: canStart, teamNames: room.teamNames });
    }
    startGame(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (!room || room.players.length !== 4) return;
        
        if (socket.playerId !== room.creatorId) return socket.emit('errorMsg', 'Only the room creator can start the game.');

        room.state = 'GAME';
        room.game = new GameLogic(room.players, room.teamNames, room.previousWinner, room.creatorId);
        this.io.to(roomCode).emit('gameStarted');
        this.sendGameState(room);
    }
    
    rematch(socket) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (!room || room.state !== 'GAME') return;
        if (socket.playerId !== room.creatorId) return socket.emit('errorMsg', 'Only the room creator can restart.');
        
        room.previousWinner = room.game.winningTeamId; 
        this.startGame(socket);
    }

    handleDelegatePC(socket, delegatePlayerId) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (room && room.game && room.game.delegatePC(socket.playerId, delegatePlayerId)) {
            this.sendGameState(room);
        }
    }

    handlePowerColourSelection(socket, suit) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (room && room.game && room.game.setPowerColour(socket.playerId, suit)) {
            this.sendGameState(room);
            this.io.to(roomCode).emit('startMatchAnimation');
            
            setTimeout(() => {
                room.game.startPlaying();
                this.sendGameState(room);
            }, 4000);
        } else {
            socket.emit('errorMsg', 'Invalid action.');
        }
    }
    
    handlePlayCard(socket, cardIndex) {
        const roomCode = this.playerToRoom[socket.playerId];
        const room = this.rooms[roomCode];
        if (room && room.game) {
            const result = room.game.playCard(socket.playerId, cardIndex);
            if (result.error) socket.emit('errorMsg', result.error);
            else {
                this.io.to(roomCode).emit('cardThrownSound');
                this.sendGameState(room);
                if (result.trickComplete) {
                    const trickResult = room.game.determineTrickWinner();
                    this.io.to(roomCode).emit('trickEndAnimation', trickResult);
                    setTimeout(() => {
                        room.game.resolveTrick(trickResult);
                        this.sendGameState(room);
                        if (room.game.isGameOver) {
                            room.winningTeamId = room.game.winningTeamId;
                            this.io.to(roomCode).emit('gameOver', room.game.getWinnerHTML());
                        }
                    }, 3000);
                }
            }
        }
    }
    sendGameState(room) {
        if (!room.game) return;
        room.players.forEach(p => {
            if (p.connected) p.socket.emit('gameStateUpdate', room.game.getGameStateForPlayer(p.id));
        });
    }
}
module.exports = RoomManager;
