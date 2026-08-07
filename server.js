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
//   'winningCombo': null,
//   'scores': { 'X': 0, 'O': 0, 'draws': 0 },
//   'disconnected': { 'X': false, 'O': false },
//   'timeouts': { 'X': timer, 'O': timer },
//   'createdAt': timestamp,
//   'lastMove': timestamp
// }

// ----------------------------------------------------------------
// 3. FONCTIONS UTILITAIRES
// ----------------------------------------------------------------

/**
 * Vérifie s'il y a un gagnant ou un match nul.
 * Retourne un objet { winner, combo } ou null.
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
            return { winner: board[a] === 1 ? 'X' : 'O', combo };
        }
    }
    
    if (board.every(cell => cell !== 0)) {
        return { winner: 'draw', combo: null };
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
        let activeRoomId = roomId;

        // Si un roomId est fourni, essayer de rejoindre cette salle
        if (roomId && games[roomId]) {
            game = games[roomId];

            // Vérifier s'il s'agit d'une reconnexion d'un joueur déconnecté
            let reconnectSymbol = null;
            if (game.disconnected) {
                for (const [symbol, isDisc] of Object.entries(game.disconnected)) {
                    if (isDisc && game.playersNames[symbol] === playerName) {
                        reconnectSymbol = symbol;
                        break;
                    }
                }
            }

            if (reconnectSymbol) {
                // Annuler le timeout de déconnexion
                if (game.timeouts && game.timeouts[reconnectSymbol]) {
                    clearTimeout(game.timeouts[reconnectSymbol]);
                    delete game.timeouts[reconnectSymbol];
                }
                delete game.disconnected[reconnectSymbol];

                // Mettre à jour le socket ID et joindre la salle
                game.players[reconnectSymbol] = socket.id;
                socket.join(roomId);

                // Trouver l'adversaire
                const otherSymbol = reconnectSymbol === 'X' ? 'O' : 'X';
                const opponentName = game.playersNames[otherSymbol] || 'Adversaire';

                // Renvoyer l'état d'accueil au joueur reconnecté
                socket.emit('game_start', {
                    room: roomId,
                    board: game.board,
                    turn: game.turn,
                    symbol: reconnectSymbol,
                    waiting: false,
                    player_name: playerName,
                    opponent_name: opponentName,
                    player_count: Object.keys(game.players).length,
                    scores: game.scores
                });

                // Informer l'autre joueur de la reconnexion
                const otherSocketId = game.players[otherSymbol];
                const otherSocket = io.sockets.sockets.get(otherSocketId);
                if (otherSocket) {
                    otherSocket.emit('opponent_reconnected', {
                        player_name: playerName
                    });
                }

                // Renvoyer l'état actuel de la partie
                const state = {
                    board: game.board,
                    turn: game.turn,
                    winner: game.winner,
                    winningCombo: game.winningCombo,
                    scores: game.scores
                };
                io.to(roomId).emit('game_state', state);

                console.log(`🔌 Joueur ${playerName} (${reconnectSymbol}) reconnecté à la partie ${roomId}`);
                return;
            }

            // Vérifier si la partie est pleine (en excluant les déconnectés éventuels qui n'ont pas encore expiré)
            const activePlayersCount = Object.keys(game.players).filter(symbol => !game.disconnected || !game.disconnected[symbol]).length;
            if (activePlayersCount >= 2) {
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
            activeRoomId = generateRoomId();
            game = {
                players: {},
                playersNames: {},
                board: [0, 0, 0, 0, 0, 0, 0, 0, 0],
                turn: 'X',
                winner: null,
                winningCombo: null,
                scores: { 'X': 0, 'O': 0, 'draws': 0 },
                disconnected: {},
                timeouts: {},
                createdAt: Date.now(),
                lastMove: Date.now()
            };
            games[activeRoomId] = game;
            isNewGame = true;

            // Répondre avec le nouveau roomId
            socket.emit('room_created', {
                room: activeRoomId,
                url: `${getBaseUrl(socket)}?room=${activeRoomId}`
            });

            console.log(`🎮 Nouvelle partie créée : ${activeRoomId} par ${socket.id}`);
        }

        // Déterminer le symbole du joueur
        let symbol = 'X';
        if (game.players['X']) {
            symbol = 'O';
        }

        // Ajouter le joueur à la partie
        game.players[symbol] = socket.id;
        game.playersNames[symbol] = playerName;
        game.lastMove = Date.now();

        // Rejoindre la room Socket.IO
        socket.join(activeRoomId);

        // Envoyer le start au joueur
        const isWaiting = Object.keys(game.players).length < 2;
        const opponentSymbol = symbol === 'X' ? 'O' : 'X';
        const opponentName = game.playersNames[opponentSymbol] || null;

        socket.emit('game_start', {
            room: activeRoomId,
            board: game.board,
            turn: game.turn,
            symbol: symbol,
            waiting: isWaiting,
            player_name: playerName,
            opponent_name: opponentName,
            player_count: Object.keys(game.players).length,
            scores: game.scores
        });

        // Si la partie est complète, informer les deux joueurs
        if (!isWaiting) {
            // Informer l'autre joueur que l'adversaire a rejoint
            const otherSocketId = game.players[opponentSymbol];
            const otherSocket = io.sockets.sockets.get(otherSocketId);

            if (otherSocket) {
                otherSocket.emit('opponent_joined', {
                    player_name: playerName,
                    room: activeRoomId
                });

                // Envoyer l'état complet aux deux joueurs
                const state = {
                    board: game.board,
                    turn: game.turn,
                    winner: game.winner,
                    winningCombo: game.winningCombo,
                    scores: game.scores
                };

                io.to(activeRoomId).emit('game_state', state);
            }

            // Envoyer le nombre de joueurs
            io.to(activeRoomId).emit('player_count', {
                count: 2
            });
        }

        console.log(`✅ Joueur ${socket.id} (${playerName}) rejoint la partie ${activeRoomId} en tant que ${symbol}`);
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
            winner: game.winner,
            winningCombo: game.winningCombo,
            scores: game.scores
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
        const checkResult = checkWinner(game.board);
        if (checkResult) {
            game.winner = checkResult.winner;
            game.winningCombo = checkResult.combo;
            game.turn = null;
            
            // Mettre à jour le scoreboard
            if (game.winner === 'draw') {
                game.scores.draws++;
            } else {
                game.scores[game.winner]++;
            }
        } else {
            game.turn = game.turn === 'X' ? 'O' : 'X';
        }
        
        // Diffuser l'état à tous les joueurs de la salle
        const state = {
            board: game.board,
            turn: game.turn,
            winner: game.winner,
            winningCombo: game.winningCombo,
            scores: game.scores
        };
        
        io.to(roomId).emit('game_state', state);
        
        // Si la partie est terminée, envoyer un message spécial
        if (game.winner) {
            const message = game.winner === 'draw' ? 'Match nul !' : `Le joueur ${game.winner} a gagné !`;
            io.to(roomId).emit('game_over', {
                winner: game.winner,
                message: message
            });
            
            // Récupérer les noms des joueurs
            const winnerName = game.winner !== 'draw' ? game.playersNames[game.winner] : null;
            const loserSymbol = game.winner === 'X' ? 'O' : 'X';
            const loserName = game.playersNames[loserSymbol];
            
            if (winnerName) {
                // Envoyer des messages personnalisés aux joueurs
                for (const [symbol, sid] of Object.entries(game.players)) {
                    const playerSocket = io.sockets.sockets.get(sid);
                    if (playerSocket) {
                        if (symbol === game.winner) {
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
        
        // Réinitialiser le jeu (en conservant les scores)
        game.board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        game.turn = 'X';
        game.winner = null;
        game.winningCombo = null;
        game.lastMove = Date.now();
        
        // Diffuser la réinitialisation avec le scoreboard
        io.to(roomId).emit('game_state', {
            board: game.board,
            turn: game.turn,
            winner: null,
            winningCombo: null,
            scores: game.scores
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
    // ÉVÉNEMENT : Réaction / Émoticône rapide
    // ------------------------------------------------------------
    socket.on('reaction', (data) => {
        const roomId = data.room;
        const emoji = data.emoji;
        if (!roomId || !emoji || !games[roomId]) return;
        
        const game = games[roomId];
        let senderSymbol = null;
        for (const [symbol, sid] of Object.entries(game.players)) {
            if (sid === socket.id) {
                senderSymbol = symbol;
                break;
            }
        }
        if (!senderSymbol) return;
        const senderName = game.playersNames[senderSymbol];
        
        // Relayer la réaction à l'adversaire
        socket.to(roomId).emit('opponent_reaction', {
            player_name: senderName,
            emoji: emoji
        });
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
                // S'ils s'étaient déjà déconnectés ou s'ils se déconnectent temporairement
                handlePlayerDisconnectGrace(socket, roomId, playerSymbol);
                break;
            }
        }
    });

    /**
     * Gère la déconnexion temporaire d'un joueur (délai de grâce).
     */
    function handlePlayerDisconnectGrace(socket, roomId, playerSymbol) {
        if (!roomId || !games[roomId]) return;
        
        const game = games[roomId];
        game.disconnected = game.disconnected || {};
        game.disconnected[playerSymbol] = true;
        
        // Trouver l'autre joueur
        const otherSymbol = playerSymbol === 'X' ? 'O' : 'X';
        const otherSocketId = game.players[otherSymbol];
        const otherSocket = io.sockets.sockets.get(otherSocketId);
        
        if (otherSocket) {
            otherSocket.emit('opponent_disconnected', {
                player_name: game.playersNames[playerSymbol],
                symbol: playerSymbol,
                grace_period: 30
            });
        }
        
        // Déclencher un timeout de 30 secondes pour une déconnexion définitive
        game.timeouts = game.timeouts || {};
        if (game.timeouts[playerSymbol]) {
            clearTimeout(game.timeouts[playerSymbol]);
        }
        
        game.timeouts[playerSymbol] = setTimeout(() => {
            console.log(`⏰ Délai de grâce expiré pour ${game.playersNames[playerSymbol]} (${playerSymbol}) dans la salle ${roomId}`);
            
            // Retirer définitivement le joueur
            delete game.players[playerSymbol];
            delete game.playersNames[playerSymbol];
            if (game.disconnected) delete game.disconnected[playerSymbol];
            if (game.timeouts) delete game.timeouts[playerSymbol];
            
            // Informer l'autre joueur que son opposant a définitivement quitté
            if (otherSocket) {
                otherSocket.emit('opponent_left', {
                    room: roomId,
                    message: `Le joueur ${playerSymbol} s'est déconnecté définitivement`
                });
                otherSocket.emit('player_count', { count: 1 });
            } else {
                // Plus aucun joueur actif ou connecté, supprimer la partie
                if (Object.keys(game.players).length === 0) {
                    delete games[roomId];
                    console.log(`🗑️ Partie ${roomId} supprimée (aucun joueur restant après expiration)`);
                }
            }
        }, 30 * 1000);
        
        console.log(`⏳ Joueur ${game.playersNames[playerSymbol]} (${playerSymbol}) déconnecté de la salle ${roomId}. Délai de grâce de 30s démarré.`);
    }

    /**
     * Gère le départ d'un joueur d'une partie (clic sur Quitter).
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
        
        // Retirer le joueur et nettoyer ses timers de reconnexion
        delete game.players[playerSymbol];
        delete game.playersNames[playerSymbol];
        if (game.disconnected) delete game.disconnected[playerSymbol];
        if (game.timeouts && game.timeouts[playerSymbol]) {
            clearTimeout(game.timeouts[playerSymbol]);
            delete game.timeouts[playerSymbol];
        }
        
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

// Exports pour les tests unitaires
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { checkWinner };
}