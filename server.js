const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const roomManager = new RoomManager(io);

io.on('connection', (socket) => {
    socket.on('joinLobby', (data) => {
        socket.playerId = data.playerId;
        socket.playerName = data.playerName;
        roomManager.handleReconnect(socket);
    });

    socket.on('createRoom', () => roomManager.createRoom(socket));
    socket.on('joinRoom', (roomCode) => roomManager.joinRoom(socket, roomCode.toUpperCase()));
    socket.on('leaveRoom', () => roomManager.leaveRoom(socket));
    socket.on('startGame', () => roomManager.startGame(socket));
    socket.on('selectPowerColour', (suit) => roomManager.handlePowerColourSelection(socket, suit));
    socket.on('playCard', (cardIndex) => roomManager.handlePlayCard(socket, cardIndex));
    socket.on('disconnect', () => roomManager.handleDisconnect(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
