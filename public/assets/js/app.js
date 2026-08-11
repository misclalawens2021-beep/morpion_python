        const socket = io();
        let currentRoom = null;
        let mySymbol = null;
        let boardState = [];
        let gameOver = false;
        let statusTurn = null;
        let playerName = '';
        let opponentName = 'Adversaire';
        let isWaiting = false;

        const boardDiv = document.getElementById('board');
        const statusDiv = document.getElementById('status');
        const resetBtn = document.getElementById('reset-btn');
        const quitBtn = document.getElementById('quit-btn');
        const roomInfoDiv = document.getElementById('room-info');
        const roomIdSpan = document.getElementById('room-id');
        const playerCountSpan = document.getElementById('player-count');
        const playerNameInput = document.getElementById('player-name');
        const nameSection = document.getElementById('player-name-section');
        const startBtn = document.getElementById('start-btn');

        function updateStatus(message, type = '') {
            statusDiv.textContent = message;
            statusDiv.className = type;
        }

        function renderBoard(board, winningCombo = null) {
            boardDiv.innerHTML = '';
            for (let i = 0; i < 9; i++) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.dataset.index = i;
                const val = board[i];
                if (val === 1) { cell.textContent = 'X'; cell.classList.add('x'); cell.classList.add('taken'); }
                else if (val === 2) { cell.textContent = 'O'; cell.classList.add('o'); cell.classList.add('taken'); }
                
                // Mettre en surbrillance verte uniquement la combinaison gagnante
                if (winningCombo && winningCombo.includes(i)) {
                    cell.classList.add('winner');
                }
                
                cell.addEventListener('click', () => handleCellClick(i));
                boardDiv.appendChild(cell);
            }
            updateBoardStyle();
        }

        function updateBoardStyle() {
            const cells = document.querySelectorAll('.cell');
            const isMyTurn = (mySymbol === statusTurn) && !gameOver && currentRoom !== null && !isWaiting;
            cells.forEach((cell, idx) => {
                const val = boardState[idx];
                if (val !== 0 || !isMyTurn || gameOver || isWaiting) cell.classList.add('disabled');
                else cell.classList.remove('disabled');
            });
        }

        function ensureControlsVisible() {
            // Si on est dans une partie active, forcer l'affichage des boutons
            try {
                if (currentRoom && !isWaiting) {
                    if (quitBtn && quitBtn.classList.contains('hide')) quitBtn.classList.remove('hide');
                    // resetBtn visible seulement si gameOver
                    if (resetBtn && gameOver && resetBtn.classList.contains('hide')) resetBtn.classList.remove('hide');
                }
            } catch (e) { console.warn('ensureControlsVisible error', e); }
        }

        function updateGameState(data) {
            boardState = data.board;
            statusTurn = data.turn;
            gameOver = (data.winner !== null && data.winner !== undefined);
            
            // Rendre la grille avec les cases gagnantes en surbrillance si présentes
            renderBoard(boardState, data.winningCombo);
            
            // Mettre à jour le tableau des scores
            if (data.scores) {
                updateScoreboard(data.scores);
            }
            
            let msg = '', type = 'info';
            if (data.winner === 'draw') { msg = '🤝 Match nul !'; type = 'warning'; gameOver = true; }
            else if (data.winner === 'X' || data.winner === 'O') {
                const winnerName = data.winner === mySymbol ? 'Vous' : opponentName;
                msg = `🏆 ${winnerName} a gagné !`;
                type = 'success';
                gameOver = true;
            } else {
                if (data.turn) {
                    const turnName = data.turn === mySymbol ? 'Vous' : opponentName;
                    msg = `🎯 Tour de ${turnName}`;
                    if (mySymbol === data.turn) { msg += ' 👈 (à vous de jouer)'; type = 'success'; }
                    else type = 'info';
                } else msg = '⏳ Partie en cours...';
            }
            
            if (gameOver) { 
                msg += ' 🔄 Cliquez sur "Nouvelle partie" pour rejouer.'; 
                resetBtn.classList.remove('hide'); 
            } else {
                resetBtn.classList.add('hide');
            }
            
            updateStatus(msg, type);
            quitBtn.classList.remove('hide');
            
            // Afficher le scoreboard et les réactions si la partie est active et que l'on n'attend pas d'adversaire
            if (currentRoom && !isWaiting) {
                document.getElementById('scoreboard').classList.remove('hide');
                document.getElementById('reaction-panel').classList.remove('hide');
            }

            // Sécurité : forcer l'affichage des contrôles après mise à jour
            ensureControlsVisible();
        }

        function updateScoreboard(scores) {
            if (!scores) return;
            document.getElementById('scoreboard').classList.remove('hide');
            
            const nameX = mySymbol === 'X' ? playerName : (opponentName || 'Adversaire X');
            const nameO = mySymbol === 'O' ? playerName : (opponentName || 'Adversaire O');
            
            document.getElementById('score-name-x').textContent = nameX;
            document.getElementById('score-name-o').textContent = nameO;
            
            document.getElementById('score-val-x').textContent = scores.X;
            document.getElementById('score-val-o').textContent = scores.O;
            document.getElementById('score-val-draw').textContent = scores.draws;
        }

        function sendReaction(emoji) {
            if (currentRoom) {
                socket.emit('reaction', { room: currentRoom, emoji: emoji });
                showReaction(playerName, emoji, true);
            }
        }

        function showReaction(senderName, emoji, isSelf) {
            const container = document.getElementById('reaction-toast-container');
            if (!container) return;
            
            const toast = document.createElement('div');
            toast.className = 'reaction-toast';
            if (isSelf) {
                toast.style.borderColor = '#28a745';
            }
            toast.innerHTML = `<span style="font-size: 1.4em;">${emoji}</span> <span>${isSelf ? 'Vous' : senderName} : ${emoji}</span>`;
            container.appendChild(toast);
            
            setTimeout(() => {
                toast.remove();
            }, 3000);
        }

        function handleCellClick(index) {
            if (gameOver || currentRoom === null || isWaiting) return;
            if (boardState[index] !== 0) return;
            if (mySymbol !== statusTurn) return;
            socket.emit('move', { room: currentRoom, position: index });
        }

        function copyRoomLink() {
            const url = window.location.origin + '?room=' + currentRoom;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => {
                    updateStatus('✅ Lien copié dans le presse-papiers !', 'success');
                }).catch(() => fallbackCopy(url));
            } else fallbackCopy(url);
        }

        function fallbackCopy(text) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try { document.execCommand('copy'); updateStatus('✅ Lien copié !', 'success'); }
            catch (err) { updateStatus('❌ Impossible de copier le lien', 'danger'); }
            document.body.removeChild(textarea);
        }

        function joinOrCreateGame() {
            const inputVal = playerNameInput.value.trim();
            if (!inputVal) {
                updateStatus('⚠️ Veuillez saisir un pseudo avant de commencer !', 'danger');
                playerNameInput.focus();
                return;
            }
            playerName = inputVal.substring(0, 20);

            const urlParams = new URLSearchParams(window.location.search);
            const roomParam = urlParams.get('room');
            if (roomParam) {
                socket.emit('join_game', { room: roomParam, player_name: playerName });
                updateStatus(`⏳ Rejoint la salle ${roomParam}...`, 'info');
            } else {
                socket.emit('join_game', { room: null, player_name: playerName });
                updateStatus('⏳ Création d\'une nouvelle partie...', 'info');
            }
            nameSection.style.display = 'none';
            startBtn.disabled = true;
        }

        function resetGame() {
            if (currentRoom) {
                socket.emit('reset_game', { room: currentRoom });
                updateStatus('🔄 Réinitialisation en cours...', 'info');
            }
        }

        function quitGame() {
            if (currentRoom) {
                socket.emit('leave_game', { room: currentRoom });
                updateStatus('👋 Déconnexion en cours...', 'info');
            }
        }

        function renderEmptyBoard() {
            boardDiv.innerHTML = '';
            for (let i = 0; i < 9; i++) {
                const cell = document.createElement('div');
                cell.className = 'cell disabled';
                cell.dataset.index = i;
                boardDiv.appendChild(cell);
            }
        }

        function updatePlayerCount(count) {
            playerCountSpan.textContent = count;
        }

        // Événements Socket.IO
        socket.on('connect', () => {
            console.log('✅ Connecté au serveur');
        });

        socket.on('connect_error', (error) => {
            console.error('❌ Erreur de connexion:', error);
            updateStatus('❌ Impossible de se connecter au serveur.', 'danger');
            startBtn.disabled = false;
        });

        socket.on('connected', (data) => {
            console.log('📨 Message du serveur:', data.message);
        });

        socket.on('game_start', (data) => {
            currentRoom = data.room;
            mySymbol = data.symbol;
            boardState = data.board;
            statusTurn = data.turn;
            gameOver = false;
            isWaiting = data.waiting || false;
            roomIdSpan.textContent = currentRoom;
            roomInfoDiv.style.display = 'block';
            resetBtn.classList.add('hide');
            quitBtn.classList.remove('hide');
            startBtn.disabled = false;
            updatePlayerCount(data.player_count || 1);
            
            if (data.waiting) {
                updateStatus(`⏳ En attente d'un adversaire... Partagez le lien !`, 'waiting');
                renderEmptyBoard();
                isWaiting = true;
                document.getElementById('scoreboard').classList.add('hide');
                document.getElementById('reaction-panel').classList.add('hide');
            } else {
                opponentName = data.opponent_name || 'Adversaire';
                document.getElementById('scoreboard').classList.remove('hide');
                document.getElementById('reaction-panel').classList.remove('hide');
                updateGameState(data);
            }
            const newUrl = window.location.origin + '?room=' + currentRoom;
            window.history.pushState({ room: currentRoom }, '', newUrl);
        });

        socket.on('game_state', (data) => {
            updateGameState(data);
        });

        socket.on('opponent_joined', (data) => {
            opponentName = data.player_name || 'Adversaire';
            isWaiting = false;
            updateStatus(`👋 ${opponentName} a rejoint la partie !`, 'success');
            updatePlayerCount(2);
            document.getElementById('scoreboard').classList.remove('hide');
            document.getElementById('reaction-panel').classList.remove('hide');
            setTimeout(() => {
                if (currentRoom) socket.emit('request_state', { room: currentRoom });
            }, 300);
        });

        socket.on('opponent_left', (data) => {
            updateStatus(`👋 ${data.message}`, 'danger');
            boardDiv.innerHTML = '';
            resetBtn.classList.add('hide');
            quitBtn.classList.add('hide');
            roomInfoDiv.style.display = 'none';
            document.getElementById('scoreboard').classList.add('hide');
            document.getElementById('reaction-panel').classList.add('hide');
            currentRoom = null;
            mySymbol = null;
            gameOver = true;
            isWaiting = false;
            nameSection.style.display = 'block';
            startBtn.disabled = false;
            updatePlayerCount(0);
            window.history.pushState({}, '', window.location.origin);
        });

        socket.on('opponent_disconnected', (data) => {
            updateStatus(`⏳ ${data.player_name} s'est déconnecté. Délai de grâce de ${data.grace_period}s en cours...`, 'danger');
            isWaiting = true;
            updateBoardStyle();
        });

        socket.on('opponent_reconnected', (data) => {
            updateStatus(`🔌 ${data.player_name} s'est reconnecté !`, 'success');
            isWaiting = false;
            updateBoardStyle();
        });

        socket.on('opponent_reaction', (data) => {
            showReaction(data.player_name, data.emoji, false);
        });

        socket.on('game_over', (data) => {
            console.log('🏁 Partie terminée:', data.message);
        });

        socket.on('game_reset', (data) => {
            updateStatus('🔄 Partie réinitialisée !', 'info');
        });

        socket.on('game_expired', (data) => {
            updateStatus('⏰ La partie a expiré (inactivité)', 'danger');
            boardDiv.innerHTML = '';
            resetBtn.classList.add('hide');
            quitBtn.classList.add('hide');
            roomInfoDiv.style.display = 'none';
            document.getElementById('scoreboard').classList.add('hide');
            document.getElementById('reaction-panel').classList.add('hide');
            currentRoom = null;
            mySymbol = null;
            gameOver = true;
            isWaiting = false;
            nameSection.style.display = 'block';
            startBtn.disabled = false;
            updatePlayerCount(0);
            window.history.pushState({}, '', window.location.origin);
        });

        socket.on('left_game', (data) => {
            updateStatus('👋 Vous avez quitté la partie', 'info');
            boardDiv.innerHTML = '';
            resetBtn.classList.add('hide');
            quitBtn.classList.add('hide');
            roomInfoDiv.style.display = 'none';
            document.getElementById('scoreboard').classList.add('hide');
            document.getElementById('reaction-panel').classList.add('hide');
            currentRoom = null;
            mySymbol = null;
            gameOver = true;
            isWaiting = false;
            nameSection.style.display = 'block';
            startBtn.disabled = false;
            updatePlayerCount(0);
            window.history.pushState({}, '', window.location.origin);
        });

        socket.on('personal_result', (data) => {
            updateStatus(data.message, data.result === 'win' ? 'success' : 'danger');
        });

        socket.on('error', (data) => {
            updateStatus(`❌ ${data.message}`, 'danger');
            console.error('Erreur:', data.message);
        });

        socket.on('join_error', (data) => {
            updateStatus(`❌ ${data.message}`, 'danger');
            nameSection.style.display = 'block';
            startBtn.disabled = false;
        });

        socket.on('pong', (data) => {
            console.log('🏓 Pong reçu:', data.timestamp);
        });

        socket.on('player_count', (data) => {
            updatePlayerCount(data.count);
        });

        socket.on('reconnected', (data) => {
            if (data.room && data.room === currentRoom) {
                updateStatus('✅ Reconnecté à la partie', 'success');
            }
        });

        socket.on('reconnect', (attemptNumber) => {
            console.log(`✅ Reconnecté après ${attemptNumber} tentative(s)`);
            updateStatus('✅ Reconnecté au serveur !', 'success');
            if (currentRoom && playerName) {
                setTimeout(() => {
                    socket.emit('join_game', { room: currentRoom, player_name: playerName });
                }, 500);
            }
        });

        socket.on('disconnect', () => {
            console.warn('⚠️ Déconnecté du serveur');
            updateStatus('❌ Déconnecté du serveur. Reconnexion en cours...', 'danger');
        });

        // Ping pour maintenir la connexion
        setInterval(() => {
            if (socket.connected) socket.emit('ping');
        }, 20000);

        // Initialisation
        playerNameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); joinOrCreateGame(); }
        });
        playerNameInput.focus();

        const initialUrlParams = new URLSearchParams(window.location.search);
        const initialRoom = initialUrlParams.get('room');
        if (initialRoom) {
            updateStatus(`🔗 Lien reçu pour la salle ${initialRoom}. Entrez votre pseudo pour commencer.`, 'info');
        }

        window.joinOrCreateGame = joinOrCreateGame;
        window.resetGame = resetGame;
        window.quitGame = quitGame;
        window.copyRoomLink = copyRoomLink;
        window.sendReaction = sendReaction;

        console.log('🎮 Morpion Multijoueur - Client prêt !');