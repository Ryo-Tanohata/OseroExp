/*
 * ab_server.js — 評価用に、アプリと同じ αβ 探索AI（js/ai.js）を標準入出力で動かす
 * 入力（1行1JSON）: {"board":[64個], "player":1|-1, "level":1..4}
 * 出力（1行1JSON）: {"move": 0..63}
 */
'use strict';
const readline = require('readline');
const O = require('../js/game.js');
const AI = require('../js/ai.js');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const { board, player, level } = JSON.parse(line);
  const { move } = AI.chooseMove(board, player, level);
  process.stdout.write(JSON.stringify({ move }) + '\n');
});
