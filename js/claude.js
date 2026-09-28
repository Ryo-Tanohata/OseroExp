/*
 * claude.js — Claude との連携（着手・リアルタイム実況）
 *
 * 言語モデルは server/claude-bridge.mjs 経由で呼ぶ。どれも APIキー・従量課金は不要。
 *   local  : ローカルの Claude Code（`claude` コマンド、ログイン中のアカウント）
 *   ollama : Ollama で動かす無料のオープンモデル（Qwen・Gemma など）
 *   openai : LM Studio など OpenAI 互換のローカルサーバー
 * Claude が「打つ」のは local のときだけ。ほかのモデルは実況（解説文）だけを担当する。
 */
(function (global) {
  'use strict';

  const O = global.Othello || (typeof require !== 'undefined' ? require('./game.js') : null);
  const STORAGE_KEY = 'othello-claude-settings';

  const MODELS = {
    local: [
      { value: '', label: 'アカウントの既定モデル' },
      { value: 'opus', label: 'Opus（最新）' },
      { value: 'sonnet', label: 'Sonnet（最新・速め）' },
      { value: 'haiku', label: 'Haiku（最速）' },
    ],
  };

  // 各ローカル言語モデルサーバーの既定URL（ブリッジ側で localhost に限定）
  const LLM_BASES = { ollama: 'http://127.0.0.1:11434', openai: 'http://127.0.0.1:1234/v1' };
  const PROVIDERS = ['local', 'ollama', 'openai'];

  const DEFAULTS = {
    provider: 'none',
    model: '',
    llmModel: '',
    llmBase: '',
    bridgeUrl: '',
    commentary: true,
    waitCommentary: true,
    useEngine: true,
  };

  let settings = load();
  save({}); // 古い設定（APIキーなど）が残っていれば消しておく

  function load() {
    let s;
    try {
      s = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      s = Object.assign({}, DEFAULTS);
    }
    // 以前の版で保存された APIキーの設定は使わない
    delete s.apiKey;
    if (!PROVIDERS.includes(s.provider)) s.provider = 'none';
    return s;
  }

  function save(patch) {
    settings = Object.assign({}, settings, patch);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても動作は続ける */ }
    return settings;
  }

  function getSettings() { return settings; }
  function enabled() { return PROVIDERS.includes(settings.provider); }
  /** 着手まで任せられるのは Claude（local）だけ */
  function canPlay() { return settings.provider === 'local'; }
  function isLocalLlm() { return settings.provider === 'ollama' || settings.provider === 'openai'; }

  function bridgeBase() {
    if (settings.bridgeUrl) return settings.bridgeUrl.replace(/\/+$/, '');
    // ブリッジから配信されていれば同じオリジン、file:// で開いた場合は既定のポート
    return location.protocol.startsWith('http') ? '' : 'http://localhost:8787';
  }

  // ---------- ローカル（Claude Code）----------
  function runLocal(opts) {
    return streamFromBridge('/api/claude', { system: opts.system, prompt: opts.prompt, model: settings.model }, opts);
  }

  // ---------- ローカルの無料言語モデル（Ollama / LM Studio）----------
  function runLlm(opts) {
    if (!settings.llmModel) return Promise.reject(new Error('モデル名が設定されていません（例: qwen2.5:7b）。'));
    return streamFromBridge('/api/llm', {
      provider: settings.provider,
      base: settings.llmBase,
      model: settings.llmModel,
      system: opts.system,
      prompt: opts.prompt,
    }, opts);
  }

  async function listLlmModels() {
    let res;
    try {
      const q = new URLSearchParams({ provider: settings.provider, base: settings.llmBase });
      res = await fetch(bridgeBase() + '/api/llm/models?' + q);
    } catch {
      throw new Error('ブリッジに接続できません。`node server/claude-bridge.mjs` を起動してください。');
    }
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    return j.models;
  }

  /** ブリッジから Server-Sent Events で届く文章を読む */
  async function streamFromBridge(path, payload, { onText, signal }) {
    let res;
    try {
      res = await fetch(bridgeBase() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('ローカルのブリッジに接続できません。`node server/claude-bridge.mjs` を起動してください。');
    }
    if (!res.ok || !res.body) {
      let msg = `ブリッジがエラーを返しました (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* JSON でなければそのまま */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'text') { full += ev.text; onText(ev.text, full); }
        else if (ev.type === 'error') throw new Error(ev.message);
      }
    }
    return full;
  }

  /** Claude に問い合わせ、文章を少しずつ onText に渡す。完成した文章を返す。 */
  function run(opts) {
    if (settings.provider === 'local') return runLocal(opts);
    if (isLocalLlm()) return runLlm(opts);
    return Promise.reject(new Error('言語モデル連携がオフです。'));
  }

  async function testConnection() {
    if (settings.provider === 'local') {
      let res;
      try {
        res = await fetch(bridgeBase() + '/api/status');
      } catch {
        throw new Error('ブリッジに接続できません。`node server/claude-bridge.mjs` を起動してください。');
      }
      const j = await res.json();
      if (!j.ok) throw new Error('ブリッジは起動していますが、claude コマンドが見つかりません。');
    } else if (isLocalLlm()) {
      const models = await listLlmModels();
      if (!models.length) throw new Error('モデルがまだありません。例: `ollama pull qwen2.5:7b`');
      if (!settings.llmModel || !models.includes(settings.llmModel)) {
        throw new Error(`モデル「${settings.llmModel || '(未設定)'}」が見つかりません。利用できるモデル: ${models.join(', ')}`);
      }
    }
    let text = '';
    await run({
      system: 'あなたはオセロアプリの接続テストに答えるアシスタントです。',
      prompt: '接続テストです。「接続OK」とだけ答えてください。',
      onText: (_, full) => { text = full; },
    });
    return text.trim();
  }

  // ---------- プロンプト ----------
  const SYSTEM = [
    'あなたはオセロ（リバーシ）の名人であり、初心者にもわかりやすく説明できる解説者です。',
    '盤面は8x8で、列は a〜h（左→右）、行は 1〜8（上→下）。X が黒、O が白、. が空きマスです。',
    '隅・X打ち・C打ち・着手可能数（打てる場所の数）・確定石・壁・中割り・偶数理論などの考え方を使い、',
    '日本語で、具体的なマス名を挙げて簡潔に説明してください。見出しや箇条書きは使わず、普通の文章で書いてください。',
    '「事実メモ」やエンジンの数値が与えられた場合は、それだけを根拠にし、書かれていないことを推測で断定しないでください。',
  ].join('\n');

  function boardText(board) {
    const rows = ['  a b c d e f g h'];
    for (let r = 0; r < 8; r++) {
      let line = (r + 1) + ' ';
      for (let c = 0; c < 8; c++) {
        const v = board[r * 8 + c];
        line += (v === O.BLACK ? 'X' : v === O.WHITE ? 'O' : '.') + (c < 7 ? ' ' : '');
      }
      rows.push(line);
    }
    return rows.join('\n');
  }

  function colorWithMark(p) {
    return p === O.BLACK ? '黒(X)' : '白(O)';
  }

  function engineLines(analysis, player) {
    if (!analysis || !analysis.candidates.length) return '';
    const fmt = global.OthelloCommentary.formatScore;
    const list = analysis.candidates.slice(0, 5)
      .map(c => `${O.toNotation(c.move)}(${fmt(c.score, analysis.exact)})`).join(', ');
    return `参考: 評価エンジンの読み（${colorWithMark(player)}から見た評価値、${analysis.exact ? '終局まで完全読み・石差' : analysis.depth + '手読み'}）: ${list}`;
  }

  function lastMoveLine(last) {
    if (!last) return '直前の手: なし（初期局面）';
    if (last.pass) return `直前の手: ${colorWithMark(last.player)}はパス`;
    return `直前の手: ${colorWithMark(last.player)} が ${O.toNotation(last.move)} に打った`;
  }

  function factsLine(board) {
    const f = global.OthelloCommentary.positionFacts(board);
    return `石数 黒${f.discs.black}・白${f.discs.white} / 打てる場所 黒${f.mobility.black}・白${f.mobility.white} / ` +
      `隅 黒${f.corners.black}・白${f.corners.white} / 確定石 黒${f.stable.black}・白${f.stable.white} / 残り${f.discs.empty}マス`;
  }

  /** Claude に次の手を選ばせるプロンプト */
  function movePrompt({ board, player, analysis, last }) {
    const legal = O.getLegalMoves(board, player).map(O.toNotation).join(', ');
    const lines = [
      '現在の盤面:',
      boardText(board),
      '',
      lastMoveLine(last),
      factsLine(board),
      `あなたは ${colorWithMark(player)} の番です。合法手: ${legal}`,
    ];
    if (settings.useEngine) lines.push(engineLines(analysis, player) + '（最終判断はあなたが行ってください）');
    lines.push(
      '',
      'あなたが打つ手を1つ選び、なぜその手を選んだのか、いまの局面がどうなっているかを実況するように3〜5文で説明してください。',
      '最後の行には必ず「着手: d3」のような形式で、合法手の中から1手だけを書いてください。',
    );
    return lines.join('\n');
  }

  function azMoveName(m) {
    return m === 64 ? 'パス' : O.toNotation(m);
  }

  /** AlphaZero の探索結果を文章にする */
  function azLines(az) {
    if (!az) return [];
    const st = az.stats;
    const top = st.moves.slice(0, 3)
      .map(m => `${azMoveName(m.move)}(探索の${Math.round(m.share * 100)}%・打った後の勝率${m.q === null ? '?' : Math.round((m.q + 1) * 50)}%)`)
      .join(', ');
    const pv = st.pv.map(p => `${p.player === O.BLACK ? '黒' : '白'}${azMoveName(p.move)}`).join(' → ');
    return [
      `AlphaZero（${colorWithMark(az.player)}、${st.sims}回探索）は打つ前の局面で自分の勝率を約${Math.round(st.winRate * 100)}%と見ていました。`,
      `AlphaZero の候補: ${top}`,
      pv ? `AlphaZero の読み筋: ${pv}` : '',
      st.moves[0] && st.move !== undefined && st.move !== st.moves[0].move
        ? `（序盤なので変化をつけるため、最有力の ${azMoveName(st.moves[0].move)} ではなく確率的に ${azMoveName(st.move)} を選びました）` : '',
    ].filter(Boolean);
  }

  /** 内蔵の解説エンジン（explain.js）がまとめた事実 */
  function factMemo(board, toMove, analysis, last) {
    const C = global.OthelloCommentary;
    if (!C) return [];
    // 直前の手の分析には打つ前の盤面が必要
    const usable = last && (last.pass || last.boardBefore) ? last : null;
    const d = C.describe(board, toMove, analysis, usable);
    const memo = [];
    if (d.lastMove) {
      const q = d.lastMove.quality ? `【${d.lastMove.quality.label}】` : '';
      memo.push(`直前の手 ${d.lastMove.title}${q}: ${d.lastMove.sentences.join(' ')}`);
    }
    if (d.evaluation) memo.push(`形勢: ${d.evaluation.text}`);
    for (const p of d.points) memo.push(p);
    if (d.advice) memo.push(d.advice.text);
    return memo;
  }

  /** 直前の手と局面を実況させるプロンプト */
  function commentaryPrompt({ board, toMove, analysis, last, az }) {
    const lines = [
      '現在の盤面:',
      boardText(board),
      '',
      lastMoveLine(last),
      factsLine(board),
    ];
    const memo = factMemo(board, toMove, analysis, last);
    if (memo.length) lines.push('', '事実メモ（解説エンジンが計算した内容）:', ...memo.map(m => '- ' + m));
    const azl = azLines(az);
    if (azl.length) lines.push('', ...azl);
    if (toMove === 0) {
      lines.push('対局は終了しました。', '', '勝敗の決め手になったポイントを振り返って3〜4文で解説してください。');
    } else {
      lines.push(`次は ${colorWithMark(toMove)} の番です。`);
      lines.push(engineLines(analysis, toMove));
      lines.push('', '直前の手の狙いと良し悪し、いまの形勢、次に注目すべきポイントを、テレビの実況解説のように3〜4文で説明してください。');
    }
    return lines.join('\n');
  }

  /** Claude の返答から着手（例: d3）を取り出す。見つからなければ null。 */
  function parseMove(text, board, player) {
    const re = /着手\s*[:：]\s*\**\s*([a-hＡ-Ｈａ-ｈA-H])\s*([1-8１-８])/g;
    let m;
    let found = null;
    while ((m = re.exec(text)) !== null) found = m;
    if (!found) return null;
    const toHalf = s => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    const idx = O.fromNotation(toHalf(found[1]).toLowerCase() + toHalf(found[2]));
    return O.isLegal(board, idx, player) ? idx : null;
  }

  const Claude = {
    MODELS, LLM_BASES, SYSTEM, getSettings, save, enabled, canPlay, isLocalLlm, run, testConnection, listLlmModels,
    movePrompt, commentaryPrompt, parseMove, boardText,
  };
  global.OthelloClaude = Claude;
  if (typeof module !== 'undefined' && module.exports) module.exports = Claude;
})(typeof window !== 'undefined' ? window : globalThis);
