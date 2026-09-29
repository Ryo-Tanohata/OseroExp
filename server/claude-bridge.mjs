#!/usr/bin/env node
/*
 * claude-bridge.mjs — ローカルの Claude Code (claude コマンド) とブラウザをつなぐ小さなサーバー
 *
 * ・このフォルダのファイル（index.html など）を http://localhost:8787 で配信する
 * ・POST /api/llm で、ローカルで動く無料の言語モデル（Ollama / LM Studio など）に中継する
 * ・POST /api/claude で受け取ったプロンプトを `claude -p` に渡し、
 *   返ってくる文章を Server-Sent Events でブラウザへリアルタイムに流す
 *
 * `claude` コマンドにログインしているアカウント（Pro/Max など）で動くので、
 * APIキーは不要です。依存パッケージもありません（Node.js 18 以上）。
 * 環境変数に APIキーが設定されていても、従量課金にならないよう claude には渡しません。
 *
 *   使い方:  node server/claude-bridge.mjs   → ブラウザで http://localhost:8787
 *   環境変数: PORT（既定 8787）, CLAUDE_BIN（既定 "claude"）
 */
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = '127.0.0.1';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 64 * 1024;

// APIキー系の環境変数を取り除き、必ずログイン中のアカウント（サブスクリプション）で動かす
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !API_KEY_VARS.includes(k)),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

// 他のサイトからこのサーバーを勝手に使われないよう、許可するオリジンを
// このサーバー自身（http://localhost:8787）だけに限定する。
// "null"（file:// やサンドボックス化された iframe）は、悪意あるサイトからも名乗れるので許可しない。
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
// DNS リバインディング対策: Host ヘッダーもこのパソコン宛てのものだけ受け付ける
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function originAllowed(req) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;
  return !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(req, res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req) });
  res.end(JSON.stringify(obj));
}

function claudeVersion() {
  return new Promise(resolve => {
    execFile(CLAUDE_BIN, ['--version'], { timeout: 15000, env: CHILD_ENV }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/** claude -p を起動し、文章の断片を SSE で流す */
function streamClaude(req, res, { prompt, system, model }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',               // ファイル操作やコマンド実行はさせない
    '--no-session-persistence',
  ];
  if (system) args.push('--system-prompt', system);
  if (model) args.push('--model', model);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...corsHeaders(req),
  });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // リポジトリの CLAUDE.md などを読み込まないよう、一時ディレクトリで実行する
  const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env: CHILD_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let finished = false;
  let gotText = false;

  child.stdin.end(prompt);
  child.stderr.on('data', d => { stderr += d.toString(); });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        gotText = true;
        send({ type: 'text', text: ev.delta.text });
      } else if (ev.type === 'message_start' && ev.message && ev.message.model) {
        send({ type: 'model', model: ev.message.model });
      }
    } else if (msg.type === 'result') {
      if (msg.is_error) send({ type: 'error', message: msg.result || 'Claude からエラーが返りました' });
      else if (!gotText && typeof msg.result === 'string') send({ type: 'text', text: msg.result });
    }
  });

  child.on('error', err => {
    if (finished) return;
    finished = true;
    send({ type: 'error', message: `claude コマンドを起動できません: ${err.message}` });
    res.end();
  });
  child.on('close', code => {
    if (finished) return;
    finished = true;
    if (code !== 0 && !gotText) {
      send({ type: 'error', message: (stderr.trim() || `claude が終了コード ${code} で終了しました`).slice(0, 500) });
    }
    send({ type: 'done' });
    res.end();
  });

  // ブラウザ側が中断したら claude も止める
  res.on('close', () => {
    if (!finished) { finished = true; child.kill('SIGTERM'); }
  });
}

// ---------------------------------------------------------------- ローカル LLM（無料）
// 中継先はこのパソコン上のサーバーだけに限定する
const LLM_DEFAULTS = { ollama: 'http://127.0.0.1:11434', openai: 'http://127.0.0.1:1234/v1' };

function llmBase(provider, base) {
  const url = new URL(base || LLM_DEFAULTS[provider]);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('中継できるのはこのパソコン上（localhost）の言語モデルサーバーだけです');
  }
  return url.toString().replace(/\/+$/, '');
}

async function listLlmModels(provider, base) {
  const root = llmBase(provider, base);
  if (provider === 'ollama') {
    const r = await fetch(root + '/api/tags');
    if (!r.ok) throw new Error(`Ollama がエラーを返しました (${r.status})`);
    return (await r.json()).models.map(m => m.name);
  }
  const r = await fetch(root + '/models');
  if (!r.ok) throw new Error(`サーバーがエラーを返しました (${r.status})`);
  return (await r.json()).data.map(m => m.id);
}

