#!/usr/bin/env node
/*
 * claude-bridge.mjs — ローカルの Claude Code (claude コマンド) とブラウザをつなぐ小さなサーバー
 *
 * ・このフォルダのファイル（index.html など）を http://localhost:8787 で配信する
 * ・POST /api/claude で受け取ったプロンプトを `claude -p` に渡し、
 *   返ってくる文章を Server-Sent Events でブラウザへリアルタイムに流す
 *
 * `claude` コマンドにログインしているアカウント（Pro/Max など）で動くので、
 * APIキーは不要です。依存パッケージもありません（Node.js 18 以上）。
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

// 他のサイトからこのサーバーを勝手に使われないよう、許可するオリジンを限定する
// （"null" は index.html を file:// で直接開いた場合）
const ALLOWED_ORIGINS = new Set([
  'null',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

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
    execFile(CLAUDE_BIN, ['--version'], { timeout: 15000 }, (err, stdout) => {
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
  const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
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
  } else {
    console.log(`注意: "${CLAUDE_BIN}" コマンドが見つかりません。Claude Code をインストールし、\`claude\` でログインしてください。`);
  }
});
