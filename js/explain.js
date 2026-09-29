/*
 * explain.js — 局面の説明（解説）を生成する
 *
 * ・直前の手の評価（最善手／好手／疑問手…）と、その手の特徴
 * ・現在の形勢（評価値・勝率の目安）
 * ・石数・着手可能数・隅・確定石・壁 などの局面の要素
 * ・次の手番へのアドバイス（おすすめの手とその理由）
 */
(function (global) {
  'use strict';

  const O = global.Othello || (typeof require !== 'undefined' ? require('./game.js') : null);
  const AI = global.OthelloAI || (typeof require !== 'undefined' ? require('./ai.js') : null);
  const { BLACK, WHITE, EMPTY, CORNERS, X_SQUARES, C_SQUARES } = O;

  const N = O.toNotation;
  const name = O.colorName;

  function phaseOf(board) {
    const empties = AI.emptyCount(board);
    if (empties > 44) return { key: 'opening', label: '序盤', empties };
    if (empties > 16) return { key: 'middle', label: '中盤', empties };
    return { key: 'end', label: '終盤', empties };
  }

  /** 黒から見た評価値 → 勝率の目安 (0〜1) */
  function winRate(scoreBlack, exact) {
    if (exact) return scoreBlack > 0 ? 1 : scoreBlack < 0 ? 0 : 0.5;
    return 1 / (1 + Math.exp(-scoreBlack / 80));
  }

  /** 黒から見た評価値 → 形勢の文章 */
  function judgement(scoreBlack, exact) {
    if (exact) {
      const d = AI.decisiveDiscDiff(scoreBlack);
      if (d === 0) return { text: '読み切り：お互い最善なら引き分け', short: '引き分け' };
      const winner = d > 0 ? '黒' : '白';
      return { text: `読み切り：${winner}の勝ち（最善で${Math.abs(d)}石差）`, short: `${winner}勝ち` };
    }
    const a = Math.abs(scoreBlack);
    const side = scoreBlack > 0 ? '黒' : '白';
    if (a < 20) return { text: '互角の形勢', short: '互角' };
    if (a < 60) return { text: `${side}がやや有利`, short: `${side}やや有利` };
    if (a < 150) return { text: `${side}が有利`, short: `${side}有利` };
    return { text: `${side}が優勢（大きくリード）`, short: `${side}優勢` };
  }

  function formatScore(score, exact) {
    if (exact || AI.isDecisive(score)) {
      const d = AI.decisiveDiscDiff(score);
      return (d > 0 ? '+' : '') + d + '石';
    }
    return (score > 0 ? '+' : '') + score;
  }

  /** 手の品質を判定する（手を打つ前の解析結果と比べる） */
  function moveQuality(analysis, move) {
    if (!analysis || !analysis.candidates.length) return null;
    const cands = analysis.candidates;
    const best = cands[0].score;
    const found = cands.find(c => c.move === move);
    if (!found) return null;
    const rank = cands.indexOf(found) + 1;
    if (cands.length === 1) return { label: '唯一の手', cls: 'good', rank, loss: 0 };

    if (analysis.exact) {
      const bestD = AI.decisiveDiscDiff(best);
      const myD = AI.decisiveDiscDiff(found.score);
      const loss = bestD - myD;
      if (loss === 0) return { label: '最善手', cls: 'best', rank, loss, note: '読み切りでも最善の手です。' };
      if (bestD > 0 && myD <= 0) return { label: '悪手', cls: 'bad', rank, loss, note: `勝ちを逃す手でした（最善は ${N(cands[0].move)}）。` };
      if (bestD === 0 && myD < 0) return { label: '悪手', cls: 'bad', rank, loss, note: `引き分けを逃す手でした（最善は ${N(cands[0].move)}）。` };
      if (loss <= 4) return { label: '緩手', cls: 'ok', rank, loss, note: `最善の ${N(cands[0].move)} より ${loss}石 損しています。` };
      return { label: '疑問手', cls: 'dubious', rank, loss, note: `最善の ${N(cands[0].move)} より ${loss}石 損しています。` };
    }

    const loss = best - found.score;
    if (loss === 0) return { label: '最善手', cls: 'best', rank, loss, note: 'AIの読みでも一番良い手です。' };
    if (loss < 25) return { label: '好手', cls: 'good', rank, loss, note: `最善の ${N(cands[0].move)} とほぼ同等の良い手です。` };
    if (loss < 60) return { label: '緩手', cls: 'ok', rank, loss, note: `悪くはありませんが、${N(cands[0].move)} の方が良かったようです。` };
    if (loss < 150) return { label: '疑問手', cls: 'dubious', rank, loss, note: `形勢を損ねました。${N(cands[0].move)} が有力でした。` };
    return { label: '悪手', cls: 'bad', rank, loss, note: `大きく形勢を損ねました。${N(cands[0].move)} が有力でした。` };
  }

  /** 1手の特徴を調べる（盤面は打つ前の状態） */
  function moveFeatures(board, move, player) {
    const res = O.applyMove(board, move, player);
    const after = res.board;
    const type = O.squareType(move);
    const oppBefore = O.getLegalMoves(board, -player);
    const oppAfter = O.getLegalMoves(after, -player);
    const myAfter = O.getLegalMoves(after, player);
    const stableBefore = O.countStable(board);
    const stableAfter = O.countStable(after);
    const key = player === BLACK ? 'black' : 'white';
    const cornerFor = type === 'x' ? X_SQUARES[move] : type === 'c' ? C_SQUARES[move] : null;
    const givesCorner = CORNERS.filter(c => oppAfter.includes(c) && !oppBefore.includes(c));
    const quiet = res.flips.every(i => !O.touchesEmpty(after, i));
    return {
      type,
      flips: res.flips.length,
      after,
      oppMobBefore: oppBefore.length,
      oppMobAfter: oppAfter.length,
      forcesPass: oppAfter.length === 0 && myAfter.length > 0,
      endsGame: oppAfter.length === 0 && myAfter.length === 0,
      cornerEmpty: cornerFor !== null && board[cornerFor] === EMPTY,
      cornerFor,
      givesCorner,
      quiet,
      stableGain: stableAfter[key] - stableBefore[key],
    };
  }

  /** 手の特徴を文章の配列にする */
  function featureSentences(f, player) {
    const s = [];
    const opp = name(-player);
    switch (f.type) {
      case 'corner':
        s.push('隅を取りました。隅の石は二度と返されない「確定石」になり、辺を広げる足場になります。');
        break;
      case 'x':
        if (f.cornerEmpty) s.push(`X打ち（隅 ${N(f.cornerFor)} の斜め隣）です。隅を相手に取られやすくなる危険な手です。`);
        else s.push('X打ちですが、隣の隅はすでに埋まっているので危険は小さいです。');
        break;
      case 'c':
        if (f.cornerEmpty) s.push(`C打ち（隅 ${N(f.cornerFor)} の隣の辺）です。状況によっては隅を狙われます。`);
        else s.push('隅が埋まった後の辺の手で、確定石を増やしやすい手です。');
        break;
      case 'edge':
        s.push('辺に打ちました。辺の石は返されにくく安定しやすい一方、相手に辺の攻めのきっかけを与えることもあります。');
        break;
      default:
        break;
    }
    if (f.quiet && f.type === 'inner') {
      s.push('返した石がすべて内側にある「中割り」です。相手の打てる場所を増やさない好形の手です。');
    }
    if (f.flips >= 6 && !f.endsGame) {
      s.push(`${f.flips}個も返しました。ただしオセロは序盤・中盤で石を多く取ると、相手の打てる場所が増えて不利になりがちです。`);
    } else if (f.flips <= 2 && !f.quiet) {
      s.push(`返したのは${f.flips}個だけの控えめな手です。`);
    }
    if (f.stableGain >= 3) s.push(`確定石が${f.stableGain}個増えました。`);
    if (f.endsGame) {
      s.push('この手で両者とも打てる場所がなくなり、対局終了です。');
    } else if (f.forcesPass) {
      s.push(`${opp}は打てる場所がなくなり、パスになります！`);
    } else if (f.oppMobAfter < f.oppMobBefore - 2) {
      s.push(`${opp}の打てる場所を ${f.oppMobBefore} → ${f.oppMobAfter} に減らしました。`);
    } else if (f.oppMobAfter > f.oppMobBefore + 3) {
      s.push(`${opp}の打てる場所が ${f.oppMobBefore} → ${f.oppMobAfter} に増えてしまいました。`);
    }
    if (f.givesCorner.length) {
      s.push(`${opp}に隅 ${f.givesCorner.map(N).join('・')} を取るチャンスを与えています。`);
    }
    return s;
  }

  /** 候補手の短い理由 */
  function shortReason(board, move, player) {
    const f = moveFeatures(board, move, player);
    const tags = [];
    if (f.type === 'corner') tags.push('隅を取る');
    if (f.type === 'x' && f.cornerEmpty) tags.push('X打ち(危険)');
    if (f.type === 'c' && f.cornerEmpty) tags.push('C打ち');
    if (f.type === 'edge') tags.push('辺');
    if (f.forcesPass) tags.push('相手をパスさせる');
    if (f.givesCorner.length) tags.push('隅を与える');
    if (f.quiet && f.type === 'inner') tags.push('中割り');
    tags.push(`${f.flips}個返す`);
    tags.push(`相手の手 ${f.oppMobAfter}`);
    return tags.join(' / ');
  }

  /** 局面の要素を集計する */
  function positionFacts(board) {
    const discs = O.countDiscs(board);
    const stable = O.countStable(board);
    const frontier = O.countFrontier(board);
    const corners = { black: 0, white: 0 };
    for (const c of CORNERS) {
      if (board[c] === BLACK) corners.black++;
      else if (board[c] === WHITE) corners.white++;
    }
    const mobility = {
      black: O.getLegalMoves(board, BLACK).length,
      white: O.getLegalMoves(board, WHITE).length,
    };
    return { discs, stable, frontier, corners, mobility, phase: phaseOf(board) };
  }

  /** 局面の要素から読み取れるポイントを文章にする */
  function factSentences(facts) {
    const s = [];
    const { discs, stable, frontier, corners, mobility, phase } = facts;
    const cmp = (b, w) => (b > w ? '黒' : '白');

    if (phase.key === 'opening') {
      s.push('序盤は石の数より「相手の打てる場所を減らす」「壁を作らない」ことが大切です。');
    } else if (phase.key === 'middle') {
      s.push('中盤は隅の取り合いと、打てる場所（着手可能数）の多さが勝負を分けます。');
    } else {
      s.push(`終盤です（残り${phase.empties}マス）。ここからは確定石と最終的な石数が重要になります。`);
    }

    if (mobility.black !== mobility.white) {
      const more = cmp(mobility.black, mobility.white);
      const diff = Math.abs(mobility.black - mobility.white);
      if (diff >= 3) s.push(`打てる場所は ${more} の方が ${diff} か所多く、${more}が主導権を握っています。`);
    }
    if (corners.black || corners.white) {
      if (corners.black !== corners.white) {
        s.push(`隅は 黒${corners.black}：白${corners.white} で、${cmp(corners.black, corners.white)}が隅でリードしています。`);
      } else {
        s.push(`隅は 黒${corners.black}：白${corners.white} で並んでいます。`);
      }
    }
    if (stable.black + stable.white > 0 && Math.abs(stable.black - stable.white) >= 3) {
      s.push(`確定石は 黒${stable.black}：白${stable.white}。${cmp(stable.black, stable.white)}の石は簡単には返されません。`);
    }
    if (phase.key !== 'end' && Math.abs(frontier.black - frontier.white) >= 4) {
      const heavy = cmp(frontier.black, frontier.white);
      s.push(`${heavy}は空きマスに接する石（壁）が多く、相手に打つ場所を与えやすい形です。`);
    }
    if (phase.key !== 'end' && Math.abs(discs.black - discs.white) >= 10) {
      const many = cmp(discs.black, discs.white);
      s.push(`石数は${many}が多いですが、この段階では石が多いこと自体は有利とは限りません。`);
    }
    return s;
  }

  /**
   * 局面全体の解説を作る
   * @param {number[]} board 現在の盤面
   * @param {number} toMove 次の手番（対局終了時は 0）
   * @param {object|null} analysis 次の手番側から見た探索結果
   * @param {object|null} last 直前の手の情報 {player, move, boardBefore, analysisBefore} / {player, pass:true}
   */
  function describe(board, toMove, analysis, last) {
    const facts = positionFacts(board);
    const out = { facts, phase: facts.phase, lastMove: null, evaluation: null, points: [], advice: null };

    // 直前の手
    if (last && last.pass) {
      out.lastMove = { title: `${name(last.player)}はパス`, quality: null, sentences: [`${name(last.player)}は打てる場所がないためパスしました。`] };
    } else if (last) {
      const f = moveFeatures(last.boardBefore, last.move, last.player);
      const q = moveQuality(last.analysisBefore, last.move);
      const sentences = featureSentences(f, last.player);
      if (q && q.note) sentences.unshift(q.note);
      out.lastMove = { title: `${name(last.player)} ${N(last.move)}（${f.flips}個返し）`, quality: q, sentences };
    }

    // 形勢
    if (toMove === 0) {
      const { black, white } = facts.discs;
      const result = black > white ? `黒の勝ち（${black} 対 ${white}）` : white > black ? `白の勝ち（${white} 対 ${black}）` : `引き分け（${black} 対 ${white}）`;
      out.evaluation = { scoreBlack: black - white, exact: true, text: `対局終了：${result}`, short: '終局', winRate: black > white ? 1 : black < white ? 0 : 0.5 };
    } else if (analysis && analysis.candidates.length) {
      const scoreBlack = analysis.score * toMove;
      const j = judgement(scoreBlack, analysis.exact);
      out.evaluation = {
        scoreBlack,
        exact: analysis.exact,
        text: j.text,
        short: j.short,
        winRate: winRate(scoreBlack, analysis.exact),
        display: '黒から見て ' + formatScore(scoreBlack, analysis.exact),
      };
    }

    out.points = factSentences(facts);

    // 次の手番へのアドバイス
    if (toMove !== 0 && analysis && analysis.candidates.length) {
      const top = analysis.candidates.slice(0, 3).map(c => ({
        move: c.move,
        notation: N(c.move),
        score: c.score,
        scoreText: formatScore(c.score, analysis.exact),
        reason: shortReason(board, c.move, toMove),
      }));
      const best = top[0];
      const bestF = moveFeatures(board, best.move, toMove);
      let text = `${name(toMove)}の番です。AIのおすすめは ${best.notation}。`;
      if (bestF.type === 'corner') text += '隅を取れるチャンスです！';
      else if (bestF.forcesPass) text += '相手をパスに追い込めます。';
      else if (bestF.quiet && bestF.type === 'inner') text += '相手の打てる場所を増やさない静かな手です。';
      else text += `打った後、相手の打てる場所は ${bestF.oppMobAfter} か所になります。`;
      const moves = analysis.candidates.length;
      if (moves <= 2) text += `（打てる場所が${moves}か所しかなく苦しい局面です）`;
      const dangerous = analysis.candidates.filter(c => O.squareType(c.move) === 'x' && moveFeatures(board, c.move, toMove).cornerEmpty);
      if (dangerous.length) text += ` X打ち（${dangerous.map(c => N(c.move)).join('・')}）には注意しましょう。`;
      out.advice = { text, candidates: top };
    }
    return out;
  }

  /**
   * 言語モデルを使わない「内蔵の実況」。事実と AlphaZero の読みから3〜5文の実況を組み立てる。
   * @param {object|null} az 直前の手を打った AlphaZero の探索結果 {player, stats}
   */
  function narrate(board, toMove, analysis, last, az) {
    const out = [];
    const facts = positionFacts(board);
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];

    if (last && last.pass) {
      out.push(`${name(last.player)}は打てる場所がなく、パスです。`);
    } else if (last && last.boardBefore) {
      const f = moveFeatures(last.boardBefore, last.move, last.player);
      const q = moveQuality(last.analysisBefore, last.move);
      const who = name(last.player);
      let s = pick([`${who}は ${N(last.move)} に打ちました。`, `${who}、${N(last.move)} です。`, `${who}の手は ${N(last.move)}。`]);
      if (q) {
        const best = last.analysisBefore.candidates[0];
        if (q.label === '最善手') s += pick(['読みでも最善の一手です。', 'これは最善手です。']);
        else if (q.label === '好手') s += '最善とほぼ同等の好手です。';
        else if (q.label === '唯一の手') s += 'ここはこれしか打てる場所がありませんでした。';
        else if (q.label === '緩手') s += `少し緩い手で、${N(best.move)} の方が良かったようです。`;
        else s += `これは${q.label}で、${N(best.move)} が有力でした。`;
      }
      out.push(s);

      // 手の特徴から一番大事なものを1〜2つ
      const notes = [];
      if (f.type === 'corner') notes.push('隅を取ったので、この石はもう返されません。');
      if (f.type === 'x' && f.cornerEmpty) notes.push(`隅 ${N(f.cornerFor)} の斜め隣に入るX打ちで、隅を狙われる危険があります。`);
      if (f.forcesPass) notes.push(`${name(-last.player)}を打てる場所のない状態に追い込み、パスさせます！`);
      if (f.givesCorner.length) notes.push(`ただ、${name(-last.player)}に隅 ${f.givesCorner.map(N).join('・')} を取られるチャンスを与えました。`);
      if (!notes.length && f.quiet && f.type === 'inner') notes.push('内側の石だけを返す中割りで、相手に打つ場所を与えない好形です。');
      if (!notes.length && f.oppMobAfter < f.oppMobBefore - 2) notes.push(`相手の打てる場所を ${f.oppMobBefore} から ${f.oppMobAfter} に減らしました。`);
      if (!notes.length && f.flips >= 6 && !f.endsGame) notes.push(`${f.flips}個も返しましたが、石を取りすぎると相手の打てる場所が増えがちです。`);
      out.push(...notes.slice(0, 2));
    }

    if (az && az.stats) {
      const st = az.stats;
      const top = st.moves[0];
      const wr = Math.round(st.winRate * 100);
      out.push(top && top.share >= 0.6
        ? `AlphaZero は打つ前に自分の勝率を約${wr}%と見て、${N(top.move)} に探索の${Math.round(top.share * 100)}%を集中させていました。`
        : `AlphaZero は打つ前に自分の勝率を約${wr}%と見ていました。`);
    }

    if (toMove === 0) {
      const { black, white } = facts.discs;
      if (black === white) out.push(`対局終了、${black}対${white}の引き分けです。`);
      else {
        const winner = black > white ? '黒' : '白';
        out.push(`対局終了、${Math.max(black, white)}対${Math.min(black, white)}で${winner}の勝ちです。`);
        const c = black > white ? facts.corners.black : facts.corners.white;
        if (c >= 2) out.push(`隅を${c}つ押さえたことが勝因のひとつでしょう。`);
      }
      return out.join('');
    }

    if (analysis && analysis.candidates.length) {
      const j = judgement(analysis.score * toMove, analysis.exact);
      out.push(analysis.exact ? `終局まで読み切ると、${j.text.replace('読み切り：', '')}です。` : `形勢は${j.text.replace('の形勢', '')}です。`);
      const best = analysis.candidates[0];
      const bf = moveFeatures(board, best.move, toMove);
      let s = `次の${name(toMove)}は ${N(best.move)} が有力です。`;
      if (bf.type === 'corner') s = `次の${name(toMove)}は ${N(best.move)} で隅を取れます。`;
      else if (bf.forcesPass) s += '相手をパスに追い込める手です。';
      out.push(s);
    }
    const m = facts.mobility;
    if (Math.abs(m.black - m.white) >= 4) {
      out.push(`打てる場所は黒${m.black}・白${m.white}で、${m.black > m.white ? '黒' : '白'}が主導権を握っています。`);
    }
    return out.join('');
  }

  const Commentary = { describe, narrate, moveQuality, moveFeatures, featureSentences, shortReason, positionFacts, judgement, winRate, formatScore, phaseOf };

  global.OthelloCommentary = Commentary;
  if (typeof module !== 'undefined' && module.exports) module.exports = Commentary;
})(typeof window !== 'undefined' ? window : globalThis);