/** 1行ずつ届くストリーム（NDJSON / SSE）を読む */
async function* lines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

async function streamLlm(req, res, { provider, base, model, system, prompt, temperature }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...corsHeaders(req),
  });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  try {
    const root = llmBase(provider, base);
    let r;
    if (provider === 'ollama') {
      r = await fetch(root + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // num_ctx: お手本入りのプロンプトが既定の長さ(2048トークン)で切り捨てられないよう広げる
        body: JSON.stringify({ model, messages, stream: true, options: { temperature, num_ctx: 8192 } }),
        signal: ac.signal,
      });
    } else {
      r = await fetch(root + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, temperature }),
        signal: ac.signal,
      });
    }
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`言語モデルのサーバーがエラーを返しました (${r.status}): ${t.slice(0, 200)}`);
    }
    for await (const line of lines(r.body)) {
      if (provider === 'ollama') {
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message && j.message.content) send({ type: 'text', text: j.message.content });
      } else {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        const j = JSON.parse(data);
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) send({ type: 'text', text: t });
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      const msg = e.cause && e.cause.code === 'ECONNREFUSED'
        ? '言語モデルのサーバーに接続できません。Ollama / LM Studio が起動しているか確認してください。'
        : e.message;
      send({ type: 'error', message: msg });
    }
  }
  send({ type: 'done' });
  res.end();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) || rel.includes('/.')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    if (!originAllowed(req)) { res.writeHead(403); res.end('Forbidden origin'); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); res.end(); return; }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      const version = await claudeVersion();
      sendJson(req, res, 200, { ok: !!version, version });
      return;
    }
    if (url.pathname === '/api/llm/models' && req.method === 'GET') {
      try {
        const models = await listLlmModels(url.searchParams.get('provider') || 'ollama', url.searchParams.get('base') || '');
        sendJson(req, res, 200, { ok: true, models });
      } catch (e) {
        const msg = e.cause && e.cause.code === 'ECONNREFUSED'
          ? '言語モデルのサーバーに接続できません。Ollama / LM Studio が起動しているか確認してください。'
          : e.message;
        sendJson(req, res, 200, { ok: false, error: msg });
      }
      return;
    }
    if (url.pathname === '/api/llm' && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        sendJson(req, res, 415, { error: 'application/json で送ってください' });
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch {
        sendJson(req, res, 400, { error: '不正なリクエストです' });
        return;
      }
      const provider = body.provider === 'openai' ? 'openai' : 'ollama';
      if (typeof body.prompt !== 'string' || !body.prompt || typeof body.model !== 'string' || !body.model) {
        sendJson(req, res, 400, { error: 'prompt と model が必要です' });
        return;
      }
      streamLlm(req, res, {
        provider,
        base: typeof body.base === 'string' ? body.base : '',
        model: body.model.slice(0, 200),
        system: typeof body.system === 'string' ? body.system.slice(0, 16000) : '',
        prompt: body.prompt,
        temperature: typeof body.temperature === 'number' ? Math.min(Math.max(body.temperature, 0), 2) : 0.3,
      });
      return;
    }
    if (url.pathname === '/api/claude' && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        sendJson(req, res, 415, { error: 'application/json で送ってください' });
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch {
        sendJson(req, res, 400, { error: '不正なリクエストです' });
        return;
      }
      if (typeof body.prompt !== 'string' || !body.prompt) {
        sendJson(req, res, 400, { error: 'prompt が必要です' });
        return;
      }
      const model = typeof body.model === 'string' && /^[\w.\-\[\]]{1,64}$/.test(body.model) ? body.model : '';
      const system = typeof body.system === 'string' ? body.system.slice(0, 8000) : '';
      streamClaude(req, res, { prompt: body.prompt, system, model });
      return;
    }
    sendJson(req, res, 404, { error: 'not found' });
    return;
  }

  if (req.method === 'GET') { serveStatic(req, res); return; }
  res.writeHead(405); res.end();
});

server.listen(PORT, HOST, async () => {
  const version = await claudeVersion();
  console.log(`AIオセロ: http://localhost:${PORT} をブラウザで開いてください`);
  if (version) {
    console.log(`Claude Code を検出しました (${version})。ログイン中のアカウントで Claude が動きます。`);
    if (API_KEY_VARS.some(k => process.env[k])) {
      console.log('環境変数の APIキーは使わず、ログイン中のアカウントで動かします（従量課金にはなりません）。');
    }
  } else {
    console.log(`注意: "${CLAUDE_BIN}" コマンドが見つかりません。Claude Code をインストールし、\`claude\` でログインしてください。`);
  }
});
