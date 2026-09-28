/*
 * claude.js — Claude との連携（着手・リアルタイム実況）
 *
 * 接続方法は2通り:
 *   local : ローカルの Claude Code（`claude` コマンド）を server/claude-bridge.mjs 経由で使う。
 *           ログイン中のアカウント（Pro/Max など）で動き、APIキーは不要。
 *   api   : Claude API をブラウザから直接呼ぶ（公式 SDK を CDN から読み込む）。
 *           Claude Console で発行した APIキーが必要。GitHub Pages などに置いても動く。
 */
(function (global) {
  'use strict';

  const O = global.Othello || (typeof require !== 'undefined' ? require('./game.js') : null);
  const STORAGE_KEY = 'othello-claude-settings';
  const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.129.0';

  const MODELS = {
    local: [
      { value: '', label: 'アカウントの既定モデル' },
      { value: 'opus', label: 'Opus（最新）' },
      { value: 'sonnet', label: 'Sonnet（最新・速め）' },
      { value: 'haiku', label: 'Haiku（最速）' },
    ],
    api: [
      { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（速め）' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5（最速）' },
    ],
  };
  // サーバー側フォールバック（拒否時に別モデルで再実行）に対応したモデル
  const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

  const DEFAULTS = {
    provider: 'none',
    apiKey: '',
    model: '',
    bridgeUrl: '',
    commentary: true,
    waitCommentary: true,
    useEngine: true,
  };

  let settings = load();

  function load() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return Object.assign({}, DEFAULTS);
    }
  }

  function save(patch) {
    settings = Object.assign({}, settings, patch);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても動作は続ける */ }
    return settings;
  }

  function getSettings() { return settings; }
  function enabled() { return settings.provider === 'local' || settings.provider === 'api'; }

  function bridgeBase() {
    if (settings.bridgeUrl) return settings.bridgeUrl.replace(/\/+$/, '');
    // ブリッジから配信されていれば同じオリジン、file:// で開いた場合は既定のポート
    return location.protocol.startsWith('http') ? '' : 'http://localhost:8787';
  }

  // ---------- ローカル（Claude Code）----------
  async function runLocal({ system, prompt, onText, signal }) {
    let res;
    try {
      res = await fetch(bridgeBase() + '/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, prompt, model: settings.model }),
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

  // ---------- Claude API（ブラウザから直接）----------
  let sdkPromise = null;
  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = import(SDK_URL).then(m => m.default).catch(e => {
        sdkPromise = null;
        throw new Error('Anthropic SDK を読み込めませんでした（ネット接続を確認してください）: ' + e.message);
      });
    }
    return sdkPromise;
  }

  async function runApi({ system, prompt, onText, signal }) {
    if (!settings.apiKey) throw new Error('APIキーが設定されていません。');
    const Anthropic = await loadSdk();
    const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
    const model = settings.model || MODELS.api[0].value;
    const params = {
      model,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: prompt }],
    };
    if (model !== 'claude-haiku-4-5') params.output_config = { effort: 'low' }; // 速く返してほしいので low
    if (FALLBACK_MODELS.has(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    let full = '';
    try {
      const stream = client.beta.messages.stream(params, { signal });
      stream.on('text', t => { full += t; onText(t, full); });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('Claude がこのリクエストへの回答を控えました。');
      return full;
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError) {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        throw abort;
      }
      if (e instanceof Anthropic.AuthenticationError) throw new Error('APIキーが正しくありません。');
      if (e instanceof Anthropic.PermissionDeniedError) throw new Error('このAPIキーではこのモデルを使えません。');
      if (e instanceof Anthropic.RateLimitError) throw new Error('利用制限に達しました。少し待ってから再度お試しください。');
      if (e instanceof Anthropic.APIConnectionError) throw new Error('Claude API に接続できません。');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API エラー (${e.status}): ${e.message}`);
      throw e;
    }
  }

  /** Claude に問い合わせ、文章を少しずつ onText に渡す。完成した文章を返す。 */
  function run(opts) {
    if (settings.provider === 'local') return runLocal(opts);
    if (settings.provider === 'api') return runApi(opts);
    return Promise.reject(new Error('Claude 連携がオフです。'));
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

  /** 直前の手と局面を実況させるプロンプト */
  function commentaryPrompt({ board, toMove, analysis, last }) {
    const lines = [
      '現在の盤面:',
      boardText(board),
      '',
      lastMoveLine(last),
      factsLine(board),
    ];
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
    MODELS, SYSTEM, getSettings, save, enabled, run, testConnection,
    movePrompt, commentaryPrompt, parseMove, boardText,
  };
  global.OthelloClaude = Claude;
  if (typeof module !== 'undefined' && module.exports) module.exports = Claude;
})(typeof window !== 'undefined' ? window : globalThis);
