/*
 * alphazero.js — 学習済み AlphaZero をブラウザで動かす（推論 + モンテカルロ木探索）
 *
 * 重み（models/*.json）は train/train.py が書き出したもの。
 * BatchNorm は畳み込みに畳み込み済みなので、ここでは Conv + ReLU と全結合だけを計算する。
 */
(function (global) {
  'use strict';

  const O = global.Othello || (typeof require !== 'undefined' ? require('./game.js') : null);
  const PASS = 64;

  // ---------------------------------------------------------------- 重みの読み込み
  function decodeF32(b64) {
    let bytes;
    if (typeof atob === 'function') {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  function layer(l) {
    return Object.assign({}, l, { w: decodeF32(l.w), b: decodeF32(l.b) });
  }

  class Network {
    constructor(json) {
      if (!/^othello-alphazero-v1/.test(json.format)) throw new Error('対応していない重みファイルです');
      this.meta = json.meta || {};
      this.C = json.channels;
      this.stem = layer(json.stem);
      this.res = json.res.map(r => ({ c1: layer(r.c1), c2: layer(r.c2) }));
      this.pConv = layer(json.policy.conv);
      this.pFc = layer(json.policy.fc);
      this.vConv = layer(json.value.conv);
      this.vFc1 = layer(json.value.fc1);
      this.vFc2 = layer(json.value.fc2);
      const C = this.C;
      this.bufA = new Float32Array(C * 64);
      this.bufB = new Float32Array(C * 64);
      this.bufC = new Float32Array(C * 64);
      this.evals = 0;
    }

    /**
     * 3x3 畳み込み（パディング1）。out = conv(inp) + b
     * 入力を「9方向にずらした盤面」の並び（im2col）に展開してから、
     * 64マス分の連続したループで積和するので速い。
     */
    conv3(l, inp, out) {
      const { w, b } = l;
      const Cin = l.in;
      const Cout = l.out;
      const K = Cin * 9;
      if (!this.cols || this.cols.length < K * 64) this.cols = new Float32Array(K * 64);
      const cols = this.cols;
      cols.fill(0, 0, K * 64);
      for (let i = 0; i < Cin; i++) {
        const ib = i * 64;
        for (let ky = 0; ky < 3; ky++) {
          const dy = ky - 1;
          const y0 = dy < 0 ? 1 : 0;
          const y1 = dy > 0 ? 7 : 8;
          for (let kx = 0; kx < 3; kx++) {
            const dx = kx - 1;
            const x0 = dx < 0 ? 1 : 0;
            const x1 = dx > 0 ? 7 : 8;
            const cb = (i * 9 + ky * 3 + kx) * 64;
            for (let y = y0; y < y1; y++) {
              const src = ib + (y + dy) * 8 + dx;
              const dst = cb + y * 8;
              for (let x = x0; x < x1; x++) cols[dst + x] = inp[src + x];
            }
          }
        }
      }
      // 出力4チャンネルずつまとめて計算し、cols の読み込みを使い回す
      let o = 0;
      for (; o + 4 <= Cout; o += 4) {
        const o0 = o * 64, o1 = o0 + 64, o2 = o1 + 64, o3 = o2 + 64;
        for (let p = 0; p < 64; p++) {
          out[o0 + p] = b[o]; out[o1 + p] = b[o + 1]; out[o2 + p] = b[o + 2]; out[o3 + p] = b[o + 3];
        }
        const w0 = o * K, w1 = w0 + K, w2 = w1 + K, w3 = w2 + K;
        for (let k = 0; k < K; k++) {
          const a0 = w[w0 + k], a1 = w[w1 + k], a2 = w[w2 + k], a3 = w[w3 + k];
          const cb = k * 64;
          for (let p = 0; p < 64; p++) {
            const c = cols[cb + p];
            out[o0 + p] += a0 * c;
            out[o1 + p] += a1 * c;
            out[o2 + p] += a2 * c;
            out[o3 + p] += a3 * c;
          }
        }
      }
      for (; o < Cout; o++) {
        const ob = o * 64;
        for (let p = 0; p < 64; p++) out[ob + p] = b[o];
        const wb = o * K;
        for (let k = 0; k < K; k++) {
          const wv = w[wb + k];
          const cb = k * 64;
          for (let p = 0; p < 64; p++) out[ob + p] += wv * cols[cb + p];
        }
      }
    }

    /** 1x1 畳み込み */
    static conv1(l, inp, out) {
      const { w, b } = l;
      for (let o = 0; o < l.out; o++) {
        const ob = o * 64;
        for (let p = 0; p < 64; p++) out[ob + p] = b[o];
        for (let i = 0; i < l.in; i++) {
          const wv = w[o * l.in + i];
          const ib = i * 64;
          for (let p = 0; p < 64; p++) out[ob + p] += wv * inp[ib + p];
        }
      }
    }

    static linear(l, inp, out) {
      const { w, b } = l;
      for (let o = 0; o < l.out; o++) {
        let s = b[o];
        const wb = o * l.in;
        for (let i = 0; i < l.in; i++) s += w[wb + i] * inp[i];
        out[o] = s;
      }
    }

    static relu(a, n) {
      for (let i = 0; i < n; i++) if (a[i] < 0) a[i] = 0;
    }

    /**
     * 局面を評価する。
     * @returns {{logits: Float32Array, value: number}} value は手番側から見た値（-1〜+1）
     */
    evaluate(board, player) {
      this.evals++;
      const C = this.C;
      const x = new Float32Array(3 * 64);
      const legal = O.getLegalMoves(board, player);
      for (let i = 0; i < 64; i++) {
        if (board[i] === player) x[i] = 1;
        else if (board[i] === -player) x[64 + i] = 1;
      }
      for (const m of legal) x[128 + m] = 1;

      let a = this.bufA;
      let t = this.bufB;
      const u = this.bufC;
      this.conv3(this.stem, x, a);
      Network.relu(a, C * 64);
      for (const r of this.res) {
        this.conv3(r.c1, a, t);
        Network.relu(t, C * 64);
        this.conv3(r.c2, t, u);
        for (let i = 0; i < C * 64; i++) {
          const s = a[i] + u[i];
          t[i] = s > 0 ? s : 0;
        }
        const tmp = a; a = t; t = tmp;
      }
      this.bufA = a;
      this.bufB = t;

      const ph = new Float32Array(2 * 64);
      Network.conv1(this.pConv, a, ph);
      Network.relu(ph, 128);
      const logits = new Float32Array(65);
      Network.linear(this.pFc, ph, logits);

      const vh = new Float32Array(64);
      Network.conv1(this.vConv, a, vh);
      Network.relu(vh, 64);
      const h = new Float32Array(this.vFc1.out);
      Network.linear(this.vFc1, vh, h);
      Network.relu(h, h.length);
      const vo = new Float32Array(1);
      Network.linear(this.vFc2, h, vo);
      return { logits, value: Math.tanh(vo[0]) };
    }
  }

  // ---------------------------------------------------------------- 探索
  function legalActions(board, player) {
    const moves = O.getLegalMoves(board, player);
    if (moves.length) return moves;
    if (O.getLegalMoves(board, -player).length) return [PASS];
    return [];
  }

  function terminalValue(board, player) {
    let d = 0;
    for (let i = 0; i < 64; i++) d += board[i];
    d *= player;
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  }

  class Node {
    constructor(board, player) {
      this.board = board;
      this.player = player;
      this.actions = legalActions(board, player);
      this.terminal = this.actions.length === 0;
      this.expanded = false;
      this.P = null;
      this.N = null;
      this.W = null;
      this.children = null;
      this.value = 0; // ネットの価値（手番側）
    }

    expand(net) {
      if (this.actions.length === 1 && this.actions[0] === PASS) {
        const { value } = net.evaluate(this.board, this.player);
        this.P = new Float64Array([1]);
        this.value = value;
      } else {
        const { logits, value } = net.evaluate(this.board, this.player);
        let max = -Infinity;
        for (const a of this.actions) if (logits[a] > max) max = logits[a];
        const P = new Float64Array(this.actions.length);
        let sum = 0;
        this.actions.forEach((a, i) => { P[i] = Math.exp(logits[a] - max); sum += P[i]; });
        for (let i = 0; i < P.length; i++) P[i] /= sum;
        this.P = P;
        this.value = value;
      }
      const n = this.actions.length;
      this.N = new Float64Array(n);
      this.W = new Float64Array(n);
      this.children = new Array(n).fill(null);
      this.expanded = true;
      return this.value;
    }

    select(cPuct) {
      let total = 0;
      for (let i = 0; i < this.N.length; i++) total += this.N[i];
      const sq = Math.sqrt(total + 1);
      let best = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < this.N.length; i++) {
        const q = this.N[i] > 0 ? this.W[i] / this.N[i] : 0;
        const s = q + cPuct * this.P[i] * sq / (1 + this.N[i]);
        if (s > bestScore) { bestScore = s; best = i; }
      }
      return best;
    }

    child(i) {
      if (!this.children[i]) {
        const a = this.actions[i];
        if (a === PASS) {
          this.children[i] = new Node(this.board, -this.player);
        } else {
          this.children[i] = new Node(O.applyMove(this.board, a, this.player).board, -this.player);
        }
      }
      return this.children[i];
    }
  }

  const sameBoard = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  class MCTS {
    constructor(net, opts) {
      this.net = net;
      this.cPuct = (opts && opts.cPuct) || 1.5;
      this.root = null;
    }

    /** 前回の木から、この局面の部分木を探して使い回す */
    rootFor(board, player) {
      const r = this.root;
      if (r && r.player === player && sameBoard(r.board, board)) return r;
      if (r && r.expanded) {
        for (const c of r.children) {
          if (!c) continue;
          if (c.player === player && sameBoard(c.board, board)) return c;
          if (c.expanded) {
            for (const g of c.children) {
              if (g && g.player === player && sameBoard(g.board, board)) return g;
            }
          }
        }
      }
      return new Node(board, player);
    }

    simulate(root) {
      const path = [];
      let node = root;
      let v;
      for (;;) {
        if (node.terminal) { v = terminalValue(node.board, node.player); break; }
        if (!node.expanded) { v = node.expand(this.net); break; }
        const i = node.select(this.cPuct);
        path.push([node, i]);
        node = node.child(i);
      }
      for (let k = path.length - 1; k >= 0; k--) {
        const [n, i] = path[k];
        v = -v;
        n.N[i] += 1;
        n.W[i] += v;
      }
    }

    /**
     * 探索して着手を決める。UI を止めないよう、少しずつ区切って実行する。
     * @param {{sims:number, temperature?:number, onProgress?:Function, shouldStop?:Function}} opts
     */
    async search(board, player, opts) {
      const sims = opts.sims || 200;
      const root = this.rootFor(board, player);
      this.root = root;
      if (!root.expanded && !root.terminal) root.expand(this.net);
      const already = root.N ? root.N.reduce((s, n) => s + n, 0) : 0;
      let done = 0;
      const target = Math.max(0, sims - already);
      while (done < target) {
        const t0 = Date.now();
        while (done < target && Date.now() - t0 < 25) { this.simulate(root); done++; }
        if (opts.shouldStop && opts.shouldStop()) return null;
        if (opts.onProgress) opts.onProgress(this.stats(root));
        if (done < target) await new Promise(r => setTimeout(r, 0));
      }
      const stats = this.stats(root);
      stats.move = this.pick(root, opts.temperature || 0);
      return stats;
    }

    pick(root, temperature) {
      const N = root.N;
      if (temperature > 0) {
        const p = Array.from(N, n => Math.pow(n, 1 / temperature));
        const s = p.reduce((a, b) => a + b, 0);
        let r = Math.random() * s;
        for (let i = 0; i < p.length; i++) { r -= p[i]; if (r <= 0) return root.actions[i]; }
      }
      let best = 0;
      for (let i = 1; i < N.length; i++) if (N[i] > N[best]) best = i;
      return root.actions[best];
    }

    /** 探索結果の要約（解説に使う） */
    stats(root) {
      const total = root.N.reduce((s, n) => s + n, 0);
      const moves = root.actions.map((a, i) => ({
        move: a,
        visits: root.N[i],
        share: total ? root.N[i] / total : 0,
        prior: root.P[i],
        q: root.N[i] ? root.W[i] / root.N[i] : null,
      })).sort((x, y) => y.visits - x.visits);
      // 最も多く訪問した手の Q が、その局面の見立て（手番側）
      const q = moves.length && moves[0].q !== null ? moves[0].q : root.value;
      // 読み筋（最善応手の連なり）
      const pv = [];
      let node = root;
      while (node && node.expanded && pv.length < 8) {
        let bi = 0;
        for (let i = 1; i < node.N.length; i++) if (node.N[i] > node.N[bi]) bi = i;
        if (!node.N[bi]) break;
        pv.push({ move: node.actions[bi], player: node.player });
        node = node.children[bi];
      }
      return { sims: total, value: q, netValue: root.value, winRate: (q + 1) / 2, moves, pv, player: root.player };
    }
  }

  async function loadNetwork(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`重みファイルを読み込めません (${res.status}): ${url}`);
    return new Network(await res.json());
  }

  const AlphaZero = { Network, MCTS, loadNetwork, PASS };
  global.OthelloAlphaZero = AlphaZero;
  if (typeof module !== 'undefined' && module.exports) module.exports = AlphaZero;
})(typeof window !== 'undefined' ? window : globalThis);
