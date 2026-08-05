/**
 * ================================================================
 * SERVEUR MORPION MULTIJOUEUR - NODE.JS + SOCKET.IO
 * ================================================================
 * 
 * Ce serveur gère :
 * - Les connexions des joueurs
 * - La création et la gestion des parties
 * - Les mouvements et la logique du jeu
 * - Les salles (rooms) pour chaque partie
 * - Le nettoyage des parties inactives
 * ================================================================
 */

// ----------------------------------------------------------------
// 1. IMPORTS ET CONFIGURATION
// ----------------------------------------------------------------

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // En production, limitez aux domaines autorisés
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,  // 60 secondes sans réponse = déconnecté
    pingInterval: 25000  // Ping toutes les 25 secondes
});

// Servir les fichiers statiques (notre index.html)
app.use(express.static('public'));

// ----------------------------------------------------------------
// 2. ÉTAT GLOBAL DU SERVEUR
// ----------------------------------------------------------------

// Toutes les parties actives
const games = {};

// Structure d'une partie :
// {
//   'players': { 'X': socketId, 'O': socketId },
//   'playersNames': { 'X': 'nom1', 'O': 'nom2' },
//   'board': [0,0,0,0,0,0,0,0,0],
//   'turn': 'X',
//   'winner': null,
//   'createdAt': timestamp,
//   'lastMove': timestamp
// }

// ----------------------------------------------------------------
// 3. FONCTIONS UTILITAIRES
// ----------------------------------------------------------------

/**
 * Vérifie s'il y a un gagnant ou un match nul.
 */
function checkWinner(board) {
    const wins = [
        [0,1,2], [3,4,5], [6,7,8],
        [0,3,6], [1,4,7], [2,5,8],
        [0,4,8], [2,4,6]
    ];
    
    for (const combo of wins) {
        const [a, b, c] = combo;
        if (board[a] !== 0 && board[a] === board[b] && board[b] === board[c]) {
            return board[a] === 1 ? 'X' : 'O';
        }
    }
    
    if (board.every(cell => cell !== 0)) {
        return 'draw';
    }
    
    return null;
}

/**
 * Génère un ID de salle unique.
 */
function generateRoomId() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
}

/**
 * Nettoie les parties inactives (pas de mouvement depuis 10 minutes).
 */
function cleanInactiveGames() {
    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    
    for (const [roomId, game] of Object.entries(games)) {
        if (now - game.lastMove > timeout) {
            // Informer les joueurs
            for (const [symbol, socketId] of Object.entries(game.players)) {
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.emit('game_expired', { room: roomId });
                }
            }
            // Supprimer la partie
            delete games[roomId];
            console.log(`🗑️ Partie ${roomId} supprimée (inactive)`);
        }
    }
}

// Nettoyer toutes les 5 minutes
setInterval(cleanInactiveGames, 5 * 60 * 1000);

// ----------------------------------------------------------------
// 4. LOGIQUE DES ÉVÉNEMENTS SOCKET.IO
// ----------------------------------------------------------------

