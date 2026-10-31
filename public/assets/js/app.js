/**
 * ================================================================
 * CLIENT MORPION MULTIJOUEUR (navigateur)
 * ================================================================
 *
 * Ce fichier gère tout ce qui se passe côté joueur :
 * - la connexion au serveur via Socket.IO (mode en ligne)
 * - l'affichage du plateau, du score et des messages d'état
 * - les actions du joueur (jouer, rejouer, quitter, réagir)
 * - le mode SOLO contre l'ordinateur (IA à 3 niveaux, sans serveur)
 * - le mode TOURNOI en ligne (2 à 8 joueurs, élimination directe)
 *
 * Codage du plateau : 0 = case vide, 1 = X, 2 = O
 * (le plateau est un tableau de 9 cases, numérotées de 0 à 8)
 * ================================================================
 */

        // ---------------------------------------------------------------
        // 1. ÉTAT DU JEU ET RÉFÉRENCES AU DOM
        // ---------------------------------------------------------------

        // Connexion Socket.IO avec le serveur (fournie par /socket.io/socket.io.js)
        const socket = io();
        // Identifiant de la salle en cours (null = pas en ligne)
        let currentRoom = null;
        // Symbole du joueur local : 'X' ou 'O'
        let mySymbol = null;
        // Dernier plateau affiché (tableau de 9 cases : 0, 1 ou 2)
        let boardState = [];
        // true quand la manche est terminée (victoire ou nul)
        let gameOver = false;
        // Symbole dont c'est le tour ('X', 'O' ou null si la manche est finie)
        let statusTurn = null;
        // Pseudo du joueur local et nom de l'adversaire
        let playerName = '';
        let opponentName = 'Adversaire';
        // true tant qu'on attend un adversaire (ou qu'il est déconnecté)
        let isWaiting = false;
        let soloMode = false; // true = partie contre l'ordinateur (sans serveur)
        let tournamentMode = false; // true = on est dans un tournoi en ligne

        // Éléments de la page utilisés régulièrement
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

        // ---------------------------------------------------------------
        // 2. AFFICHAGE
        // ---------------------------------------------------------------

        /**
         * Affiche un message dans le bandeau d'état.

         * @param {string} message - texte à afficher
         * @param {string} type - classe CSS : 'waiting', 'success', 'danger' ou 'info'
         */
        function updateStatus(message, type = '') {
            statusDiv.textContent = message;
            statusDiv.className = type;
        }

        /**
         * Redessine les 9 cases du plateau.
         * @param {number[]} board - plateau (0 = vide, 1 = X, 2 = O)
         * @param {number[]|null} winningCombo - indices des cases gagnantes à mettre en surbrillance
         */
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

        /**
         * Grise les cases quand on ne peut pas jouer :
         * case déjà prise, tour de l'adversaire, manche finie ou attente d'un joueur.
         */
        function updateBoardStyle() {
            const cells = document.querySelectorAll('.cell');
            const isMyTurn = (mySymbol === statusTurn) && !gameOver && (currentRoom !== null || soloMode || tournamentMode) && !isWaiting;
            cells.forEach((cell, idx) => {
                const val = boardState[idx];
                if (val !== 0 || !isMyTurn || gameOver || isWaiting) cell.classList.add('disabled');
                else cell.classList.remove('disabled');
            });
        }

        /**
         * Sécurité : s'assure que les boutons « Quitter » et « Nouvelle partie »
         * sont bien visibles quand on est dans une partie en ligne.
         */
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

        /**
         * Applique l'état de la partie reçu du serveur (mode en ligne) :
         * plateau, scores, message d'état (tour, victoire, nul) et boutons.
         * @param {{board:number[], turn:string|null, winner:string|null, winningCombo:number[]|null, scores:object}} data
         */
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

        /**
         * Met à jour le tableau des scores (noms, victoires X/O et nuls).
         * @param {{X:number, O:number, draws:number}} scores
         */
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

        // ---------------------------------------------------------------
        // 3. ACTIONS DU JOUEUR (appelées par les boutons et les clics)
        // ---------------------------------------------------------------

        /** Envoie une réaction à l'adversaire (mode en ligne uniquement). */
        function sendReaction(emoji) {
            if (currentRoom) {
                socket.emit('reaction', { room: currentRoom, emoji: emoji });
                showReaction(playerName, emoji, true);
            }
        }

        /**
         * Affiche une réaction (emoji) sous forme de petite notification qui disparaît après 3 s.
         * @param {string} senderName - nom de celui qui réagit
         * @param {string} emoji - l'emoji envoyé
         * @param {boolean} isSelf - true si c'est nous qui avons envoyé la réaction
         */
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

        /**
         * Clic sur une case. En mode solo, on délègue au jeu local ;
         * en ligne, on envoie le coup au serveur qui le valide (c'est lui l'arbitre).
         * @param {number} index - numéro de la case (0 à 8)
         */
        function handleCellClick(index) {
            if (soloMode) { soloPlayerMove(index); return; }
            if (tournamentMode) {
                // En tournoi aussi, le serveur valide le coup ; on filtre juste les clics inutiles
                if (gameOver || boardState[index] !== 0 || mySymbol !== statusTurn) return;
                socket.emit('tournament_move', { index });
                return;
            }
            if (gameOver || currentRoom === null || isWaiting) return;
            if (boardState[index] !== 0) return;
            if (mySymbol !== statusTurn) return;
            socket.emit('move', { room: currentRoom, position: index });
        }

        /** Copie dans le presse-papiers le lien d'invitation de la salle. */
        function copyRoomLink() {
            const url = window.location.origin + '?room=' + currentRoom;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => {
                    updateStatus('✅ Lien copié dans le presse-papiers !', 'success');
                }).catch(() => fallbackCopy(url));
            } else fallbackCopy(url);
        }

        /** Copie de secours (anciens navigateurs) via un champ texte invisible. */
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

        /**
         * Bouton « Commencer » : vérifie le pseudo puis demande au serveur
         * de rejoindre la salle du lien (?room=...) ou d'en créer une nouvelle.
         */
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

        /** Bouton « Nouvelle partie » : relance une manche en gardant les scores. */
        function resetGame() {
            if (soloMode) { soloReset(); return; }
            if (currentRoom) {
                socket.emit('reset_game', { room: currentRoom });
                updateStatus('🔄 Réinitialisation en cours...', 'info');
            }
        }

        /** Bouton « Quitter » : quitte la salle (ou la partie solo). */
        function quitGame() {
            if (soloMode) { soloQuit(); return; }
            if (tournamentMode) { tournamentLeave(); return; }
            if (currentRoom) {
                socket.emit('leave_game', { room: currentRoom });
                updateStatus('👋 Déconnexion en cours...', 'info');
            }
        }

        /** Affiche un plateau vide et désactivé (pendant l'attente d'un adversaire). */
        function renderEmptyBoard() {
            boardDiv.innerHTML = '';
            for (let i = 0; i < 9; i++) {
                const cell = document.createElement('div');
                cell.className = 'cell disabled';
                cell.dataset.index = i;
                boardDiv.appendChild(cell);
            }
        }

        /** Met à jour le nombre de joueurs connectés dans l'encart de la salle. */
        function updatePlayerCount(count) {
            playerCountSpan.textContent = count;
        }

        // ================================================================
        // 4. MODE SOLO : JOUEUR (X) CONTRE ORDINATEUR (O) — tout se passe dans le navigateur
        // ================================================================

        // --- IA ---
        // Les 8 alignements gagnants (3 lignes, 3 colonnes, 2 diagonales)
        const WIN_COMBOS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

        /** Équivalent client de checkWinner() du serveur : renvoie { winner, combo } ou null. */
        function soloCheckWinner(board) {
            for (const combo of WIN_COMBOS) {
                const [a, b, c] = combo;
                if (board[a] !== 0 && board[a] === board[b] && board[b] === board[c]) {
                    return { winner: board[a] === 1 ? 'X' : 'O', combo };
                }
            }
            if (board.every(v => v !== 0)) return { winner: 'draw', combo: null };
            return null;
        }

        /** Liste les indices des cases vides. */
        function emptyCells(board) {
            return board.map((v, i) => (v === 0 ? i : -1)).filter(i => i >= 0);
        }

        /** Choisit un élément au hasard dans une liste. */
        function randomItem(list) {
            return list[Math.floor(Math.random() * list.length)];
        }

        // Renvoie une case qui fait gagner immédiatement `value` (1 = X, 2 = O), sinon -1
        function findWinningCell(board, value) {
            for (const i of emptyCells(board)) {
                const copy = board.slice();
                copy[i] = value;
                const result = soloCheckWinner(copy);
                if (result && result.winner === (value === 1 ? 'X' : 'O')) return i;
            }
            return -1;
        }

        // Minimax : O cherche à maximiser le score, X à le minimiser
        function minimax(board, oTurn, depth) {
            const result = soloCheckWinner(board);
            if (result) {
                if (result.winner === 'O') return 10 - depth;
                if (result.winner === 'X') return depth - 10;
                return 0;
            }
            let best = oTurn ? -Infinity : Infinity;
            for (const i of emptyCells(board)) {
                board[i] = oTurn ? 2 : 1;
                const score = minimax(board, !oTurn, depth + 1);
                board[i] = 0;
                best = oTurn ? Math.max(best, score) : Math.min(best, score);
            }
            return best;
        }

        // level : 'easy' (au hasard), 'medium' (gagne / bloque, sinon au hasard), 'hard' (imbattable)
        /**
         * Choisit le coup de l'ordinateur (O).
         * - 'easy'   : une case libre au hasard
         * - 'medium' : gagne s'il peut, bloque le joueur s'il le faut, sinon au hasard
         * - 'hard'   : minimax (explore tous les coups) -> imbattable
         * @returns {number} indice de la case choisie (0 à 8)
         */
        function computerChooseMove(board, level) {
            const free = emptyCells(board);
            if (level === 'easy') return randomItem(free);

            const win = findWinningCell(board, 2);
            if (win !== -1) return win;
            const block = findWinningCell(board, 1);
            if (block !== -1) return block;
            if (level === 'medium') return randomItem(free);

            if (free.length === 9) return randomItem([0, 2, 4, 6, 8]);
            let bestScore = -Infinity;
            let bestCells = [];
            for (const i of free) {
                const copy = board.slice();
                copy[i] = 2;
                const score = minimax(copy, false, 1);
                if (score > bestScore) { bestScore = score; bestCells = [i]; }
                else if (score === bestScore) bestCells.push(i);
            }
            return randomItem(bestCells);
        }
        // --- FIN IA ---

        // État de la partie solo : niveau, plateau, tour, joueur qui commence, scores
        let soloLevel = 'hard';
        let soloBoard = [];
        let soloTurn = 'X';
        let soloStarter = 'X';
        let soloScores = { X: 0, O: 0, draws: 0 };
        let soloTimer = null;

        /** Bouton « Jouer contre l'ordinateur » : prépare une partie locale (joueur = X, ordinateur = O). */
        function startSoloGame() {
            playerName = (playerNameInput.value.trim() || 'Joueur').substring(0, 20);
            opponentName = 'Ordinateur';
            soloLevel = document.getElementById('solo-level').value;
            soloMode = true;
            currentRoom = null;
            mySymbol = 'X';
            isWaiting = false;
            soloScores = { X: 0, O: 0, draws: 0 };
            soloStarter = 'X';

            nameSection.style.display = 'none';
            roomInfoDiv.style.display = 'none';
            document.getElementById('reaction-panel').classList.add('hide');
            quitBtn.classList.remove('hide');
            soloNewRound();
        }

        /** Démarre une manche : plateau vide, et l'ordinateur joue en premier si c'est à lui de commencer. */
        function soloNewRound() {
            clearTimeout(soloTimer);
            soloBoard = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            soloTurn = soloStarter;
            gameOver = false;
            soloRender(null);
            if (soloTurn === 'O') soloScheduleComputer();
        }

        /** Fait jouer l'ordinateur après une courte pause (0,5 à 0,9 s) pour que ça paraisse naturel. */
        function soloScheduleComputer() {
            soloTimer = setTimeout(() => {
                if (!soloMode || gameOver) return;
                soloBoard[computerChooseMove(soloBoard, soloLevel)] = 2;
                soloAfterMove();
            }, 500 + Math.random() * 400);
        }

        /** Coup du joueur : ignoré si ce n'est pas son tour ou si la case est prise. */
        function soloPlayerMove(index) {
            if (!soloMode || gameOver || soloTurn !== 'X' || soloBoard[index] !== 0) return;
            soloBoard[index] = 1;
            soloAfterMove();
        }

        /** Après chaque coup : détecte la fin de manche (et met à jour les scores) ou passe la main. */
        function soloAfterMove() {
            const result = soloCheckWinner(soloBoard);
            if (result) {
                gameOver = true;
                soloTurn = null;
                if (result.winner === 'X') soloScores.X++;
                else if (result.winner === 'O') soloScores.O++;
                else soloScores.draws++;
                soloRender(result);
                return;
            }
            soloTurn = soloTurn === 'X' ? 'O' : 'X';
            soloRender(null);
            if (soloTurn === 'O') soloScheduleComputer();
        }

        /** Dessine le plateau, le score et le message d'état de la partie solo. */
        function soloRender(result) {
            boardState = soloBoard;
            statusTurn = soloTurn;
            renderBoard(boardState, result ? result.combo : null);
            updateScoreboard(soloScores);
            document.getElementById('scoreboard').classList.remove('hide');

            let msg, type;
            if (result) {
                if (result.winner === 'X') { msg = '🏆 Vous avez gagné !'; type = 'success'; }
                else if (result.winner === 'O') { msg = "🤖 L'ordinateur a gagné !"; type = 'danger'; }
                else { msg = '🤝 Match nul !'; type = 'info'; }
                msg += ' 🔄 Cliquez sur "Nouvelle partie" pour rejouer.';
                resetBtn.classList.remove('hide');
            } else {
                if (soloTurn === 'X') { msg = '🎯 À vous de jouer 👈'; type = 'success'; }
                else { msg = "🤖 L'ordinateur réfléchit..."; type = 'info'; }
                resetBtn.classList.add('hide');
            }
            updateStatus(msg, type);
        }

        // Nouvelle manche : le joueur qui commence alterne
        function soloReset() {
            soloStarter = soloStarter === 'X' ? 'O' : 'X';
            soloNewRound();
        }

        /** Quitte la partie solo et revient à l'écran d'accueil. */
        function soloQuit() {
            clearTimeout(soloTimer);
            soloMode = false;
            gameOver = true;
            mySymbol = null;
            statusTurn = null;
            boardDiv.innerHTML = '';
            resetBtn.classList.add('hide');
            quitBtn.classList.add('hide');
            document.getElementById('scoreboard').classList.add('hide');
            nameSection.style.display = 'block';
            startBtn.disabled = false;
            updateStatus("👋 Vous avez quitté la partie contre l'ordinateur", 'info');
        }

        // ================================================================
        // 5. MODE TOURNOI (en ligne) : 2 à 8 joueurs, élimination directe
        // ================================================================
        // Le serveur (tournament.js) gère tout : tirage du tableau, arbitrage des
        // matchs, forfaits. Il envoie à chaque changement un « instantané »
        // ('tournament_state') que ce code se contente d'afficher.

        let tournamentCode = null;   // code du tournoi en cours
        let tournamentYou = null;    // mon identifiant public dans ce tournoi (ex. 'p3')
        let tournamentState = null;  // dernier instantané reçu du serveur
        let tokenFallback = null;

        /** Fabrique un identifiant aléatoire (24 caractères). */
        function makeToken() {
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const bytes = (window.crypto && window.crypto.getRandomValues)
                ? window.crypto.getRandomValues(new Uint8Array(24)) : null;
            let token = '';
            for (let i = 0; i < 24; i++) {
                token += chars[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % chars.length];
            }
            return token;
        }

        /**
         * Identifiant secret de cet onglet : il permet de retrouver sa place dans
         * le tournoi après une coupure réseau ou un rechargement de la page.
         */
        function getPlayerToken() {
            try {
                let token = sessionStorage.getItem('morpionPlayerToken');
                if (!token) {
                    token = makeToken();
                    sessionStorage.setItem('morpionPlayerToken', token);
                }
                return token;
            } catch (e) {
                if (!tokenFallback) tokenFallback = makeToken();
                return tokenFallback;
            }
        }

        /** Lit le pseudo saisi ; affiche une erreur et renvoie null s'il est vide. */
        function readPseudoForTournament() {
            const inputVal = playerNameInput.value.trim();
            if (!inputVal) {
                updateStatus('⚠️ Veuillez saisir un pseudo avant de continuer !', 'danger');
                playerNameInput.focus();
                return null;
            }
            return inputVal.substring(0, 20);
        }

        /** Bouton « Créer un tournoi ». */
        function createTournament() {
            const name = readPseudoForTournament();
            if (!name) return;
            playerName = name;
            socket.emit('tournament_create', { player_name: playerName, player_id: getPlayerToken() });
            updateStatus('⏳ Création du tournoi...', 'info');
        }

        /** Bouton « Rejoindre » : rejoint le tournoi dont on a saisi le code. */
        function joinTournament() {
            const name = readPseudoForTournament();
            if (!name) return;
            const code = document.getElementById('tournament-code').value.trim().toUpperCase();
            if (!code) {
                updateStatus('⚠️ Saisissez le code du tournoi à rejoindre', 'danger');
                document.getElementById('tournament-code').focus();
                return;
            }
            playerName = name;
            socket.emit('tournament_join', { code, player_name: playerName, player_id: getPlayerToken() });
            updateStatus(`⏳ Connexion au tournoi ${code}...`, 'info');
        }

        /** Bouton « Lancer le tournoi » (hôte uniquement). */
        function startTournament() {
            socket.emit('tournament_start');
        }

        /** Quitte le tournoi (par forfait si celui-ci a déjà commencé). */
        function tournamentLeave() {
            const st = tournamentState;
            if (st && st.status === 'running' && !window.confirm('Quitter le tournoi ? Vous perdrez votre match par forfait.')) {
                return;
            }
            if (socket.connected) {
                socket.emit('tournament_leave');
            } else {
                resetTournamentUI('👋 Vous avez quitté le tournoi');
            }
        }

        /** Copie le lien d'invitation du tournoi (?tournoi=CODE). */
        function copyTournamentLink() {
            if (!tournamentCode) return;
            const url = window.location.origin + window.location.pathname + '?tournoi=' + tournamentCode;
            const done = () => showTournamentNotice('📋 Lien copié !');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(done).catch(() => { fallbackCopy(url); done(); });
            } else {
                fallbackCopy(url);
                done();
            }
        }

        /** Petite notification temporaire en haut de l'écran (même style que les réactions). */
        function showTournamentNotice(message) {
            const container = document.getElementById('reaction-toast-container');
            if (!container) return;
            const toast = document.createElement('div');
            toast.className = 'reaction-toast';
            toast.textContent = message;
            // On garde au plus 2 notifications à l'écran pour ne pas cacher le jeu
            while (container.children.length >= 2) container.firstChild.remove();
            container.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }

        /** Passe l'interface en « mode tournoi » (masque l'accueil, affiche le salon). */
        function enterTournamentUI() {
            tournamentMode = true;
            soloMode = false;
            currentRoom = null;
            isWaiting = false;
            nameSection.style.display = 'none';
            roomInfoDiv.style.display = 'none';
            document.getElementById('scoreboard').classList.add('hide');
            document.getElementById('reaction-panel').classList.add('hide');
            resetBtn.classList.add('hide');
            quitBtn.classList.remove('hide');
            document.getElementById('tournament-top').classList.remove('hide');
        }

        /** Revient à l'écran d'accueil. */
        function resetTournamentUI(message) {
            tournamentMode = false;
            tournamentCode = null;
            tournamentYou = null;
            tournamentState = null;
            mySymbol = null;
            statusTurn = null;
            gameOver = true;
            boardDiv.innerHTML = '';
            document.getElementById('tournament-top').classList.add('hide');
            document.getElementById('tournament-bracket').classList.add('hide');
            document.getElementById('tournament-bracket').innerHTML = '';
            document.getElementById('tournament-start-btn').classList.add('hide');
            quitBtn.classList.add('hide');
            resetBtn.classList.add('hide');
            nameSection.style.display = 'block';
            startBtn.disabled = false;
            updateStatus(message || '👋 Vous avez quitté le tournoi', 'info');
        }

        /** Nom d'un joueur à partir de son identifiant public. */
        function tournamentNameOf(st, pub) {
            const p = st.players.find(x => x.pub === pub);
            return p ? p.name : '?';
        }

        /** Dessine toute l'interface du tournoi à partir du dernier instantané. */
        function renderTournament() {
            const st = tournamentState;
            if (!st || !tournamentMode) return;

            document.getElementById('tournament-code-label').textContent = st.code;
            document.getElementById('tournament-count').textContent = `${st.players.length}/${st.maxPlayers}`;
            document.getElementById('tournament-invite').classList.toggle('hide', st.status !== 'lobby');
            renderTournamentPlayers(st);

            const isHost = st.host === tournamentYou;
            const startBtnT = document.getElementById('tournament-start-btn');
            startBtnT.classList.toggle('hide', !(st.status === 'lobby' && isHost));
            startBtnT.disabled = st.players.length < st.minPlayers;

            renderBracket(st);

            const me = st.players.find(p => p.pub === tournamentYou);

            // --- Salon d'attente ---
            if (st.status === 'lobby') {
                boardDiv.innerHTML = '';
                mySymbol = null; statusTurn = null; gameOver = true;
                if (!isHost) {
                    updateStatus(`⏳ En attente du lancement par ${tournamentNameOf(st, st.host)} (${st.players.length}/${st.maxPlayers})`, 'waiting');
                } else if (st.players.length < st.minPlayers) {
                    updateStatus(`⏳ Partagez le code ${st.code} : il faut au moins ${st.minPlayers} joueurs`, 'waiting');
                } else {
                    updateStatus(`✅ ${st.players.length} joueurs prêts. Lancez le tournoi quand tout le monde est là !`, 'success');
                }
                return;
            }

            // --- Mon match en cours (ou qui vient de se terminer) ---
            let myMatch = null;
            let myRoundName = '';
            st.rounds.forEach((round, r) => {
                round.forEach(m => {
                    if ((m.status === 'playing' || m.status === 'draw' || m.status === 'over') &&
                        (m.p1 === tournamentYou || m.p2 === tournamentYou)) {
                        myMatch = m;
                        myRoundName = st.roundNames[r];
                    }
                });
            });

            if (myMatch) {
                const m = myMatch;
                mySymbol = m.sym.X === tournamentYou ? 'X' : 'O';
                statusTurn = m.status === 'playing' ? m.turn : null;
                gameOver = m.status !== 'playing';
                isWaiting = false;
                boardState = m.board.slice();
                renderBoard(boardState, m.combo);

                const opp = tournamentNameOf(st, m.p1 === tournamentYou ? m.p2 : m.p1);
                if (m.status === 'playing') {
                    if (m.turn === mySymbol) {
                        updateStatus(`🎯 ${myRoundName} : à vous de jouer (${mySymbol}) contre ${opp}`, 'success');
                    } else {
                        updateStatus(`⏳ ${myRoundName} : tour de ${opp} (${m.turn})...`, 'info');
                    }
                } else if (m.status === 'draw') {
                    updateStatus('🤝 Match nul ! On rejoue, les symboles s\'inversent...', 'info');
                } else if (m.winner === tournamentYou) {
                    updateStatus(m.forfeit ? `🏆 ${opp} a abandonné : vous êtes qualifié !` : `🏆 Vous battez ${opp} !`, 'success');
                } else {
                    updateStatus(`💥 Défaite contre ${opp}... vous êtes éliminé`, 'danger');
                }
                return;
            }

            // --- Pas de match en cours pour moi ---
            boardDiv.innerHTML = '';
            mySymbol = null; statusTurn = null; gameOver = true;
            if (st.champion === tournamentYou) {
                updateStatus('👑 VOUS ÊTES LE CHAMPION DU TOURNOI !', 'success');
            } else if (st.status === 'finished') {
                updateStatus(`🏆 ${tournamentNameOf(st, st.champion)} remporte le tournoi !`, 'info');
            } else if (me && (me.eliminated || me.gone)) {
                updateStatus('💀 Vous êtes éliminé. Suivez la suite du tournoi !', 'danger');
            } else {
                updateStatus('⏳ Qualifié ! En attente de votre prochain adversaire...', 'waiting');
            }
        }

        /** Liste des joueurs du salon (couronne pour l'hôte, vert pour moi). */
        function renderTournamentPlayers(st) {
            const box = document.getElementById('tournament-players');
            box.innerHTML = '';
            st.players.forEach(p => {
                const chip = document.createElement('span');
                chip.className = 't-player';
                if (p.pub === tournamentYou) chip.classList.add('me');
                if (p.eliminated || p.gone) chip.classList.add('out');
                chip.textContent = (p.pub === st.host ? '👑 ' : '') + p.name + (p.connected ? '' : ' ⚠️');
                box.appendChild(chip);
            });
        }

        /** Tableau du tournoi : une colonne par tour, puis le champion. */
        function renderBracket(st) {
            const box = document.getElementById('tournament-bracket');
            box.classList.toggle('hide', st.status === 'lobby');
            box.innerHTML = '';
            if (st.status === 'lobby') return;

            st.rounds.forEach((round, r) => {
                const col = document.createElement('div');
                col.className = 'bracket-round';
                const title = document.createElement('div');
                title.className = 'bracket-round-title';
                title.textContent = st.roundNames[r];
                col.appendChild(title);
                const list = document.createElement('div');
                list.className = 'bracket-matches';
                col.appendChild(list);

                round.forEach(m => {
                    const card = document.createElement('div');
                    card.className = 'bracket-match';
                    if (m.status === 'playing' || m.status === 'draw') card.classList.add('live');

                    [m.p1, m.p2].forEach(pub => {
                        const row = document.createElement('div');
                        row.className = 'bracket-player';
                        if (!pub) {
                            row.classList.add('tbd');
                            row.textContent = '…';
                        } else {
                            row.textContent = tournamentNameOf(st, pub);
                            if (m.winner === pub) row.classList.add('winner');
                            if (m.winner && m.winner !== pub) row.classList.add('loser');
                            if (pub === tournamentYou) row.classList.add('me');
                        }
                        card.appendChild(row);
                    });

                    let note = '';
                    if (m.bye) note = 'qualifié d\'office';
                    else if (m.status === 'playing') note = '⚔️ en cours';
                    else if (m.status === 'draw') note = '🤝 nul, on rejoue';
                    else if (m.forfeit && m.winner) note = 'par forfait';
                    if (note) {
                        const noteDiv = document.createElement('div');
                        noteDiv.className = 'bracket-note';
                        noteDiv.textContent = note;
                        card.appendChild(noteDiv);
                    }
                    list.appendChild(card);
                });
                box.appendChild(col);
            });

            const last = document.createElement('div');
            last.className = 'bracket-round';
            const lastTitle = document.createElement('div');
            lastTitle.className = 'bracket-round-title';
            lastTitle.textContent = 'Champion';
            last.appendChild(lastTitle);
            const champ = document.createElement('div');
            champ.className = 'bracket-match champion';
            const champRow = document.createElement('div');
            champRow.className = 'bracket-player' + (st.champion ? ' winner' : ' tbd');
            champRow.textContent = st.champion ? '🏆 ' + tournamentNameOf(st, st.champion) : '?';
            champ.appendChild(champRow);
            const champList = document.createElement('div');
            champList.className = 'bracket-matches';
            champList.appendChild(champ);
            last.appendChild(champList);
            box.appendChild(last);
        }

        // --- Événements du tournoi reçus du serveur ---

        // Le serveur confirme notre place (création, jointure ou retour après coupure)
        socket.on('tournament_joined', (data) => {
            tournamentCode = data.code;
            tournamentYou = data.you;
            enterTournamentUI();
        });

        // Nouvel instantané complet du tournoi
        socket.on('tournament_state', (st) => {
            tournamentState = st;
            renderTournament();
        });

        // Petit message d'information (« X a rejoint », « X gagne son match »...)
        socket.on('tournament_notice', (data) => {
            if (tournamentMode) showTournamentNotice(data.message);
        });

        // Erreur : si le tournoi n'existe plus, on retourne à l'accueil
        socket.on('tournament_error', (data) => {
            if (data.fatal && tournamentMode) {
                resetTournamentUI('⚠️ ' + data.message);
            } else if (tournamentMode) {
                showTournamentNotice('⚠️ ' + data.message);
            } else {
                updateStatus('⚠️ ' + data.message, 'danger');
            }
        });

        // Confirmation que nous avons quitté le tournoi
        socket.on('tournament_left', () => {
            resetTournamentUI('👋 Vous avez quitté le tournoi');
        });

        // Après une coupure réseau, on reprend sa place avec le même identifiant secret
        socket.on('connect', () => {
            if (tournamentMode && tournamentCode) {
                socket.emit('tournament_join', {
                    code: tournamentCode,
                    player_name: playerName,
                    player_id: getPlayerToken()
                });
            }
        });

        // Arrivée par un lien d'invitation (?tournoi=CODE) : on pré-remplit le code
        (function () {
            const code = new URLSearchParams(window.location.search).get('tournoi');
            if (code) {
                document.getElementById('tournament-code').value = code.toUpperCase().slice(0, 5);
                updateStatus('🏆 Invitation à un tournoi ! Saisissez votre pseudo puis cliquez sur « Rejoindre »', 'waiting');
            }
        })();

        // ---------------------------------------------------------------
        // 6. ÉVÉNEMENTS REÇUS DU SERVEUR (mode en ligne)
        // ---------------------------------------------------------------

        // Événements Socket.IO
        // Connexion établie avec le serveur
        socket.on('connect', () => {
            console.log('✅ Connecté au serveur');
        });

        // Le serveur est injoignable : on réactive le bouton pour réessayer
        socket.on('connect_error', (error) => {
            console.error('❌ Erreur de connexion:', error);
            updateStatus('❌ Impossible de se connecter au serveur.', 'danger');
            startBtn.disabled = false;
        });

        socket.on('connected', (data) => {
            console.log('📨 Message du serveur:', data.message);
        });

        // Réponse à « rejoindre/créer » : on reçoit la salle, notre symbole et le plateau.
        // Si l'adversaire n'est pas encore là (data.waiting), on affiche le lien à partager.
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

        // Nouvel état de la manche (après un coup, un reset ou une reconnexion)
        socket.on('game_state', (data) => {
            updateGameState(data);
        });

        // Un adversaire vient d'arriver dans notre salle
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

        // L'adversaire a quitté définitivement : retour à l'écran d'accueil
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

        // L'adversaire est déconnecté : le serveur lui laisse 30 s pour revenir
        socket.on('opponent_disconnected', (data) => {
            updateStatus(`⏳ ${data.player_name} s'est déconnecté. Délai de grâce de ${data.grace_period}s en cours...`, 'danger');
            isWaiting = true;
            updateBoardStyle();
        });

        // L'adversaire est revenu pendant le délai de grâce
        socket.on('opponent_reconnected', (data) => {
            updateStatus(`🔌 ${data.player_name} s'est reconnecté !`, 'success');
            isWaiting = false;
            updateBoardStyle();
        });

        // Réaction (emoji) envoyée par l'adversaire
        socket.on('opponent_reaction', (data) => {
            showReaction(data.player_name, data.emoji, false);
        });

        // Fin de manche (le message détaillé est géré par game_state)
        socket.on('game_over', (data) => {
            console.log('🏁 Partie terminée:', data.message);
        });

        // Une nouvelle manche démarre
        socket.on('game_reset', (data) => {
            updateStatus('🔄 Partie réinitialisée !', 'info');
        });

        // Salle supprimée par le serveur après 10 min d'inactivité
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

        // Confirmation que nous avons bien quitté la salle
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

        // Message personnalisé de fin de manche (« Vous avez gagné », etc.)
        socket.on('personal_result', (data) => {
            updateStatus(data.message, data.result === 'win' ? 'success' : 'danger');
        });

        // Erreur renvoyée par le serveur (coup invalide, salle inconnue...)
        socket.on('error', (data) => {
            updateStatus(`❌ ${data.message}`, 'danger');
            console.error('Erreur:', data.message);
        });

        // Impossible de rejoindre la salle (par ex. déjà pleine)
        socket.on('join_error', (data) => {
            updateStatus(`❌ ${data.message}`, 'danger');
            nameSection.style.display = 'block';
            startBtn.disabled = false;
        });

        socket.on('pong', (data) => {
            console.log('🏓 Pong reçu:', data.timestamp);
        });

        // Nombre de joueurs présents dans la salle
        socket.on('player_count', (data) => {
            updatePlayerCount(data.count);
        });

        socket.on('reconnected', (data) => {
            if (data.room && data.room === currentRoom) {
                updateStatus('✅ Reconnecté à la partie', 'success');
            }
        });

        // Après une coupure réseau, on se réinscrit dans la salle avec le même pseudo
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

        // ---------------------------------------------------------------
        // 7. INITIALISATION
        // ---------------------------------------------------------------

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
        // Si on arrive via un lien d'invitation (?room=XXXX), on le signale au joueur
        const initialRoom = initialUrlParams.get('room');
        if (initialRoom) {
            updateStatus(`🔗 Lien reçu pour la salle ${initialRoom}. Entrez votre pseudo pour commencer.`, 'info');
        }

        // Fonctions appelées directement depuis les attributs onclick de index.html
        window.joinOrCreateGame = joinOrCreateGame;
        window.resetGame = resetGame;
        window.quitGame = quitGame;
        window.copyRoomLink = copyRoomLink;
        window.sendReaction = sendReaction;
        window.startSoloGame = startSoloGame;
        window.createTournament = createTournament;
        window.joinTournament = joinTournament;
        window.startTournament = startTournament;
        window.copyTournamentLink = copyTournamentLink;

        console.log('🎮 Morpion Multijoueur - Client prêt !');