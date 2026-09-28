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
    facts: $('facts'), points: $('points'), log: $('log'), preview: $('preview'),
    claudeCard: $('claude-card'), claudeState: $('claude-state'),
    claudeTitle: $('claude-title'), claudeText: $('claude-text'),
    claudeProvider: $('claude-provider'), claudeBridge: $('claude-bridge'),
    claudeModel: $('claude-model'),
    claudeCommentary: $('claude-commentary'), claudeWait: $('claude-wait'),
    claudeEngine: $('claude-engine'), claudeTest: $('claude-test'),
    claudeTestResult: $('claude-test-result'), claudeHelp: $('claude-help'),
    azSims: $('az-sims'), azCard: $('az-card'), azState: $('az-state'), azTitle: $('az-title'),
    azBar: $('az-bar'), azSummary: $('az-summary'), azMoves: $('az-moves'), azPv: $('az-pv'),
    claudeCardName: $('claude-card-name'), rowClaudeModel: $('row-claude-model'),
    rowLlmModel: $('row-llm-model'), rowLlmBase: $('row-llm-base'),
    llmModel: $('llm-model'), llmModelList: $('llm-model-list'), llmBase: $('llm-base'),
    rowBridge: $('row-bridge'), claudeSettings: $('claude-settings'),
  };
  const CL = window.OthelloClaude;
  const AZ = window.OthelloAlphaZero;

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
    claudeAbort: null,    // 実行中の Claude への問い合わせを中断する AbortController
    hover: null,          // マウスを乗せているマス（リアルタイムの手の説明用）
    azLast: null,         // 直近の AlphaZero の探索結果（実況に使う）
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
        cell.addEventListener('mouseenter', () => setHover(idx));
        cell.addEventListener('mouseleave', () => setHover(null));
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

  /** 1〜4 は内蔵AIの強さ、'az' / 'az-mid' は AlphaZero、'claude' は Claude が打つ */
  function levelOf(player) {
    const v = (player === BLACK ? el.levelBlack : el.levelWhite).value;
    return /^\d+$/.test(v) ? parseInt(v, 10) : v;
  }

  function isAZ(player) {
    const l = levelOf(player);
    return isAI(player) && (l === 'az' || l === 'az-mid');
  }

  function isClaude(player) {
    return isAI(player) && levelOf(player) === 'claude';
  }

  function playerLabel(player) {
    const color = O.colorName(player);
    const mode = el.mode.value;
    if (mode === 'human-human') return color;
    if (isClaude(player)) return `${color}（Claude）`;
    if (isAZ(player)) return `${color}（AlphaZero${levelOf(player) === 'az-mid' ? '・学習途中' : ''}）`;
    if (isAI(player)) return `${color}（AI・${AI.LEVELS[levelOf(player)].name}）`;
    return `${color}（あなた）`;
  }

  // ---------- 進行 ----------
  function cancelClaude() {
    if (state.claudeAbort) {
      state.claudeAbort.abort();
      state.claudeAbort = null;
    }
  }

  function newGame() {
    state.token++;
    clearTimeout(state.timer);
    cancelClaude();
    Object.assign(state, {
      board: O.createBoard(), toMove: BLACK, analysis: null, last: null,
      history: [], log: [], justPlaced: null, justFlipped: [], thinking: false,
      paused: false, azLast: null,
    });
    for (const k of Object.keys(azTrees)) delete azTrees[k];
    el.azCard.hidden = !(isAZ(BLACK) || isAZ(WHITE));
    el.azTitle.textContent = el.azCard.hidden ? '' : 'AlphaZero の番になると、探索の様子がここにリアルタイムで表示されます。';
    el.azSummary.textContent = '';
    el.azMoves.innerHTML = '';
    el.azPv.textContent = '';
    el.azState.textContent = '';
    el.azBar.style.width = '50%';
    resetClaudeCard();
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

    const token = state.token;
    if (state.toMove === 0) {
      if (wantsCommentary()) startCommentary();
      return;
    }
    // 描画を先に反映させてから、解説用の読みを行う
    state.timer = setTimeout(() => {
      if (token !== state.token) return;
      state.analysis = AI.search(state.board, state.toMove, ANALYSIS);
      render();
      afterAnalysis(token);
    }, 30);
  }

  function wantsCommentary() {
    return CL.enabled() && CL.getSettings().commentary;
  }

  /** 解析が終わったら、Claude の実況を始め、AIの手番なら次の手を予約する */
  function afterAnalysis(token) {
    // Claude 自身が打った手は、その「考え」がそのまま実況になっている
    const lastByClaude = state.last && state.last.byClaude;
    // 次が Claude の手番なら、Claude の考えがそのまま実況になる
    if (wantsCommentary() && state.last && !lastByClaude && !isClaude(state.toMove)) {
      const done = startCommentary();
      if (CL.getSettings().waitCommentary && isAI(state.toMove)) {
        done.then(() => { if (token === state.token) scheduleAI(); });
        return;
      }
    }
    scheduleAI();
  }

  function scheduleAI() {
    clearTimeout(state.timer);
    if (state.toMove === 0 || !isAI(state.toMove) || state.paused || !state.analysis) return;
    const token = state.token;
    state.thinking = true;
    renderStatus();
    if (isClaude(state.toMove)) {
      claudeMove(token);
      return;
    }
    if (isAZ(state.toMove)) {
      azMove(token);
      return;
    }
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

  // ---------- AlphaZero ----------
  const AZ_MODELS = { az: 'models/alphazero.js', 'az-mid': 'models/alphazero-mid.js' };
  const azNets = {};   // level -> Promise<Network>
  const azTrees = {};  // "色:level" -> MCTS（手をまたいで探索木を使い回す）

  /** 重みは <script> で読み込む（file:// で開いた場合でも動くように） */
  function loadAz(level) {
    if (!azNets[level]) {
      azNets[level] = new Promise((resolve, reject) => {
        const store = window.OTHELLO_AZ_MODELS || {};
        if (store[level]) { resolve(new AZ.Network(store[level])); return; }
        const sc = document.createElement('script');
        sc.src = AZ_MODELS[level];
        sc.onload = () => {
          const data = (window.OTHELLO_AZ_MODELS || {})[level];
          if (data) resolve(new AZ.Network(data));
          else reject(new Error('AlphaZero の重みが見つかりません'));
        };
        sc.onerror = () => reject(new Error(`AlphaZero の重み（${AZ_MODELS[level]}）を読み込めません`));
        document.head.appendChild(sc);
      }).catch(e => { delete azNets[level]; throw e; });
    }
    return azNets[level];
  }

  async function azMove(token) {
    const player = state.toMove;
    const level = levelOf(player);
    const t0 = Date.now();
    el.azCard.hidden = false;
    let net;
    try {
      net = await loadAz(level);
    } catch (e) {
      if (token !== state.token) return;
      el.azTitle.textContent = e.message + '（内蔵AIが代わりに打ちます）';
      state.thinking = false;
      play(state.analysis.best);
      return;
    }
    if (token !== state.token) return;
    const key = player + ':' + level;
    if (!azTrees[key] || azTrees[key].net !== net) azTrees[key] = new AZ.MCTS(net);
    // AI同士の対局が毎回同じにならないよう、最初の数手だけ訪問回数に比例した確率で選ぶ
    const movesSoFar = state.log.filter(e => !e.pass).length;
    const temperature = el.mode.value === 'ai-ai' && movesSoFar < 4 ? 1 : 0;
    const stats = await azTrees[key].search(state.board, player, {
      sims: parseInt(el.azSims.value, 10),
      temperature,
      shouldStop: () => token !== state.token,
      onProgress: st => renderAz(player, level, st, true),
    });
    if (!stats || token !== state.token) return;
    renderAz(player, level, stats, false);
    state.azLast = { player, level, stats, moveNumber: movesSoFar + 1 };
    const wait = Math.max(0, parseInt(el.speed.value, 10) - (Date.now() - t0));
    state.timer = setTimeout(() => {
      if (token !== state.token) return;
      state.thinking = false;
      play(stats.move);
    }, wait);
  }

  function azMoveName(m) {
    return m === AZ.PASS ? 'パス' : O.toNotation(m);
  }

  /** AlphaZero の読みをカードに表示（探索中もリアルタイムに更新） */
  function renderAz(player, level, st, live) {
    el.azCard.hidden = false;
    const who = `${O.colorName(player)}（AlphaZero${level === 'az-mid' ? '・学習途中' : ''}）`;
    el.azTitle.textContent = live ? `${who}が探索中… ${st.sims}回` : `${who}の結論：${azMoveName(st.move)}（探索${st.sims}回）`;
    el.azState.textContent = live ? '探索中' : '完了';
    el.azState.className = 'claude-state ' + (live ? 'busy' : 'done');
    const blackWin = player === BLACK ? st.winRate : 1 - st.winRate;
    el.azBar.style.width = Math.round(blackWin * 100) + '%';

    const top = st.moves[0];
    const byPrior = st.moves.slice().sort((a, b) => b.prior - a.prior)[0];
    let summary = `AlphaZero の見立てでは ${O.colorName(player)}の勝率は約${Math.round(st.winRate * 100)}%（黒${Math.round(blackWin * 100)}% : 白${100 - Math.round(blackWin * 100)}%）。`;
    if (top && byPrior && top.move !== byPrior.move && st.sims >= 50) {
      summary += `ネットの直感では ${azMoveName(byPrior.move)} が第一候補でしたが、読んだ結果 ${azMoveName(top.move)} の方が良いと判断しています。`;
    } else if (top) {
      summary += `直感でも読みでも ${azMoveName(top.move)} が最有力です。`;
    }
    if (!live && top && st.move !== top.move) {
      summary += `（序盤は対局に変化をつけるため、探索の配分に比例した確率で ${azMoveName(st.move)} を選びました）`;
    }
    el.azSummary.textContent = summary;

    el.azMoves.innerHTML = '';
    for (const m of st.moves.slice(0, 5)) {
      const tr = document.createElement('tr');
      const after = m.q === null ? '―' : Math.round((m.q + 1) * 50) + '%';
      [azMoveName(m.move), Math.round(m.share * 100) + '%', after, Math.round(m.prior * 100) + '%'].forEach(v => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      el.azMoves.appendChild(tr);
    }
    el.azPv.textContent = st.pv.length
      ? '読み筋：' + st.pv.map(p => `${O.colorName(p.player)}${azMoveName(p.move)}`).join(' → ')
      : '';
  }

  /** Claude に次の手を考えさせる（考えている文章はリアルタイムに表示） */
  async function claudeMove(token) {
    cancelClaude();
    const ctrl = new AbortController();
    state.claudeAbort = ctrl;
    const player = state.toMove;
    const board = state.board;
    const analysis = state.analysis;
    let move = null;
    let note = '';
    try {
      if (!CL.canPlay()) throw new Error('Claude に打たせるには、言語モデルの設定で「ローカルの Claude Code」を選んでください。');
      const text = await streamToCard({
        title: `${playerLabel(player)}の考え`,
        prompt: CL.movePrompt({ board, player, analysis, last: state.last }),
        signal: ctrl.signal,
        busyLabel: '考え中…',
      });
      move = CL.parseMove(text, board, player);
      if (move === null) note = 'Claude の答えから合法手を読み取れなかったため、内蔵AIの最善手を代わりに打ちます。';
    } catch (e) {
      if (e.name === 'AbortError' || token !== state.token) return;
      note = '内蔵AIの最善手を代わりに打ちます。';
    } finally {
      if (state.claudeAbort === ctrl) state.claudeAbort = null;
    }
    if (token !== state.token) return;
    if (move === null) {
      move = analysis.best;
      appendCardNote(note);
    }
    state.thinking = false;
    play(move, { byClaude: true });
  }

  /** 直前の手が AlphaZero の手なら、その探索結果を実況の材料にする */
  function azForLast(last) {
    const a = state.azLast;
    if (!a || !last || last.pass || a.player !== last.player || a.stats.move !== last.move) return null;
    return a;
  }

  /** 直前の手（または終局）を Claude にリアルタイム実況させる */
  function startCommentary() {
    cancelClaude();
    const ctrl = new AbortController();
    state.claudeAbort = ctrl;
    const last = state.last;
    let title;
    if (state.toMove === 0) title = '対局の振り返り';
    else if (!last) title = '局面の解説';
    else if (last.pass) title = `${O.colorName(last.player)}のパス`;
    else title = `${O.colorName(last.player)} ${O.toNotation(last.move)} の実況`;
    return streamToCard({
      title,
      prompt: CL.commentaryPrompt({ board: state.board, toMove: state.toMove, analysis: state.analysis, last, az: azForLast(last) }),
      signal: ctrl.signal,
      busyLabel: '実況中…',
    }).catch(() => { /* エラーはカードに表示済み */ })
      .finally(() => { if (state.claudeAbort === ctrl) state.claudeAbort = null; });
  }

  function play(move, opts) {
    const res = O.applyMove(state.board, move, state.toMove);
    if (!res) return;
    state.token++;
    state.history.push({
      board: state.board, toMove: state.toMove, analysis: state.analysis,
      last: state.last, logLength: state.log.length,
    });
    const quality = C.moveQuality(state.analysis, move);
    state.log.push({ player: state.toMove, move, flips: res.flips.length, quality });
    state.last = {
      player: state.toMove, move, boardBefore: state.board, analysisBefore: state.analysis,
      byClaude: !!(opts && opts.byClaude),
    };
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
    cancelClaude();
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
    state.token++;
    if (state.paused) {
      clearTimeout(state.timer);
      if (state.thinking) cancelClaude(); // 考え中の Claude は止める（実況はそのまま続ける）
      state.thinking = false;
      render();
    } else {
      render();
      if (state.analysis) scheduleAI(); else advance();
    }
  }

  // ---------- リアルタイムの手の説明（マウスを乗せたマス）----------
  function setHover(idx) {
    state.hover = idx;
    renderPreview();
  }

  function renderPreview() {
    const idx = state.hover;
    const p = state.toMove;
    el.preview.innerHTML = '';
    if (idx === null || p === 0 || !O.isLegal(state.board, idx, p)) {
      const m = document.createElement('p');
      m.className = 'muted';
      m.textContent = p === 0 ? '' : '盤上の打てるマスにマウスを乗せると、その手の説明がリアルタイムに表示されます。';
      el.preview.appendChild(m);
      return;
    }
    const f = C.moveFeatures(state.board, idx, p);
    const head = document.createElement('p');
    head.className = 'move-title';
    head.textContent = `もし${O.colorName(p)}が ${O.toNotation(idx)} に打つと…`;
    if (state.analysis) {
      const q = C.moveQuality(state.analysis, idx);
      const cand = state.analysis.candidates.find(c => c.move === idx);
      if (q) {
        const badge = document.createElement('span');
        badge.className = 'badge ' + q.cls;
        badge.textContent = q.label;
        head.appendChild(badge);
      }
      if (cand) {
        const sc = document.createElement('span');
        sc.className = 'preview-score';
        sc.textContent = `評価 ${C.formatScore(cand.score, state.analysis.exact)}・候補${q ? q.rank : '-'}位`;
        head.appendChild(sc);
      }
    }
    el.preview.appendChild(head);
    const ul = document.createElement('ul');
    const sentences = C.featureSentences(f, p);
    sentences.unshift(`${f.flips}個の石を返し、相手の打てる場所は ${f.oppMobBefore} → ${f.oppMobAfter} か所になります。`);
    for (const s of sentences) {
      const li = document.createElement('li');
      li.textContent = s;
      ul.appendChild(li);
    }
    el.preview.appendChild(ul);
  }

  // ---------- Claude の実況カード ----------
  function claudeVisible() {
    return CL.enabled() || el.levelBlack.value === 'claude' || el.levelWhite.value === 'claude';
  }

  // カードの「世代」。古い問い合わせの結果が新しい表示を上書きしないようにする
  let cardGen = 0;

  function llmName() {
    const cfg = CL.getSettings();
    if (CL.isLocalLlm()) return cfg.llmModel || 'ローカルLLM';
    return 'Claude';
  }

  function resetClaudeCard() {
    cardGen++;
    el.claudeCardName.textContent = `${llmName()} の実況`;
    el.claudeCard.hidden = !claudeVisible();
    el.claudeTitle.textContent = '';
    el.claudeText.textContent = CL.enabled()
      ? (CL.getSettings().commentary ? '手が打たれると、Claude がリアルタイムで実況します。' : '')
      : '言語モデル連携がオフです。左下の「言語モデル（Claude・実況）の設定」で接続方法を選んでください。';
    setClaudeState('', '');
  }

  function setClaudeState(label, cls) {
    el.claudeState.textContent = label;
    el.claudeState.className = 'claude-state ' + cls;
  }

  function appendCardNote(note) {
    if (!note) return;
    const n = document.createElement('p');
    n.className = 'claude-note';
    n.textContent = note;
    el.claudeText.appendChild(n);
  }

  /** Claude の返答を少しずつカードに表示する */
  async function streamToCard({ title, prompt, signal, busyLabel }) {
    const gen = ++cardGen;
    const current = () => gen === cardGen;
    el.claudeCard.hidden = false;
    el.claudeTitle.textContent = title;
    el.claudeText.textContent = '';
    const body = document.createElement('p');
    body.className = 'claude-body typing';
    el.claudeText.appendChild(body);
    setClaudeState(busyLabel, 'busy');
    try {
      const text = await CL.run({
        system: CL.SYSTEM,
        prompt,
        signal,
        onText: (_, full) => { if (current()) body.textContent = full; },
      });
      body.classList.remove('typing');
      if (current()) setClaudeState('完了', 'done');
      return text;
    } catch (e) {
      body.classList.remove('typing');
      if (!current()) {
        // 新しい表示に切り替わっているので何もしない
      } else if (e.name === 'AbortError') {
        setClaudeState('中断', '');
      } else {
        setClaudeState('エラー', 'error');
        appendCardNote(e.message);
      }
      throw e;
    }
  }

  // ---------- 描画 ----------
  function render() {
    renderBoard();
    renderStatus();
    renderPanel();
    renderPreview();
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
      cell.setAttribute('aria-disabled', String(!(isLegalHere && humanTurn)));
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
        tr.addEventListener('mouseenter', () => { cells[c.move].cell.classList.add('preview'); setHover(c.move); });
        tr.addEventListener('mouseleave', () => { cells[c.move].cell.classList.remove('preview'); setHover(null); });
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
    if (el.claudeCard.hidden && claudeVisible()) resetClaudeCard();
    if (isAZ(BLACK) || isAZ(WHITE)) el.azCard.hidden = false;
    render();
    if (!state.thinking) return;
    // 考え中なら新しい設定で考え直す
    state.token++;
    cancelClaude();
    state.thinking = false;
    scheduleAI();
  }));
  el.showHints.addEventListener('change', renderBoard);
  el.showEval.addEventListener('change', renderBoard);

  // ---------- Claude 連携の設定 ----------
  const HELP = {
    none: '言語モデルを使わず、内蔵AIと AlphaZero だけで対局・解説します。',
    ollama: 'Ollama（無料）で動かすオープンモデルが実況します。例: `ollama pull qwen2.5:7b` でモデルを入れ、' +
      '`node server/claude-bridge.mjs` を起動して http://localhost:8787 を開いてください。' +
      'モデルは実況だけを担当し、着手は AlphaZero や内蔵AIが決めます。',
    openai: 'LM Studio などの OpenAI 互換ローカルサーバー（既定: http://127.0.0.1:1234/v1）のモデルが実況します。' +
      '`node server/claude-bridge.mjs` 経由でつなぎます。',
    local: 'ターミナルで `node server/claude-bridge.mjs` を起動し、http://localhost:8787 を開いてください。' +
      'パソコンの `claude` コマンド（Claude Code）にログインしているアカウントで動くので、APIキーは不要です。',
  };

  function fillModelOptions() {
    const cfg = CL.getSettings();
    const list = CL.MODELS[cfg.provider] || [];
    el.claudeModel.innerHTML = '';
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m.value;
      o.textContent = m.label;
      el.claudeModel.appendChild(o);
    }
    if (list.some(m => m.value === cfg.model)) {
      el.claudeModel.value = cfg.model;
    } else if (list.length) {
      el.claudeModel.value = list[0].value;
      CL.save({ model: list[0].value });
    }
    el.claudeModel.disabled = !list.length;
  }

  function syncClaudeSettings() {
    const cfg = CL.getSettings();
    el.claudeProvider.value = cfg.provider;
    el.claudeBridge.value = cfg.bridgeUrl;
    el.claudeCommentary.checked = cfg.commentary;
    el.claudeWait.checked = cfg.waitCommentary;
    el.claudeEngine.checked = cfg.useEngine;
    el.rowBridge.hidden = cfg.provider === 'none';
    el.rowClaudeModel.hidden = cfg.provider !== 'local';
    el.rowLlmModel.hidden = !CL.isLocalLlm();
    el.rowLlmBase.hidden = !CL.isLocalLlm();
    el.llmModel.value = cfg.llmModel;
    el.llmBase.value = cfg.llmBase;
    el.llmBase.placeholder = CL.LLM_BASES[cfg.provider] ? `自動（${CL.LLM_BASES[cfg.provider]}）` : '';
    el.claudeHelp.textContent = HELP[cfg.provider];
    fillModelOptions();
  }

  el.claudeProvider.addEventListener('change', () => {
    cancelClaude();
    CL.save({ provider: el.claudeProvider.value });
    syncClaudeSettings();
    el.claudeTestResult.textContent = '';
    resetClaudeCard();
    if (CL.enabled()) el.claudeSettings.open = true;
  });
  el.claudeModel.addEventListener('change', () => CL.save({ model: el.claudeModel.value }));
  el.llmModel.addEventListener('change', () => { CL.save({ llmModel: el.llmModel.value.trim() }); resetClaudeCard(); });
  el.llmBase.addEventListener('change', () => CL.save({ llmBase: el.llmBase.value.trim() }));
  el.claudeBridge.addEventListener('change', () => CL.save({ bridgeUrl: el.claudeBridge.value.trim() }));
  el.claudeCommentary.addEventListener('change', () => { CL.save({ commentary: el.claudeCommentary.checked }); resetClaudeCard(); });
  el.claudeWait.addEventListener('change', () => CL.save({ waitCommentary: el.claudeWait.checked }));
  el.claudeEngine.addEventListener('change', () => CL.save({ useEngine: el.claudeEngine.checked }));
  el.claudeTest.addEventListener('click', async () => {
    CL.save({ bridgeUrl: el.claudeBridge.value.trim(), llmModel: el.llmModel.value.trim(), llmBase: el.llmBase.value.trim() });
    el.claudeTestResult.textContent = '接続中…';
    el.claudeTest.disabled = true;
    try {
      if (CL.isLocalLlm()) {
        // インストール済みのモデル一覧を候補として出す
        const models = await CL.listLlmModels();
        el.llmModelList.innerHTML = '';
        for (const m of models) {
          const o = document.createElement('option');
          o.value = m;
          el.llmModelList.appendChild(o);
        }
        if (!el.llmModel.value && models.length) {
          el.llmModel.value = models[0];
          CL.save({ llmModel: models[0] });
          resetClaudeCard();
        }
      }
      const reply = await CL.testConnection();
      el.claudeTestResult.textContent = '✅ 接続できました：' + reply;
    } catch (e) {
      el.claudeTestResult.textContent = '❌ ' + e.message;
    } finally {
      el.claudeTest.disabled = false;
    }
  });

  syncClaudeSettings();
  buildBoard();
  newGame();
})();
