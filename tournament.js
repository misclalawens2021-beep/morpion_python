/**
 * ================================================================
 * MODULE TOURNOI (serveur) — élimination directe, de 2 à 8 joueurs
 * ================================================================
 *
 * Fonctionnement :
 * - Un joueur crée un tournoi et obtient un code (5 caractères) à partager.
 * - Les autres joueurs le rejoignent (8 maximum). Le créateur (l'hôte) le lance.
 * - Le tableau est tiré au sort : 2 joueurs = finale, 3-4 = demi-finales,
 *   5-8 = quarts de finale. Quand le nombre de joueurs n'est pas une puissance
 *   de 2, certains joueurs sont qualifiés d'office pour le tour suivant.
 * - Chaque match est une manche de morpion. En cas de match nul, on rejoue
 *   immédiatement en inversant X et O (il faut toujours un vainqueur).
 * - Un joueur déconnecté a 30 s pour revenir, sinon il perd par forfait.
 *
 * Le serveur est l'arbitre : il valide chaque coup, puis envoie à tous les
 * joueurs de la salle un « instantané » complet du tournoi (événement
 * 'tournament_state'), que le navigateur n'a plus qu'à afficher.
 *
 * Codage du plateau : 0 = vide, 1 = X, 2 = O (comme dans server.js).
 * ================================================================
 */

'use strict';

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I pour éviter les confusions
const INACTIVE_MS = 60 * 60 * 1000;                    // un tournoi inactif 1 h est supprimé
const FINISHED_MS = 15 * 60 * 1000;                    // un tournoi terminé est gardé 15 min (le temps de voir le résultat)

/**
 * Crée le module tournoi.
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io - serveur Socket.IO
 * @param {Function} deps.checkWinner - fonction de victoire de server.js
 * @param {number} [deps.graceMs=30000] - délai avant forfait d'un joueur déconnecté
 * @param {number} [deps.winDelayMs=2500] - pause d'affichage après une victoire
 * @param {number} [deps.drawDelayMs=1500] - pause d'affichage après un match nul
 */
