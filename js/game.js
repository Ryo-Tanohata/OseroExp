/*
 * game.js — オセロのルール（盤面・合法手・石を返す処理）
 *
 * 盤面は長さ64の配列で表現する。index = row * 8 + col
 *   0 : 空き
 *   1 : 黒 (BLACK)
 *  -1 : 白 (WHITE)
 * 手番を -1 倍すれば相手になるので、探索(negamax)が書きやすい。
 */
(function (global) {
  'use strict';

  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = -1;
  const SIZE = 8;
  const DIRS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];

  function createBoard() {
    const b = new Array(64).fill(EMPTY);
    b[27] = WHITE; // d4
    b[28] = BLACK; // e4
    b[35] = BLACK; // d5
    b[36] = WHITE; // e5
    return b;
  }

  function onBoard(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  /** idx に player が打ったときに返る石の index 一覧 */
  function getFlips(board, idx, player) {
    if (board[idx] !== EMPTY) return [];
    const r0 = (idx / SIZE) | 0;
    const c0 = idx % SIZE;
    const flips = [];
    for (const [dr, dc] of DIRS) {
      let r = r0 + dr;
      let c = c0 + dc;
      const line = [];
      while (onBoard(r, c) && board[r * SIZE + c] === -player) {
        line.push(r * SIZE + c);
        r += dr;
        c += dc;
      }
      if (line.length > 0 && onBoard(r, c) && board[r * SIZE + c] === player) {
        for (const i of line) flips.push(i);
      }
    }
    return flips;
  }

  function isLegal(board, idx, player) {
    return getFlips(board, idx, player).length > 0;
  }

  function getLegalMoves(board, player) {
    const moves = [];
    for (let i = 0; i < 64; i++) {
      if (board[i] === EMPTY && isLegal(board, i, player)) moves.push(i);
    }
    return moves;
  }

  /** 新しい盤面を返す（元の盤面は変更しない） */
  function applyMove(board, idx, player) {
    const flips = getFlips(board, idx, player);
    if (flips.length === 0) return null;
    const next = board.slice();
    next[idx] = player;
    for (const i of flips) next[i] = player;
    return { board: next, flips };
  }

  function countDiscs(board) {
    let black = 0;
    let white = 0;
    for (let i = 0; i < 64; i++) {
      if (board[i] === BLACK) black++;
      else if (board[i] === WHITE) white++;
    }
    return { black, white, empty: 64 - black - white };
  }

  function isGameOver(board) {
    return getLegalMoves(board, BLACK).length === 0 &&
      getLegalMoves(board, WHITE).length === 0;
  }

  /** index → "d3" のような棋譜表記 */
  function toNotation(idx) {
    const r = (idx / SIZE) | 0;
    const c = idx % SIZE;
    return 'abcdefgh'[c] + (r + 1);
  }

  function fromNotation(s) {
    const c = 'abcdefgh'.indexOf(s[0]);
    const r = parseInt(s.slice(1), 10) - 1;
    return r * SIZE + c;
  }

  function colorName(player) {
    return player === BLACK ? '黒' : '白';
  }

  /*
   * 確定石（二度と返されない石）の数を数える。
   * 縦・横・斜め2本の4方向それぞれについて
   *   「片側が盤外 or 同色の確定石」 または 「その列が全て埋まっている」
   * を満たす石を確定石とみなし、変化がなくなるまで繰り返す（保守的な近似）。
   */
  const AXES = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function lineFull(board, r0, c0, dr, dc) {
    let r = r0;
    let c = c0;
    while (onBoard(r, c)) {
      if (board[r * SIZE + c] === EMPTY) return false;
      r += dr; c += dc;
    }
    r = r0; c = c0;
    while (onBoard(r, c)) {
      if (board[r * SIZE + c] === EMPTY) return false;
      r -= dr; c -= dc;
    }
    return true;
  }

  function getStableMap(board) {
    const stable = new Array(64).fill(false);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < 64; i++) {
        const p = board[i];
        if (p === EMPTY || stable[i]) continue;
        const r = (i / SIZE) | 0;
        const c = i % SIZE;
        let ok = true;
        for (const [dr, dc] of AXES) {
          const r1 = r + dr, c1 = c + dc, r2 = r - dr, c2 = c - dc;
          const side1 = !onBoard(r1, c1) || (board[r1 * SIZE + c1] === p && stable[r1 * SIZE + c1]);
          const side2 = !onBoard(r2, c2) || (board[r2 * SIZE + c2] === p && stable[r2 * SIZE + c2]);
          if (!(side1 || side2 || lineFull(board, r, c, dr, dc))) { ok = false; break; }
        }
        if (ok) { stable[i] = true; changed = true; }
      }
    }
    return stable;
  }

  function countStable(board) {
    const map = getStableMap(board);
    let black = 0;
    let white = 0;
    for (let i = 0; i < 64; i++) {
      if (!map[i]) continue;
      if (board[i] === BLACK) black++; else white++;
    }
    return { black, white, map };
  }

  /** 空きマスに隣接している石（壁・フロンティア）の数 */
  function countFrontier(board) {
    let black = 0;
    let white = 0;
    for (let i = 0; i < 64; i++) {
      if (board[i] === EMPTY) continue;
      if (touchesEmpty(board, i)) {
        if (board[i] === BLACK) black++; else white++;
      }
    }
    return { black, white };
  }

  function touchesEmpty(board, idx) {
    const r = (idx / SIZE) | 0;
    const c = idx % SIZE;
    for (const [dr, dc] of DIRS) {
      const rr = r + dr, cc = c + dc;
      if (onBoard(rr, cc) && board[rr * SIZE + cc] === EMPTY) return true;
    }
    return false;
  }

  // 盤面上の特別なマス
  const CORNERS = [0, 7, 56, 63];
  // X打ち: 隅の斜め隣
  const X_SQUARES = { 9: 0, 14: 7, 49: 56, 54: 63 };
  // C打ち: 隅の辺上の隣
  const C_SQUARES = { 1: 0, 8: 0, 6: 7, 15: 7, 48: 56, 57: 56, 55: 63, 62: 63 };

  function squareType(idx) {
    if (CORNERS.includes(idx)) return 'corner';
    if (idx in X_SQUARES) return 'x';
    if (idx in C_SQUARES) return 'c';
    const r = (idx / SIZE) | 0;
    const c = idx % SIZE;
    if (r === 0 || r === 7 || c === 0 || c === 7) return 'edge';
    return 'inner';
  }

  const Othello = {
    EMPTY, BLACK, WHITE, SIZE, DIRS, CORNERS, X_SQUARES, C_SQUARES,
    createBoard, getFlips, isLegal, getLegalMoves, applyMove, countDiscs,
    isGameOver, toNotation, fromNotation, colorName, getStableMap, countStable,
    countFrontier, touchesEmpty, squareType,
  };

  global.Othello = Othello;
  if (typeof module !== 'undefined' && module.exports) module.exports = Othello;
})(typeof window !== 'undefined' ? window : globalThis);
