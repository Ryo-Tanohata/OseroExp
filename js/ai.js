/*
 * ai.js — オセロAI
 *
 * ・評価関数: マスの重み(位置評価) + 着手可能数(機動力) + 隅 + 終盤の石数
 * ・探索    : αβ法 (negamax形式)
 * ・終盤    : 残りマスが少なくなったら最後まで読み切る（完全読み）
 *
 * 評価値は「手番側から見た値」。読み切った場合は
 *   勝ち: WIN_SCORE + 石差*100 / 負け: -WIN_SCORE + 石差*100
 * のように非常に大きな値になる。
 */
(function (global) {
  'use strict';

  const O = global.Othello || (typeof require !== 'undefined' ? require('./game.js') : null);
  const { EMPTY, CORNERS } = O;

  const WIN_SCORE = 100000;
  const INF = 1e9;

  // マスの重み（隅は高く、隅の隣 X/C は低い）
  const WEIGHTS = [
    100, -25, 10, 5, 5, 10, -25, 100,
    -25, -50, -2, -2, -2, -2, -50, -25,
    10, -2, 1, 0, 0, 1, -2, 10,
    5, -2, 0, 0, 0, 0, -2, 5,
    5, -2, 0, 0, 0, 0, -2, 5,
    10, -2, 1, 0, 0, 1, -2, 10,
    -25, -50, -2, -2, -2, -2, -50, -25,
    100, -25, 10, 5, 5, 10, -25, 100,
  ];

  // 隅ごとの「隣接マス」（隅が埋まっていれば危険ではなくなる）
  const CORNER_NEIGHBORS = {
    0: [1, 8, 9],
    7: [6, 15, 14],
    56: [57, 48, 49],
    63: [62, 55, 54],
  };

  // 強さの設定
  const LEVELS = {
    1: { name: '弱い', depth: 1, exact: 0, noise: 120 },
    2: { name: '普通', depth: 2, exact: 8, noise: 20 },
    3: { name: '強い', depth: 4, exact: 10, noise: 0 },
    4: { name: '最強', depth: 6, exact: 12, noise: 0 },
  };

  function emptyCount(board) {
    let n = 0;
    for (let i = 0; i < 64; i++) if (board[i] === EMPTY) n++;
    return n;
  }

  function discDiff(board, player) {
    let d = 0;
    for (let i = 0; i < 64; i++) d += board[i];
    return d * player;
  }

  function terminalScore(board, player) {
    const diff = discDiff(board, player);
    if (diff > 0) return WIN_SCORE + diff * 100;
    if (diff < 0) return -WIN_SCORE + diff * 100;
    return 0;
  }

  /** 位置評価（隅が埋まった後の X/C マスは減点しない） */
  function positionalScore(board, player) {
    let s = 0;
    for (let i = 0; i < 64; i++) {
      if (board[i] !== EMPTY) s += WEIGHTS[i] * board[i];
    }
    for (const corner of CORNERS) {
      if (board[corner] === EMPTY) continue;
      for (const n of CORNER_NEIGHBORS[corner]) {
        if (board[n] !== EMPTY) s -= WEIGHTS[n] * board[n]; // 減点を打ち消す
      }
    }
    return s * player;
  }

  /**
   * 静的評価。myMoves を渡すと合法手の再計算を省略できる。
   * 戻り値は評価値と内訳。
   */
  function evaluateDetail(board, player, myMoves) {
    const empties = emptyCount(board);
    const my = myMoves !== undefined ? myMoves : O.getLegalMoves(board, player).length;
    const opp = O.getLegalMoves(board, -player).length;
    if (my === 0 && opp === 0) {
      const t = terminalScore(board, player);
      return { score: t, position: 0, mobility: 0, discs: 0, terminal: true };
    }
    const position = positionalScore(board, player);
    // 序盤～中盤は機動力を重視し、終盤になるほど石数を重視する
    const mobilityWeight = empties > 40 ? 10 : empties > 20 ? 8 : 5;
    const mobility = (my - opp) * mobilityWeight;
    const discWeight = empties > 20 ? 0 : empties > 10 ? 3 : 8;
    const discs = discDiff(board, player) * discWeight;
    return { score: position + mobility + discs, position, mobility, discs, terminal: false };
  }

  function evaluate(board, player, myMovesCount) {
    return evaluateDetail(board, player, myMovesCount).score;
  }

  /** 手の並べ替え（良さそうな手から読むと αβ の枝刈りが効く） */
  function orderMoves(moves) {
    return moves.slice().sort((a, b) => WEIGHTS[b] - WEIGHTS[a]);
  }

  function negamax(board, player, depth, alpha, beta, stats) {
    stats.nodes++;
    const moves = O.getLegalMoves(board, player);
    if (moves.length === 0) {
      if (O.getLegalMoves(board, -player).length === 0) {
        return terminalScore(board, player);
      }
      // パス（深さは減らさない）
      return -negamax(board, -player, depth, -beta, -alpha, stats);
    }
    if (depth <= 0) return evaluate(board, player, moves.length);

    let best = -INF;
    for (const m of orderMoves(moves)) {
      const next = O.applyMove(board, m, player).board;
      const v = -negamax(next, -player, depth - 1, -beta, -alpha, stats);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  /**
   * 探索して全ての候補手の評価値を返す。
   * @param {number[]} board
   * @param {number} player
   * @param {{depth:number, exact:number}} opts
   * @returns {{best:number|null, score:number, candidates:{move:number, score:number, flips:number}[], exact:boolean, depth:number, nodes:number, time:number}}
   */
  function search(board, player, opts) {
    const t0 = Date.now();
    const empties = emptyCount(board);
    const exact = opts.exact > 0 && empties <= opts.exact;
    const depth = exact ? empties : opts.depth;
    const stats = { nodes: 0 };
    const moves = O.getLegalMoves(board, player);
    const candidates = [];

    for (const m of orderMoves(moves)) {
      const res = O.applyMove(board, m, player);
      // 候補手の評価値を正確に比べたいので、ルートでは全手をフルウィンドウで読む
      const score = -negamax(res.board, -player, depth - 1, -INF, INF, stats);
      candidates.push({ move: m, score, flips: res.flips.length });
    }
    candidates.sort((a, b) => b.score - a.score);

    return {
      best: candidates.length ? candidates[0].move : null,
      score: candidates.length ? candidates[0].score : evaluate(board, player),
      candidates,
      exact,
      depth,
      nodes: stats.nodes,
      time: Date.now() - t0,
    };
  }

  /** 強さに応じて手を選ぶ（弱いレベルでは評価にノイズを加える） */
  function chooseMove(board, player, level) {
    const cfg = LEVELS[level] || LEVELS[3];
    const result = search(board, player, cfg);
    if (!result.candidates.length) return { move: null, result };
    let move = result.best;
    if (cfg.noise > 0 && !result.exact) {
      let bestNoisy = -INF;
      for (const c of result.candidates) {
        const noisy = c.score + (Math.random() * 2 - 1) * cfg.noise;
        if (noisy > bestNoisy) { bestNoisy = noisy; move = c.move; }
      }
    }
    return { move, result };
  }

  function isDecisive(score) {
    return Math.abs(score) >= WIN_SCORE / 2;
  }

  /** 読み切りスコアから石差を取り出す */
  function decisiveDiscDiff(score) {
    if (score === 0) return 0;
    return score > 0 ? (score - WIN_SCORE) / 100 : (score + WIN_SCORE) / 100;
  }

  const AI = {
    WEIGHTS, LEVELS, WIN_SCORE,
    evaluate, evaluateDetail, search, chooseMove, emptyCount,
    isDecisive, decisiveDiscDiff,
  };

  global.OthelloAI = AI;
  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
})(typeof window !== 'undefined' ? window : globalThis);
