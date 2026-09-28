"""
evaluate.py — 学習した AlphaZero の強さを測る・AlphaZero 同士を対戦させる

  # 各世代を αβ探索AI（アプリの「普通」「強い」「最強」）と対戦させる
  python3 train/evaluate.py ladder --iters 5 10 20 40 --levels 2 3 4 --games 20

  # 十分に強くなった AlphaZero 同士の対戦（棋譜を保存）
  python3 train/evaluate.py showdown --a 110 --b 110 --games 20 --sims 400

序盤の数手はランダムに打って局面を散らし、同じ対局ばかりにならないようにする。
AlphaZero 側は探索ノイズなし・訪問回数最大の手（本気モード）で打つ。
"""
import argparse
import json
import os
import random
import subprocess
import time

import torch

from alphazero import AZNet, MCTSConfig, Node, pick_action, run_mcts_batch
from othello import PASS, State, bits

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT_DIR = os.path.join(HERE, "checkpoints")


def load_net(it):
    path = os.path.join(CKPT_DIR, "latest.pt" if it == "latest" else f"iter{int(it):04d}.pt")
    ck = torch.load(path, weights_only=False)
    net = AZNet(ck["channels"], ck["blocks"])
    net.load_state_dict(ck["net"])
    net.eval()
    return net, ck["iter"], ck["games"]


def to_js_board(s):
    black, white = s.black_white()
    board = [0] * 64
    for i in bits(black):
        board[i] = 1
    for i in bits(white):
        board[i] = -1
    return board