module.exports = function createTournamentModule({
    io,
    checkWinner,
    graceMs = 30000,
    winDelayMs = 2500,
    drawDelayMs = 1500
}) {
    // code -> tournoi
    const tournaments = {};
    // socket.id -> { code, pub } (qui est connecté à quel tournoi)
    const socketIndex = new Map();
    // minuteurs (fin de match, délai de grâce...) pour pouvoir les annuler
    const timers = new Map();

    // ------------------------------------------------------------
    // Structure d'un tournoi :
    // {
    //   code, status: 'lobby' | 'running' | 'finished',
    //   host: 'p1',                      // identifiant public de l'hôte
    //   players: [{ pub, token, name, socketId, connected, gone }],
    //   seq: 1,                          // compteur pour fabriquer les 'pub'
    //   rounds: [[match, ...], ...],     // tableau (round 0 = premier tour)
    //   champion: null,
    //   lastActivity: timestamp
    // }
    //
    // Structure d'un match :
    // {
    //   id, round, index, p1, p2,        // p1/p2 = 'pub' des joueurs (ou null)
    //   status: 'pending' | 'playing' | 'draw' | 'over' | 'done',
    //   bye, winner, board, turn,        // turn = 'X' | 'O'
    //   sym: { X: pub, O: pub },         // qui joue quel symbole
    //   combo, replays, forfeit
    // }
    //
    // 'token' = identifiant secret du navigateur (jamais envoyé aux autres),
    // 'pub'   = identifiant public affiché dans l'instantané.
    // ------------------------------------------------------------

    // ------------------------------------------------------------
    // OUTILS
    // ------------------------------------------------------------

    const roomName = (t) => `tournament:${t.code}`;

    function generateCode() {
        let code;
        do {
            code = Array.from({ length: 5 }, () =>
                CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
        } while (tournaments[code]);
        return code;
    }

    function shuffle(list) {
        const a = list.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    /** Pseudo : nettoyé, 20 caractères max, rendu unique dans le tournoi. */
    function cleanName(raw, t) {
        let base = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Joueur';
        const taken = new Set(t.players.map(p => p.name.toLowerCase()));
        let name = base;
        for (let n = 2; taken.has(name.toLowerCase()); n++) {
            name = `${base.slice(0, 16)} (${n})`;
        }
        return name;
    }

    /** Jeton secret du navigateur : 8 à 64 caractères simples, sinon null. */
    function cleanToken(raw) {
        const token = String(raw || '');
        return /^[A-Za-z0-9_-]{8,64}$/.test(token) ? token : null;
    }

    const getPlayer = (t, pub) => t.players.find(p => p.pub === pub) || null;
    const nameOf = (t, pub) => (getPlayer(t, pub) ? getPlayer(t, pub).name : '?');
    const allMatches = (t) => t.rounds.reduce((all, r) => all.concat(r), []);

    function roundNames(roundCount) {
        const fromEnd = ['Finale', 'Demi-finales', 'Quarts de finale'];
        return Array.from({ length: roundCount }, (_, r) => fromEnd[roundCount - 1 - r]);
    }

    function setTimer(key, ms, fn) {
        clearTimer(key);
        const handle = setTimeout(() => { timers.delete(key); fn(); }, ms);
        timers.set(key, handle);
    }

    function clearTimer(key) {
        if (timers.has(key)) {
            clearTimeout(timers.get(key));
            timers.delete(key);
        }
    }

    function clearTournamentTimers(t) {
        for (const key of Array.from(timers.keys())) {
            if (key.startsWith(`${t.code}:`)) clearTimer(key);
        }
    }

    function deleteTournament(t) {
        clearTournamentTimers(t);
        for (const p of t.players) {
            if (p.socketId) socketIndex.delete(p.socketId);
        }
        io.in(roomName(t)).socketsLeave(roomName(t));
        delete tournaments[t.code];
    }

    /** Instantané public du tournoi (ne contient aucun jeton secret). */
    function snapshot(t) {
        const eliminated = new Set();
        for (const m of allMatches(t)) {
            if ((m.status === 'over' || m.status === 'done') && m.winner) {
                if (m.p1 && m.p1 !== m.winner) eliminated.add(m.p1);
                if (m.p2 && m.p2 !== m.winner) eliminated.add(m.p2);
            }
        }
        return {
            code: t.code,
            status: t.status,
            host: t.host,
            maxPlayers: MAX_PLAYERS,
            minPlayers: MIN_PLAYERS,
            champion: t.champion,
            roundNames: roundNames(t.rounds.length),
            players: t.players.map(p => ({
                pub: p.pub,
                name: p.name,
                connected: p.connected,
                gone: p.gone,
                eliminated: eliminated.has(p.pub)
            })),
            rounds: t.rounds.map(round => round.map(m => ({
                id: m.id,
                p1: m.p1,
                p2: m.p2,
                status: m.status,
                bye: m.bye,
                winner: m.winner,
                board: m.board,
                turn: m.turn,
                sym: m.sym,
                combo: m.combo,
                replays: m.replays,
                forfeit: m.forfeit
            })))
        };
    }

    function broadcast(t) {
        t.lastActivity = Date.now();
        io.to(roomName(t)).emit('tournament_state', snapshot(t));
    }

    function notice(t, message) {
        io.to(roomName(t)).emit('tournament_notice', { message });
    }

    // ------------------------------------------------------------
    // TABLEAU ET MATCHS
    // ------------------------------------------------------------

    function newMatch(round, index, p1 = null, p2 = null) {
        return {
            id: `r${round}m${index}`,
            round, index, p1, p2,
            status: 'pending',
            bye: false,
            winner: null,
            board: [0, 0, 0, 0, 0, 0, 0, 0, 0],
            turn: 'X',
            sym: null,
            combo: null,
            replays: 0,
            forfeit: false
        };
    }

    /**
     * Construit le tableau : joueurs mélangés, puissance de 2 supérieure
     * (2, 4 ou 8 places). Les places vides deviennent des « qualifiés d'office »,
     * répartis sur des matchs différents.
     */
    function buildBracket(t) {
        const order = shuffle(t.players.map(p => p.pub));
        let size = 2;
        while (size < order.length) size *= 2;
        const roundCount = Math.log2(size);

        t.rounds = [];
        for (let r = 0; r < roundCount; r++) {
            const matchCount = size / Math.pow(2, r + 1);
            t.rounds.push(Array.from({ length: matchCount }, (_, i) => newMatch(r, i)));
        }

        const half = size / 2;
        t.rounds[0].forEach((m, i) => {
            m.p1 = order[i];
            m.p2 = order[half + i] || null;
            if (!m.p2) {
                m.bye = true;
                m.winner = m.p1;
                m.status = 'done';
            }
        });
    }

    /** Lance tous les matchs du premier tour, puis fait avancer les qualifiés d'office. */
    function launchBracket(t) {
        for (const m of t.rounds[0]) {
            if (m.bye) advanceWinner(t, m);
        }
        for (const m of t.rounds[0]) {
            maybeStart(t, m);
        }
    }

    /** Fait monter le vainqueur d'un match au tour suivant (ou le sacre champion). */
    function advanceWinner(t, m) {
        if (m.round === t.rounds.length - 1) {
            t.champion = m.winner;
            t.status = 'finished';
            notice(t, `🏆 ${nameOf(t, m.winner)} remporte le tournoi !`);
            return;
        }
        const next = t.rounds[m.round + 1][Math.floor(m.index / 2)];
        next[m.index % 2 === 0 ? 'p1' : 'p2'] = m.winner;
        maybeStart(t, next);
    }

    /** Démarre un match si ses deux joueurs sont connus (victoire par forfait si l'un est parti). */
    function maybeStart(t, m) {
        if (m.status !== 'pending' || !m.p1 || !m.p2) return;

        const gone1 = getPlayer(t, m.p1).gone;
        const gone2 = getPlayer(t, m.p2).gone;
        if (gone1 || gone2) {
            m.winner = gone1 && !gone2 ? m.p2 : m.p1;
            m.forfeit = true;
            m.status = 'done';
            advanceWinner(t, m);
            return;
        }

        m.status = 'playing';
        m.sym = { X: m.p1, O: m.p2 };
        m.turn = 'X';
        m.board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        notice(t, `⚔️ ${nameOf(t, m.p1)} contre ${nameOf(t, m.p2)}`);
    }

    /** Match terminé (après la pause d'affichage) : on fait avancer le vainqueur. */
    function completeMatch(t, m) {
        if (!tournaments[t.code] || m.status !== 'over') return;
        m.status = 'done';
        advanceWinner(t, m);
        broadcast(t);
    }

    /** Match nul : après une courte pause, on rejoue en inversant X et O. */
    function replayMatch(t, m) {
        if (!tournaments[t.code] || m.status !== 'draw') return;
        const { X, O } = m.sym;
        m.sym = { X: O, O: X };
        m.board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        m.turn = 'X';
        m.combo = null;
        m.replays++;
        m.status = 'playing';
        notice(t, `🔄 On rejoue : ${nameOf(t, m.sym.X)} commence`);
        broadcast(t);
    }

    /** Match en cours (ou en attente de rejeu) d'un joueur. */
    function activeMatchOf(t, pub) {
        return allMatches(t).find(m =>
            (m.status === 'playing' || m.status === 'draw' || m.status === 'over') &&
            (m.p1 === pub || m.p2 === pub)) || null;
    }

    /** Un joueur quitte la compétition : il perd son match en cours par forfait. */
    function forfeitPlayer(t, pub) {
        const player = getPlayer(t, pub);
        if (!player || player.gone) return;
        player.gone = true;
        player.connected = false;

        const m = allMatches(t).find(x =>
            (x.status === 'playing' || x.status === 'draw') && (x.p1 === pub || x.p2 === pub));
        if (m) {
            m.winner = m.p1 === pub ? m.p2 : m.p1;
            m.status = 'over';
            m.forfeit = true;
            m.combo = null;
            setTimer(`${t.code}:${m.id}`, 1500, () => completeMatch(t, m));
        }

        notice(t, `🚪 ${player.name} a quitté le tournoi`);
        if (t.players.every(p => p.gone)) {
            deleteTournament(t);
        }
    }

    /** Retire un joueur du salon d'attente (le tournoi n'a pas encore commencé). */
    function removeFromLobby(t, pub) {
        t.players = t.players.filter(p => p.pub !== pub);
        clearTimer(`${t.code}:grace:${pub}`);
        if (t.players.length === 0) {
            deleteTournament(t);
            return false;
        }
        if (t.host === pub) t.host = t.players[0].pub;
        return true;
    }

    // ------------------------------------------------------------
    // ÉVÉNEMENTS SOCKET.IO
    // ------------------------------------------------------------

    function register(socket) {
        /** Rattache le socket au tournoi (salle Socket.IO + index). */
        function attach(t, player) {
            player.socketId = socket.id;
            player.connected = true;
            socketIndex.set(socket.id, { code: t.code, pub: player.pub });
            socket.join(roomName(t));
            clearTimer(`${t.code}:grace:${player.pub}`);
            socket.emit('tournament_joined', { code: t.code, you: player.pub });
        }

        /** Détache le socket de son tournoi actuel (quitter volontairement). */
        function detach() {
            const ref = socketIndex.get(socket.id);
            if (!ref) return;
            const t = tournaments[ref.code];
            socketIndex.delete(socket.id);
            socket.leave(`tournament:${ref.code}`);
            if (!t) return;

            const player = getPlayer(t, ref.pub);
            if (!player) return;
            player.socketId = null;

            if (t.status === 'lobby') {
                if (removeFromLobby(t, ref.pub)) {
                    notice(t, `🚪 ${player.name} a quitté le salon`);
                    broadcast(t);
                }
            } else if (t.status === 'running') {
                forfeitPlayer(t, ref.pub);
                if (tournaments[t.code]) broadcast(t);
            } else {
                player.connected = false;
                broadcast(t);
            }
        }

        // --- Créer un tournoi ---
        socket.on('tournament_create', (data) => {
            data = data || {};
            const token = cleanToken(data.player_id);
            if (!token) return socket.emit('tournament_error', { message: 'Identifiant de joueur invalide' });

            detach();
            const t = {
                code: generateCode(),
                status: 'lobby',
                host: null,
                players: [],
                seq: 0,
                rounds: [],
                champion: null,
                lastActivity: Date.now()
            };
            const player = {
                pub: `p${++t.seq}`,
                token,
                name: cleanName(data.player_name, t),
                socketId: null,
                connected: true,
                gone: false
            };
            t.players.push(player);
            t.host = player.pub;
            tournaments[t.code] = t;

            attach(t, player);
            broadcast(t);
        });

        // --- Rejoindre (ou revenir dans) un tournoi ---
        socket.on('tournament_join', (data) => {
            data = data || {};
            const token = cleanToken(data.player_id);
            const code = String(data.code || '').trim().toUpperCase();
            if (!token) return socket.emit('tournament_error', { message: 'Identifiant de joueur invalide' });

            const t = tournaments[code];
            if (!t) {
                return socket.emit('tournament_error', { message: 'Tournoi introuvable', fatal: true });
            }

            // Retour d'un joueur déjà inscrit (reconnexion) : on met à jour son socket
            const existing = t.players.find(p => p.token === token);
            if (existing) {
                const previous = socketIndex.get(socket.id);
                if (!previous || previous.code !== t.code) detach();
                if (existing.socketId && existing.socketId !== socket.id) {
                    socketIndex.delete(existing.socketId);
                }
                attach(t, existing);
                broadcast(t);
                return;
            }

            if (t.status !== 'lobby') {
                return socket.emit('tournament_error', { message: 'Ce tournoi a déjà commencé' });
            }
            if (t.players.length >= MAX_PLAYERS) {
                return socket.emit('tournament_error', { message: `Tournoi complet (${MAX_PLAYERS} joueurs maximum)` });
            }

            detach();
            const player = {
                pub: `p${++t.seq}`,
                token,
                name: cleanName(data.player_name, t),
                socketId: null,
                connected: true,
                gone: false
            };
            t.players.push(player);
            attach(t, player);
            notice(t, `👋 ${player.name} a rejoint le tournoi`);
            broadcast(t);
        });

        // --- Lancer le tournoi (hôte uniquement) ---
        socket.on('tournament_start', () => {
            const ref = socketIndex.get(socket.id);
            const t = ref && tournaments[ref.code];
            if (!t) return;
            if (t.host !== ref.pub) {
                return socket.emit('tournament_error', { message: "Seul l'hôte peut lancer le tournoi" });
            }
            if (t.status !== 'lobby') return;
            if (t.players.length < MIN_PLAYERS) {
                return socket.emit('tournament_error', { message: `Il faut au moins ${MIN_PLAYERS} joueurs` });
            }

            t.status = 'running';
            buildBracket(t);
            notice(t, '🏁 Le tournoi commence !');
            launchBracket(t);
            broadcast(t);
        });

        // --- Jouer un coup ---
        socket.on('tournament_move', (data) => {
            data = data || {};
            const ref = socketIndex.get(socket.id);
            const t = ref && tournaments[ref.code];
            if (!t || t.status !== 'running') return;

            const m = activeMatchOf(t, ref.pub);
            if (!m || m.status !== 'playing') return;

            const index = data.index;
            if (!Number.isInteger(index) || index < 0 || index > 8) {
                return socket.emit('tournament_error', { message: 'Case invalide' });
            }
            const mySymbol = m.sym.X === ref.pub ? 'X' : 'O';
            if (m.turn !== mySymbol) {
                return socket.emit('tournament_error', { message: "Ce n'est pas votre tour" });
            }
            if (m.board[index] !== 0) {
                return socket.emit('tournament_error', { message: 'Cette case est déjà prise' });
            }

            m.board[index] = mySymbol === 'X' ? 1 : 2;
            const result = checkWinner(m.board);

            if (!result) {
                m.turn = mySymbol === 'X' ? 'O' : 'X';
            } else if (result.winner === 'draw') {
                m.status = 'draw';
                m.combo = null;
                notice(t, `🤝 Match nul entre ${nameOf(t, m.p1)} et ${nameOf(t, m.p2)} : on rejoue`);
                setTimer(`${t.code}:${m.id}`, drawDelayMs, () => replayMatch(t, m));
            } else {
                m.status = 'over';
                m.winner = m.sym[result.winner];
                m.combo = result.combo;
                notice(t, `🏅 ${nameOf(t, m.winner)} gagne son match`);
                setTimer(`${t.code}:${m.id}`, winDelayMs, () => completeMatch(t, m));
            }
            broadcast(t);
        });

        // --- Quitter le tournoi ---
        socket.on('tournament_leave', () => {
            detach();
            socket.emit('tournament_left');
        });

        // --- Déconnexion : délai de grâce avant forfait ---
        socket.on('disconnect', () => {
            const ref = socketIndex.get(socket.id);
            if (!ref) return;
            socketIndex.delete(socket.id);

            const t = tournaments[ref.code];
            const player = t && getPlayer(t, ref.pub);
            if (!player || player.socketId !== socket.id) return;

            player.connected = false;
            player.socketId = null;
            if (t.status === 'finished') return broadcast(t);

            notice(t, `⚠️ ${player.name} est déconnecté (${Math.round(graceMs / 1000)} s pour revenir)`);
            broadcast(t);

            setTimer(`${t.code}:grace:${player.pub}`, graceMs, () => {
                if (!tournaments[t.code] || player.connected) return;
                if (t.status === 'lobby') {
                    if (removeFromLobby(t, player.pub)) broadcast(t);
                } else if (t.status === 'running') {
                    forfeitPlayer(t, player.pub);
                    if (tournaments[t.code]) broadcast(t);
                }
            });
        });
    }

    // ------------------------------------------------------------
    // NETTOYAGE DES TOURNOIS ABANDONNÉS
    // ------------------------------------------------------------

    const cleaner = setInterval(() => {
        const now = Date.now();
        for (const t of Object.values(tournaments)) {
            const limit = t.status === 'finished' ? FINISHED_MS : INACTIVE_MS;
            if (now - t.lastActivity > limit) {
                console.log(`🧹 Tournoi inactif supprimé : ${t.code}`);
                deleteTournament(t);
            }
        }
    }, 10 * 60 * 1000);
    cleaner.unref(); // ne bloque pas l'arrêt du processus

    return { register, tournaments };
};