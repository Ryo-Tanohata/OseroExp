/*
 * main.js — 画面の表示と対局の進行
 */
(function () {
  'use strict';

  const O = window.Othello;
  const AI = window.OthelloAI;
  const C = window.OthelloCommentary;
  const { BLACK, WHITE } = O;

  // 解説用の読み（AIの「強い」と同じ設定）
  const ANALYSIS = { depth: 4, exact: 10 };

  const $ = id => document.getElementById(id);
  const el = {
    board: $('board'), status: $('status'),
    mode: $('mode'), levelBlack: $('level-black'), levelWhite: $('level-white'), speed: $('speed'),
    showHints: $('show-hints'), showEval: $('show-eval'),
    btnNew: $('btn-new'), btnPause: $('btn-pause'), btnUndo: $('btn-undo'),
    countBlack: $('count-black'), countWhite: $('count-white'),
    nameBlack: $('name-black'), nameWhite: $('name-white'),
    boxBlack: $('box-black'), boxWhite: $('box-white'),
    phase: $('phase'), evalBlack: $('eval-black'), evalPercent: $('eval-percent'),
    evalText: $('eval-text'), evalDetail: $('eval-detail'),
    lastMove: $('last-move'), advice: $('advice'), candidates: $('candidates'),
    facts: $('facts'), points: $('points'), log: $('log'),
  };

  const state = {
    board: O.createBoard(),
    toMove: BLACK,        // 0 は対局終了
    analysis: null,       // 手番側から見た探索結果
    last: null,           // 直前の手
    history: [],          // 待った用のスナップショット
    log: [],
    justPlaced: null,
    justFlipped: [],
    paused: false,
    thinking: false,
    token: 0,             // 新しい対局や待ったで古いタイマーを無効化する
    timer: null,
  };

  // ---------- 盤面の生成 ----------
  const cells = [];
  function buildBoard() {
    el.board.innerHTML = '';
    const corner = document.createElement('div');
    corner.className = 'label';
    el.board.appendChild(corner);
    for (let c = 0; c < 8; c++) {
      const lab = document.createElement('div');
      lab.className = 'label';
      lab.textContent = 'abcdefgh'[c];
      el.board.appendChild(lab);
    }
    for (let r = 0; r < 8; r++) {
      const lab = document.createElement('div');
      lab.className = 'label';
      lab.textContent = r + 1;
      el.board.appendChild(lab);
      for (let c = 0; c < 8; c++) {
        const idx = r * 8 + c;
        const cell = document.createElement('button');
        cell.className = 'cell';
        cell.type = 'button';
        cell.setAttribute('aria-label', O.toNotation(idx));
        const disc = document.createElement('div');
        disc.className = 'disc';
        const hint = document.createElement('span');
        hint.className = 'hint';
        cell.appendChild(disc);
        cell.appendChild(hint);
        cell.addEventListener('click', () => onCellClick(idx));
        el.board.appendChild(cell);
        cells[idx] = { cell, disc, hint };
      }
    }
  }

  // ---------- 対局の設定 ----------
  function isAI(player) {
    const mode = el.mode.value;
    if (mode === 'ai-ai') return true;
    if (mode === 'human-human') return false;
    if (mode === 'human-ai') return player === WHITE;
    return player === BLACK; // ai-human
  }

  function levelOf(player) {
    return parseInt((player === BLACK ? el.levelBlack : el.levelWhite).value, 10);
  }

  function playerLabel(player) {
    const color = O.colorName(player);
    const mode = el.mode.value;
    if (mode === 'human-human') return color;
    if (isAI(player)) return `${color}（AI・${AI.LEVELS[levelOf(player)].name}）`;
    return `${color}（あなた）`;
  }

  // ---------- 進行 ----------
  function newGame() {
    state.token++;
    clearTimeout(state.timer);
    Object.assign(state, {
      board: O.createBoard(), toMove: BLACK, analysis: null, last: null,
      history: [], log: [], justPlaced: null, justFlipped: [], thinking: false,
      paused: false,
    });
    advance();
  }

  /** 手番を確定させ（パス・終局の処理）、解析し、AIの番なら次の手を予約する */
  function advance() {
    clearTimeout(state.timer);
    if (state.toMove !== 0 && O.getLegalMoves(state.board, state.toMove).length === 0) {
      if (O.getLegalMoves(state.board, -state.toMove).length === 0) {
        state.toMove = 0; // 終局
      } else {
        state.log.push({ player: state.toMove, pass: true });
        state.last = { player: state.toMove, pass: true };
        state.toMove = -state.toMove;
      }
    }
    state.analysis = null;
    render();

    if (state.toMove === 0) return;
    const token = state.token;
    // 描画を先に反映させてから、解説用の読みを行う
    state.timer = setTimeout(() => {
      if (token !== state.token) return;
      state.analysis = AI.search(state.board, state.toMove, ANALYSIS);
      render();
      scheduleAI();
    }, 30);
  }

  function scheduleAI() {
    clearTimeout(state.timer);
    if (state.toMove === 0 || !isAI(state.toMove) || state.paused || !state.analysis) return;
    const token = state.token;
    state.thinking = true;
    renderStatus();
    state.timer = setTimeout(() => {
      if (token !== state.token) return;
      const level = levelOf(state.toMove);
      let move;
      if (level === 3) {
        move = state.analysis.best; // 解説用の読みと同じ設定なので再利用
      } else {
        move = AI.chooseMove(state.board, state.toMove, level).move;
      }
      state.thinking = false;
      if (move !== null) play(move);
    }, parseInt(el.speed.value, 10));
  }

  function play(move) {
    const res = O.applyMove(state.board, move, state.toMove);
    if (!res) return;
    state.token++;
    state.history.push({
      board: state.board, toMove: state.toMove, analysis: state.analysis,
      last: state.last, logLength: state.log.length,
    });
    const quality = C.moveQuality(state.analysis, move);
    state.log.push({ player: state.toMove, move, flips: res.flips.length, quality });
    state.last = { player: state.toMove, move, boardBefore: state.board, analysisBefore: state.analysis };
    state.board = res.board;
    state.justPlaced = move;
    state.justFlipped = res.flips;
    state.toMove = -state.toMove;
    advance();
  }

  function onCellClick(idx) {
    if (state.toMove === 0 || isAI(state.toMove) || state.thinking) return;
    if (!O.isLegal(state.board, idx, state.toMove)) return;
    play(idx);
  }

  function undo() {
    if (!state.history.length) return;
    state.token++;
    clearTimeout(state.timer);
    state.thinking = false;
    let snap;
    do {
      snap = state.history.pop();
    } while (state.history.length && isAI(snap.toMove) && el.mode.value !== 'ai-ai');
    state.board = snap.board;
    state.toMove = snap.toMove;
    state.analysis = snap.analysis;
    state.last = snap.last;
    state.log.length = snap.logLength;
    state.justPlaced = null;
    state.justFlipped = [];
    if (el.mode.value === 'ai-ai') state.paused = true;
    render();
    if (!state.analysis) advance(); else scheduleAI();
  }

  function togglePause() {
    state.paused = !state.paused;
    if (state.paused) {
      state.token++;
      clearTimeout(state.timer);
      state.thinking = false;
      render();
    } else {
      state.token++;
      render();
      if (state.analysis) scheduleAI(); else advance();
    }
  }

  // ---------- 描画 ----------
  function render() {
    renderBoard();
    renderStatus();
    renderPanel();
  }

  function renderBoard() {
    const humanTurn = state.toMove !== 0 && !isAI(state.toMove);
    const legal = state.toMove !== 0 ? O.getLegalMoves(state.board, state.toMove) : [];
    const scores = {};
    let bestMove = null;
    if (state.analysis) {
      for (const c of state.analysis.candidates) scores[c.move] = c;
      bestMove = state.analysis.best;
    }
    const lastMove = state.last && !state.last.pass ? state.last.move : null;

    for (let i = 0; i < 64; i++) {
      const { cell, disc, hint } = cells[i];
      const v = state.board[i];
      disc.classList.toggle('black', v === BLACK);
      disc.classList.toggle('white', v === WHITE);
      cell.classList.toggle('last', i === lastMove);

      const isLegalHere = legal.includes(i);
      const showHint = isLegalHere && humanTurn && el.showHints.checked;
      const showEval = isLegalHere && el.showEval.checked && scores[i];
      cell.classList.toggle('legal', isLegalHere && humanTurn);
      cell.classList.toggle('show-hint', !!(showHint || showEval));
      cell.classList.toggle('best', !!showEval && i === bestMove);
      hint.textContent = showEval ? C.formatScore(scores[i].score, state.analysis.exact) : '';
      cell.disabled = !(isLegalHere && humanTurn);
    }

    // アニメーション
    if (state.justPlaced !== null) {
      restartAnimation(cells[state.justPlaced].disc, 'placed');
      for (const i of state.justFlipped) restartAnimation(cells[i].disc, 'flip');
      state.justPlaced = null;
      state.justFlipped = [];
    }
  }

  function restartAnimation(node, cls) {
    node.classList.remove('placed', 'flip');
    void node.offsetWidth; // リフローさせてアニメーションを再生し直す
    node.classList.add(cls);
  }

  function renderStatus() {
    const { black, white } = O.countDiscs(state.board);
    el.countBlack.textContent = black;
    el.countWhite.textContent = white;
    el.nameBlack.textContent = playerLabel(BLACK);
    el.nameWhite.textContent = playerLabel(WHITE);
    el.boxBlack.classList.toggle('active', state.toMove === BLACK);
    el.boxWhite.classList.toggle('active', state.toMove === WHITE);

    let text;
    if (state.toMove === 0) {
      text = black > white ? `対局終了：黒の勝ち！（${black} 対 ${white}）`
        : white > black ? `対局終了：白の勝ち！（${white} 対 ${black}）`
          : `対局終了：引き分け（${black} 対 ${white}）`;
    } else if (isAI(state.toMove)) {
      text = state.paused ? `一時停止中（${playerLabel(state.toMove)}の番）` : `${playerLabel(state.toMove)}が考えています…`;
    } else {
      text = `${playerLabel(state.toMove)}の番です。光っているマスに打てます。`;
    }
    if (state.last && state.last.pass && state.toMove !== 0) {
      text = `${O.colorName(state.last.player)}はパス。` + text;
    }
    el.status.textContent = text;
    el.btnPause.textContent = state.paused ? '再開' : '一時停止';
    el.btnPause.disabled = state.toMove === 0;
    el.btnUndo.disabled = state.history.length === 0;
  }

  function renderPanel() {
    const d = C.describe(state.board, state.toMove, state.analysis, state.last);

    // 形勢
    el.phase.textContent = d.phase.key === 'end' ? `${d.phase.label}・残り${d.phase.empties}` : d.phase.label;
    if (d.evaluation) {
      const pct = Math.round(d.evaluation.winRate * 100);
      el.evalBlack.style.width = pct + '%';
      el.evalPercent.textContent = d.evaluation.exact ? d.evaluation.short : `黒 ${pct}% : 白 ${100 - pct}%`;
      el.evalText.textContent = d.evaluation.text;
      el.evalDetail.textContent = d.evaluation.display
        ? `評価値：${d.evaluation.display}` + (state.analysis ? `（${state.analysis.exact ? '完全読み' : state.analysis.depth + '手先まで読み'}・${state.analysis.nodes.toLocaleString()}局面）` : '')
        : '';
    } else {
      el.evalText.textContent = 'AIが局面を読んでいます…';
      el.evalDetail.textContent = '';
    }

    // 直前の手
    el.lastMove.innerHTML = '';
    if (d.lastMove) {
      const h = document.createElement('p');
      h.className = 'move-title';
      h.textContent = d.lastMove.title;
      if (d.lastMove.quality) {
        const badge = document.createElement('span');
        badge.className = 'badge ' + d.lastMove.quality.cls;
        badge.textContent = d.lastMove.quality.label;
        h.appendChild(badge);
      }
      el.lastMove.appendChild(h);
      const ul = document.createElement('ul');
      for (const s of d.lastMove.sentences) {
        const li = document.createElement('li');
        li.textContent = s;
        ul.appendChild(li);
      }
      el.lastMove.appendChild(ul);
    } else {
      el.lastMove.innerHTML = '<p class="muted">まだ手は打たれていません。</p>';
    }

    // 次の一手
    el.candidates.innerHTML = '';
    if (d.advice) {
      el.advice.textContent = d.advice.text;
      d.advice.candidates.forEach((c, i) => {
        const tr = document.createElement('tr');
        [i + 1, c.notation, c.scoreText, c.reason].forEach(v => {
          const td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        });
        tr.addEventListener('mouseenter', () => cells[c.move].cell.classList.add('preview'));
        tr.addEventListener('mouseleave', () => cells[c.move].cell.classList.remove('preview'));
        el.candidates.appendChild(tr);
      });
    } else {
      el.advice.textContent = state.toMove === 0 ? '対局は終了しました。「新しい対局」で再戦できます。' : 'AIが局面を読んでいます…';
    }

    // 局面の要素
    const f = d.facts;
    const rows = [
      ['石数', f.discs.black, f.discs.white],
      ['打てる場所', f.mobility.black, f.mobility.white],
      ['隅', f.corners.black, f.corners.white],
      ['確定石', f.stable.black, f.stable.white],
      ['壁（空きに接する石）', f.frontier.black, f.frontier.white],
    ];
    el.facts.innerHTML = '';
    for (const [label, b, w] of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = label;
      const tb = document.createElement('td');
      tb.textContent = b;
      const tw = document.createElement('td');
      tw.textContent = w;
      tr.append(th, tb, tw);
      el.facts.appendChild(tr);
    }
    el.points.innerHTML = '';
    for (const s of d.points) {
      const li = document.createElement('li');
      li.textContent = s;
      el.points.appendChild(li);
    }

    renderLog();
  }

  function renderLog() {
    el.log.innerHTML = '';
    let n = 0;
    for (const entry of state.log) {
      const li = document.createElement('li');
      if (entry.pass) {
        li.className = 'pass';
        li.textContent = `${O.colorName(entry.player)} パス`;
        li.value = n;
      } else {
        n++;
        li.value = n;
        li.textContent = `${O.colorName(entry.player)} ${O.toNotation(entry.move)}（${entry.flips}個）`;
        if (entry.quality) {
          const badge = document.createElement('span');
          badge.className = 'badge small ' + entry.quality.cls;
          badge.textContent = entry.quality.label;
          li.appendChild(badge);
        }
      }
      el.log.appendChild(li);
    }
    el.log.scrollTop = el.log.scrollHeight;
  }

  // ---------- イベント ----------
  el.btnNew.addEventListener('click', newGame);
  el.btnUndo.addEventListener('click', undo);
  el.btnPause.addEventListener('click', togglePause);
  el.mode.addEventListener('change', newGame);
  [el.levelBlack, el.levelWhite].forEach(s => s.addEventListener('change', () => {
    render();
    if (!state.thinking) return;
    // 考え中なら新しい強さで考え直す
    state.token++;
    state.thinking = false;
    scheduleAI();
  }));
  el.showHints.addEventListener('change', renderBoard);
  el.showEval.addEventListener('change', renderBoard);

  buildBoard();
  newGame();
})();