class AlphaBeta:
    """ js/ai.js を子プロセスで動かす """

    def __init__(self):
        self.p = subprocess.Popen(["node", os.path.join(HERE, "ab_server.js")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def move(self, s, level):
        self.p.stdin.write(json.dumps({"board": to_js_board(s), "player": s.color, "level": level}) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())["move"]

    def close(self):
        self.p.stdin.close()
        self.p.wait()


def notation(a):
    return "pass" if a == PASS else "abcdefgh"[a % 8] + str(a // 8 + 1)


def random_opening(n_plies, rng):
    s = State.initial()
    moves = []
    for _ in range(n_plies):
        acts = s.legal_actions()
        a = rng.choice(acts)
        moves.append(a)
        s = s.play(a)
    return s, moves


def play_games(players, n_games, sims, opening_plies=4, seed=0):
    """
    players: {"A": (種類, 設定), "B": ...}  種類は "az"（net）か "ab"（level）
    偶数局目は A が黒、奇数局目は B が黒。結果は A から見た勝敗で返す。
    """
    rng = random.Random(seed)
    ab = AlphaBeta() if any(kind == "ab" for kind, _ in players.values()) else None
    cfg = MCTSConfig(sims=sims, noise=False)
    games = []
    for g in range(n_games):
        s, moves = random_opening(opening_plies, rng)
        black = "A" if g % 2 == 0 else "B"
        games.append({"state": s, "moves": moves, "black": black, "opening": opening_plies})
    active = list(games)
    while active:
        # 手番ごとに「誰が打つか」で分ける
        by_player = {"A": [], "B": []}
        for g in active:
            s = g["state"]
            side = g["black"] if s.color == 1 else ("B" if g["black"] == "A" else "A")
            by_player[side].append(g)
        for side, gs in by_player.items():
            if not gs:
                continue
            kind, conf = players[side]
            forced = [g for g in gs if g["state"].legal_actions() == [PASS]]
            for g in forced:
                g["next"] = PASS
            gs = [g for g in gs if g not in forced]
            if not gs:
                continue
            if kind == "az":
                roots = [Node(g["state"]) for g in gs]
                run_mcts_batch(conf, roots, cfg)
                for g, r in zip(gs, roots):
                    g["next"] = r.actions[pick_action(r, 0)]
            else:
                for g in gs:
                    g["next"] = ab.move(g["state"], conf)
        still = []
        for g in active:
            a = g.pop("next")
            g["moves"].append(a)
            g["state"] = g["state"].play(a)
            if not g["state"].is_terminal():
                still.append(g)
        active = still
    if ab:
        ab.close()

    out = []
    for g in games:
        s = g["state"]
        b, w = s.black_white()
        nb, nw = bin(b).count("1"), bin(w).count("1")
        a_is_black = g["black"] == "A"
        a_disc, b_disc = (nb, nw) if a_is_black else (nw, nb)
        out.append({
            "black": g["black"], "blackDiscs": nb, "whiteDiscs": nw,
            "resultA": (a_disc > b_disc) - (a_disc < b_disc),
            "moves": [notation(a) for a in g["moves"]], "openingPlies": g["opening"],
        })
    return out


def summarize(results):
    w = sum(1 for r in results if r["resultA"] > 0)
    d = sum(1 for r in results if r["resultA"] == 0)
    l = sum(1 for r in results if r["resultA"] < 0)
    return {"win": w, "draw": d, "loss": l, "score": round((w + 0.5 * d) / len(results), 3)}


def cmd_ladder(args):
    torch.set_num_threads(args.threads)
    rows = []
    for it in args.iters:
        net, real_it, games = load_net(it)
        for lv in args.levels:
            t0 = time.time()
            res = play_games({"A": ("az", net), "B": ("ab", lv)}, args.games, args.sims, seed=lv)
            row = {"iter": real_it, "selfPlayGames": games, "level": lv, **summarize(res),
                   "sims": args.sims, "sec": round(time.time() - t0, 1)}
            print(json.dumps(row, ensure_ascii=False), flush=True)
            rows.append(row)
    if args.out:
        with open(args.out, "w") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)


def cmd_showdown(args):
    torch.set_num_threads(args.threads)
    net_a, it_a, games_a = load_net(args.a)
    net_b, it_b, games_b = load_net(args.b)
    t0 = time.time()
    res = play_games({"A": ("az", net_a), "B": ("az", net_b)}, args.games, args.sims,
                     opening_plies=args.opening, seed=7)
    summary = {"a": {"iter": it_a, "selfPlayGames": games_a}, "b": {"iter": it_b, "selfPlayGames": games_b},
               "sims": args.sims, **summarize(res), "sec": round(time.time() - t0, 1)}
    print(json.dumps(summary, ensure_ascii=False))
    black_wins = sum(1 for r in res if r["blackDiscs"] > r["whiteDiscs"])
    draws = sum(1 for r in res if r["blackDiscs"] == r["whiteDiscs"])
    print(f"黒番の勝ち {black_wins} / 引き分け {draws} / 白番の勝ち {len(res) - black_wins - draws}")
    if args.out:
        with open(args.out, "w") as f:
            json.dump({"summary": summary, "games": res}, f, ensure_ascii=False, indent=1)
    if args.js:
        # アプリの「対局の再生」で見られるようにする
        names = {"A": f"AlphaZero 反復{it_a}", "B": f"AlphaZero 反復{it_b}"}
        if it_a == it_b:
            names = {"A": f"AlphaZero 反復{it_a}・A", "B": f"AlphaZero 反復{it_b}・B"}
        data = {"summary": summary, "names": names, "games": res}
        with open(args.js, "w") as f:
            f.write("/* 自動生成: train/evaluate.py showdown （AlphaZero 同士の対局記録） */\n")
            f.write("window.OTHELLO_SHOWDOWN = " + json.dumps(data, ensure_ascii=False) + ";\n")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("ladder")
    p1.add_argument("--iters", nargs="+", required=True)
    p1.add_argument("--levels", nargs="+", type=int, default=[2, 3, 4])
    p1.add_argument("--games", type=int, default=20)
    p1.add_argument("--sims", type=int, default=200)
    p1.add_argument("--threads", type=int, default=4)
    p1.add_argument("--out")
    p2 = sub.add_parser("showdown")
    p2.add_argument("--a", required=True)
    p2.add_argument("--b", required=True)
    p2.add_argument("--games", type=int, default=20)
    p2.add_argument("--sims", type=int, default=400)
    p2.add_argument("--opening", type=int, default=4)
    p2.add_argument("--threads", type=int, default=4)
    p2.add_argument("--out")
    p2.add_argument("--js", help="アプリで再生するための models/showdown.js の出力先")
    args = ap.parse_args()
    cmd_ladder(args) if args.cmd == "ladder" else cmd_showdown(args)


if __name__ == "__main__":
    main()