io.on('connection', (socket) => {
    console.log(`🔌 Client connecté : ${socket.id}`);

    // Envoyer un message de bienvenue
    socket.emit('connected', {
        sid: socket.id,
        message: 'Connecté au serveur !'
    });

    // ------------------------------------------------------------
    // ÉVÉNEMENT : Rejoindre ou créer une partie
    // ------------------------------------------------------------
    socket.on('join_game', (data) => {
        const roomId = data.room || null;
        const playerName = data.player_name || 'Joueur';
        let game = null;
        let isNewGame = false;

        // Si un roomId est fourni, essayer de rejoindre cette salle
        if (roomId && games[roomId]) {
            game = games[roomId];
            
            // Vérifier si la partie est pleine
            if (Object.keys(game.players).length >= 2) {
                socket.emit('join_error', { message: 'Cette partie est déjà pleine !' });
                return;
            }
            
            // Vérifier si le joueur est déjà dans la partie
            if (Object.values(game.players).includes(socket.id)) {
                socket.emit('join_error', { message: 'Vous êtes déjà dans cette partie !' });
                return;
            }
        } else {
            // Créer une nouvelle partie
            const newRoomId = generateRoomId();
            game = {
                players: {},
                playersNames: {},
                board: [0, 0, 0, 0, 0, 0, 0, 0, 0],
                turn: 'X',
                winner: null,
                createdAt: Date.now(),
                lastMove: Date.now()
            };
            games[newRoomId] = game;
            isNewGame = true;
            
            // Répondre avec le nouveau roomId
            socket.emit('room_created', {
                room: newRoomId,
                url: `${getBaseUrl(socket)}?room=${newRoomId}`
            });
            
            console.log(`🎮 Nouvelle partie créée : ${newRoomId} par ${socket.id}`);
        }

        // Déterminer le symbole du joueur
        const symbol = Object.keys(game.players).length === 0 ? 'X' : 'O';
        
        // Ajouter le joueur à la partie
        game.players[symbol] = socket.id;
        game.playersNames[symbol] = playerName;
        game.lastMove = Date.now();

        // Rejoindre la room Socket.IO
        socket.join(roomId || Object.keys(games).find(key => games[key] === game));

        // Envoyer le start au joueur
        const isWaiting = Object.keys(game.players).length < 2;
        socket.emit('game_start', {
            room: Object.keys(games).find(key => games[key] === game),
            board: game.board,
            turn: game.turn,
            symbol: symbol,
            waiting: isWaiting,
            player_name: playerName,
            player_count: Object.keys(game.players).length
        });

        // Si la partie est complète, informer les deux joueurs
        if (!isWaiting) {
            // Informer l'autre joueur que l'adversaire a rejoint
            const otherSymbol = symbol === 'X' ? 'O' : 'X';
            const otherSocketId = game.players[otherSymbol];
            const otherSocket = io.sockets.sockets.get(otherSocketId);
            
            if (otherSocket) {
                otherSocket.emit('opponent_joined', {
                    player_name: playerName,
                    room: Object.keys(games).find(key => games[key] === game)
                });
                
                // Envoyer l'état complet aux deux joueurs
                const state = {
                    board: game.board,
                    turn: game.turn,
                    winner: game.winner
                };
                
                io.to(Object.keys(games).find(key => games[key] === game)).emit('game_state', state);
            }
            
            // Envoyer le nombre de joueurs
            io.to(Object.keys(games).find(key => games[key] === game)).emit('player_count', {
                count: 2
            });
        }

        console.log(`✅ Joueur ${socket.id} (${playerName}) rejoint la partie ${Object.keys(games).find(key => games[key] === game)} en tant que ${symbol}`);
    });

    // ------------------------------------------------------------
    // ÉVÉNEMENT : Demander l'état de la partie
    // ------------------------------------------------------------
    socket.on('request_state', (data) => {
        const roomId = data.room;
        if (!roomId || !games[roomId]) return;
        
        const game = games[roomId];
        socket.emit('game_state', {
            board: game.board,
            turn: game.turn,
            winner: game.winner
        });
    });

    // ------------------------------------------------------------
    // ÉVÉNEMENT : Effectuer un mouvement
    // ------------------------------------------------------------
    socket.on('move', (data) => {
        const roomId = data.room;
        const position = data.position;
        
        if (!roomId || position === undefined || !games[roomId]) {
            socket.emit('error', { message: 'Données invalides' });
            return;
        }
        
        const game = games[roomId];
        
        // Vérifier que le joueur est dans la partie
        if (!Object.values(game.players).includes(socket.id)) {
            socket.emit('error', { message: 'Vous n\'êtes pas dans cette partie' });
            return;
        }
        
        // Vérifier que la partie n'est pas terminée
        if (game.winner) {
            socket.emit('error', { message: 'Cette partie est déjà terminée' });
            return;
        }
        
        // Récupérer le symbole du joueur
        let playerSymbol = null;
        for (const [symbol, sid] of Object.entries(game.players)) {
            if (sid === socket.id) {
                playerSymbol = symbol;
                break;
            }
        }
        
        if (!playerSymbol) {
            socket.emit('error', { message: 'Erreur de symbole' });
            return;
        }
        
        // Vérifier que c'est le tour du joueur
        if (playerSymbol !== game.turn) {
            socket.emit('error', { message: 'Ce n\'est pas votre tour' });
            return;
        }
        
        // Vérifier que la case est libre
        if (game.board[position] !== 0) {
            socket.emit('error', { message: 'Cette case est déjà occupée' });
            return;
        }
        
        // Jouer le coup
        game.board[position] = playerSymbol === 'X' ? 1 : 2;
        game.lastMove = Date.now();
        
        // Vérifier l'état de la partie
        const winner = checkWinner(game.board);
        if (winner) {
            game.winner = winner;
            game.turn = null;
        } else {
            game.turn = game.turn === 'X' ? 'O' : 'X';
        }
        
        // Diffuser l'état à tous les joueurs de la salle
        const state = {
            board: game.board,
            turn: game.turn,
            winner: game.winner
        };
        
        io.to(roomId).emit('game_state', state);
        
        // Si la partie est terminée, envoyer un message spécial
        if (winner) {
            const message = winner === 'draw' ? 'Match nul !' : `Le joueur ${winner} a gagné !`;
            io.to(roomId).emit('game_over', {
                winner: winner,
                message: message
            });
            
            // Récupérer les noms des joueurs
            const winnerName = winner !== 'draw' ? game.playersNames[winner] : null;
            const loserSymbol = winner === 'X' ? 'O' : 'X';
            const loserName = game.playersNames[loserSymbol];
            
            if (winnerName) {
                // Envoyer des messages personnalisés aux joueurs
                for (const [symbol, sid] of Object.entries(game.players)) {
                    const playerSocket = io.sockets.sockets.get(sid);
                    if (playerSocket) {
                        if (symbol === winner) {
                            playerSocket.emit('personal_result', {
                                result: 'win',
                                message: `🎉 Vous avez gagné !`
                            });
                        } else {
                            playerSocket.emit('personal_result', {
                                result: 'lose',
                                message: `😢 ${winnerName} a gagné...`
                            });
                        }
                    }
                }
            }
        }
        
        console.log(`🎯 Mouvement de ${playerSymbol} à la position ${position} dans ${roomId}`);
    });

    // ------------------------------------------------------------
    // ÉVÉNEMENT : Réinitialiser la partie
    // ------------------------------------------------------------
    socket.on('reset_game', (data) => {
        const roomId = data.room;
        if (!roomId || !games[roomId]) {
            socket.emit('error', { message: 'Partie inexistante' });
            return;
        }
        
        const game = games[roomId];
        
        // Vérifier que le joueur est dans la partie
        if (!Object.values(game.players).includes(socket.id)) {
            socket.emit('error', { message: 'Vous n\'êtes pas dans cette partie' });
            return;
        }
        
        // Réinitialiser le jeu
        game.board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        game.turn = 'X';
        game.winner = null;
        game.lastMove = Date.now();
        
        // Diffuser la réinitialisation
        io.to(roomId).emit('game_state', {
            board: game.board,
            turn: game.turn,
            winner: null
        });
        
        io.to(roomId).emit('game_reset', { message: 'La partie a été réinitialisée' });
        
        console.log(`🔄 Partie ${roomId} réinitialisée par ${socket.id}`);
    });

    // ------------------------------------------------------------
    // ÉVÉNEMENT : Quitter la partie
    // ------------------------------------------------------------
    socket.on('leave_game', (data) => {
        const roomId = data.room;
        handlePlayerLeave(socket, roomId);
    });

    // ------------------------------------------------------------
    // ÉVÉNEMENT : Ping (maintenir la connexion)
    // ------------------------------------------------------------
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    // ------------------------------------------------------------
    // ÉVÉNEMENT : Déconnexion
    // ------------------------------------------------------------
    socket.on('disconnect', () => {
        console.log(`🔌 Client déconnecté : ${socket.id}`);
        
        // Trouver la partie du joueur
        for (const [roomId, game] of Object.entries(games)) {
            let playerSymbol = null;
            for (const [symbol, sid] of Object.entries(game.players)) {
                if (sid === socket.id) {
                    playerSymbol = symbol;
                    break;
                }
            }
            
            if (playerSymbol) {
                handlePlayerLeave(socket, roomId, true);
                break;
            }
        }
    });

    /**
     * Gère le départ d'un joueur d'une partie.
     */
    function handlePlayerLeave(socket, roomId, isDisconnect = false) {
        if (!roomId || !games[roomId]) return;
        
        const game = games[roomId];
        
        // Trouver le symbole du joueur
        let playerSymbol = null;
        for (const [symbol, sid] of Object.entries(game.players)) {
            if (sid === socket.id) {
                playerSymbol = symbol;
                break;
            }
        }
        
        if (!playerSymbol) return;
        
        // Retirer le joueur
        delete game.players[playerSymbol];
        delete game.playersNames[playerSymbol];
        
        // Quitter la room
        socket.leave(roomId);
        
        // Informer l'autre joueur
        const otherPlayers = Object.entries(game.players);
        if (otherPlayers.length > 0) {
            const [otherSymbol, otherSocketId] = otherPlayers[0];
            const otherSocket = io.sockets.sockets.get(otherSocketId);
            
            if (otherSocket) {
                const message = isDisconnect ? 
                    `Le joueur ${playerSymbol} s'est déconnecté` :
                    `Le joueur ${playerSymbol} a quitté la partie`;
                otherSocket.emit('opponent_left', {
                    room: roomId,
                    message: message
                });
                
                // Mettre à jour le compteur
                otherSocket.emit('player_count', { count: 1 });
            }
        } else {
            // Plus de joueurs, supprimer la partie
            delete games[roomId];
            console.log(`🗑️ Partie ${roomId} supprimée (plus de joueurs)`);
        }
        
        // Envoyer confirmation au joueur qui quitte
        if (!isDisconnect) {
            socket.emit('left_game', { room: roomId });
        }
        
        console.log(`👋 Joueur ${socket.id} (${playerSymbol}) a quitté la partie ${roomId}`);
    }
});

// ----------------------------------------------------------------
// 5. FONCTIONS UTILITAIRES
// ----------------------------------------------------------------

/**
 * Récupère l'URL de base du serveur.
 */
function getBaseUrl(socket) {
    const host = socket.handshake.headers.host;
    const protocol = socket.handshake.secure ? 'https' : 'http';
    return `${protocol}://${host}`;
}

// ----------------------------------------------------------------
// 6. DÉMARRAGE DU SERVEUR
// ----------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
    console.log(`📡 Socket.IO actif sur le port ${PORT}`);
    console.log(`🔗 Pour jouer : http://localhost:${PORT}`);
    console.log(`⏳ Appuyez sur Ctrl+C pour arrêter`);
});

// Gestion des erreurs
process.on('uncaughtException', (err) => {
    console.error('❌ Erreur non capturée:', err);
});

process.on('SIGINT', () => {
    console.log('\n👋 Arrêt du serveur...');
    process.exit(0);
});