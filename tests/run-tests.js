/* node tests/run-tests.js でルール・AI・解説の簡易テストを実行 */
'use strict';
const assert = require('assert');
const O = require('../js/game.js');
const AI = require('../js/ai.js');
const C = require('../js/explain.js');
const P = require('../js/prompts.js');
const CL = require('../js/claude.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

test('初期配置で黒の合法手は d3, c4, f5, e6', () => {
  const moves = O.getLegalMoves(O.createBoard(), O.BLACK).map(O.toNotation).sort();
  assert.deepStrictEqual(moves, ['c4', 'd3', 'e6', 'f5']);
});

test('f5 に打つと e5 が返る', () => {
  const res = O.applyMove(O.createBoard(), O.fromNotation('f5'), O.BLACK);
  assert.deepStrictEqual(res.flips.map(O.toNotation), ['e5']);
  assert.deepStrictEqual(O.countDiscs(res.board), { black: 4, white: 1, empty: 59 });
});

test('非合法手は null', () => {
  assert.strictEqual(O.applyMove(O.createBoard(), 0, O.BLACK), null);
});

test('隅の石は確定石', () => {
  const b = new Array(64).fill(0);
  b[0] = O.BLACK; b[1] = O.BLACK; b[9] = O.WHITE;
  const s = O.countStable(b);
  assert.strictEqual(s.black, 2);
  assert.strictEqual(s.white, 0);
});

test('AIは取れる隅を取る', () => {
  // a1 が空き、b2 が白、c3 が黒 → 黒は a1 に打てる
  const b = O.createBoard();
  b[9] = O.WHITE; b[18] = O.BLACK;
  const r = AI.search(b, O.BLACK, { depth: 2, exact: 0 });
  assert.strictEqual(O.toNotation(r.best), 'a1');
});

test('AI同士で最後まで対局できる', () => {
  let b = O.createBoard(), p = O.BLACK, moves = 0;
  while (!O.isGameOver(b)) {
    if (!O.getLegalMoves(b, p).length) { p = -p; continue; }
    const { move } = AI.chooseMove(b, p, 2);
    assert.ok(O.isLegal(b, move, p));
    b = O.applyMove(b, move, p).board; p = -p; moves++;
  }
  assert.ok(moves > 0 && moves <= 60);
});

test('解説が生成される', () => {
  const b0 = O.createBoard();
  const a0 = AI.search(b0, O.BLACK, { depth: 3, exact: 0 });
  const b1 = O.applyMove(b0, a0.best, O.BLACK).board;
  const a1 = AI.search(b1, O.WHITE, { depth: 3, exact: 0 });
  const d = C.describe(b1, O.WHITE, a1, { player: O.BLACK, move: a0.best, boardBefore: b0, analysisBefore: a0 });
  assert.strictEqual(d.lastMove.quality.label, '最善手');
  assert.ok(d.advice.text.includes('白の番'));
  assert.ok(d.points.length > 0);
  assert.ok(d.evaluation.winRate > 0 && d.evaluation.winRate < 1);
});

test('内蔵の実況（言語モデルなし）が文章を作る', () => {
  const b0 = O.createBoard();
  const a0 = AI.search(b0, O.BLACK, { depth: 3, exact: 0 });
  const b1 = O.applyMove(b0, a0.best, O.BLACK).board;
  const a1 = AI.search(b1, O.WHITE, { depth: 3, exact: 0 });
  const t = C.narrate(b1, O.WHITE, a1, { player: O.BLACK, move: a0.best, boardBefore: b0, analysisBefore: a0 }, null);
  assert.ok(t.includes(O.toNotation(a0.best)));
  assert.ok(t.includes('最善'));
  assert.ok(t.includes('次の白は'));
  const end = C.narrate(new Array(64).fill(O.BLACK), 0, null, null, null);
  assert.ok(end.includes('64対0で黒の勝ち'));
});

test('終局の解説', () => {
  const b = new Array(64).fill(O.BLACK);
  const d = C.describe(b, 0, null, null);
  assert.ok(d.evaluation.text.includes('黒の勝ち'));
});

test('Claude の返答から着手を読み取る', () => {
  const b = O.createBoard();
  assert.strictEqual(CL.parseMove('いい手です。\n着手: f5', b, O.BLACK), O.fromNotation('f5'));
  assert.strictEqual(CL.parseMove('着手：**Ｄ３**', b, O.BLACK), O.fromNotation('d3'));
  // 最後の「着手」を採用する
  assert.strictEqual(CL.parseMove('着手: a1 は打てないので…\n着手: c4', b, O.BLACK), O.fromNotation('c4'));
  // 非合法手・記載なしは null
  assert.strictEqual(CL.parseMove('着手: a1', b, O.BLACK), null);
  assert.strictEqual(CL.parseMove('d3 がいいでしょう', b, O.BLACK), null);
});

test('Claude 用のプロンプトに盤面と合法手が入る', () => {
  const b = O.createBoard();
  const a = AI.search(b, O.BLACK, { depth: 2, exact: 0 });
  const p = CL.movePrompt({ board: b, player: O.BLACK, analysis: a, last: null });
  assert.ok(p.includes('4 . . . O X . . .'));
  assert.ok(p.includes('合法手: d3, c4, f5, e6'));
  assert.ok(p.includes('着手: d3'));
  const b1 = O.applyMove(b, 19, O.BLACK).board;
  const a1 = AI.search(b1, O.WHITE, { depth: 2, exact: 0 });
  const c = CL.commentaryPrompt({ board: b1, toMove: O.WHITE, analysis: a1, last: { player: O.BLACK, move: 19, boardBefore: b, analysisBefore: a } });
  assert.ok(c.includes('黒(X) が d3 に打った'));
  assert.ok(c.includes('事実メモ'));
  assert.ok(c.includes('【最善手】'));
});

test('実況用システムプロンプトに知識メモとお手本が入る', () => {
  const sys = CL.commentarySystem();
  assert.ok(sys.includes('# オセロの知識'));
  assert.ok(sys.includes('## 例' + P.EXAMPLES.length));
  assert.ok(sys.includes(P.EXAMPLES[0].output));
  // 小さなモデルの読み込める長さを圧迫しないこと
  assert.ok(sys.length < 4000);
});

const AZ = require('../js/alphazero.js');
const azData = require('../models/alphazero.js');

test('AlphaZero（学習済み）の推論が正しい形の出力を返す', () => {
  const net = new AZ.Network(azData);
  const r = net.evaluate(O.createBoard(), O.BLACK);
  assert.strictEqual(r.logits.length, 65);
  assert.ok(r.value >= -1 && r.value <= 1);
});

(async () => {
  const net = new AZ.Network(azData);
  const s = await new AZ.MCTS(net).search(O.createBoard(), O.BLACK, { sims: 50 });
  test('AlphaZero の探索が初期局面で合法手を選ぶ', () => {
    assert.ok(O.isLegal(O.createBoard(), s.move, O.BLACK));
    assert.strictEqual(s.sims, 50);
    assert.ok(s.winRate > 0.2 && s.winRate < 0.8, '初期局面はほぼ互角のはず: ' + s.winRate);
  });
  console.log(`\n${passed} passed`);
})();
