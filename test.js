/**
 * Test unitaire pour la logique de victoire du Morpion.
 * Utilise le runner de test natif de Node.js (Node 18+).
 */
const test = require('node:test');
const assert = require('node:assert');
const { checkWinner } = require('./server.js');

test('Logique de détection de victoire du Morpion', async (t) => {

    await t.test('devrait retourner le bon gagnant et la bonne combinaison pour X', () => {
        // Ligne du haut gagnante pour X (1)
        const board = [
            1, 1, 1,
            2, 0, 2,
            0, 0, 0
        ];
        const result = checkWinner(board);
        assert.deepStrictEqual(result, { winner: 'X', combo: [0, 1, 2] });
    });

    await t.test('devrait retourner le bon gagnant et la bonne combinaison pour O', () => {
        // Diagonale descendante gagnante pour O (2)
        const board = [
            2, 1, 1,
            0, 2, 0,
            0, 1, 2
        ];
        const result = checkWinner(board);
        assert.deepStrictEqual(result, { winner: 'O', combo: [0, 4, 8] });
    });

    await t.test('devrait retourner null s\'il n\'y a pas encore de gagnant', () => {
        const board = [
            1, 2, 1,
            0, 2, 0,
            0, 1, 0
        ];
        const result = checkWinner(board);
        assert.strictEqual(result, null);
    });

    await t.test('devrait détecter un match nul complet', () => {
        const board = [
            1, 2, 1,
            1, 2, 2,
            2, 1, 1
        ];
        const result = checkWinner(board);
        assert.deepStrictEqual(result, { winner: 'draw', combo: null });
    });

});
