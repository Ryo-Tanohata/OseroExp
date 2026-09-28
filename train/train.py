"""
train.py — AlphaZero の学習ループ

  python3 train/train.py --hours 3

1反復 = 自己対局（ワーカー並列）→ 学習 → チェックポイント保存。
チェックポイントは train/checkpoints/ に、ブラウザ用の重みは models/ に書き出す。
中断しても --resume で続きから再開できる。
"""
import argparse
import json
import multiprocessing as mp
import os
import random
import time
from collections import deque

import numpy as np
import torch

from alphazero import AZNet, MCTSConfig, export_weights, self_play, train_steps

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT_DIR = os.path.join(HERE, "checkpoints")
MODEL_DIR = os.path.join(HERE, "..", "models")


def worker(args):
    state_dict, n_games, sims, seed, channels, blocks = args
    torch.set_num_threads(1)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    net = AZNet(channels, blocks)
    net.load_state_dict(state_dict)
    return self_play(net, n_games, MCTSConfig(sims=sims))


def save_export(net, path, meta):
    w = export_weights(net)
    w["meta"] = meta
    with open(path, "w") as f:
        json.dump(w, f, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=3.0)
    ap.add_argument("--channels", type=int, default=64)
    ap.add_argument("--blocks", type=int, default=4)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--games", type=int, default=48, help="1ワーカーが1反復で打つ局数")
    ap.add_argument("--sims", type=int, default=80)
    ap.add_argument("--steps", type=int, default=250)
    ap.add_argument("--buffer", type=int, default=150_000)
    ap.add_argument("--export-every", type=int, default=5)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    os.makedirs(CKPT_DIR, exist_ok=True)
    os.makedirs(MODEL_DIR, exist_ok=True)
    torch.set_num_threads(args.workers)

    net = AZNet(args.channels, args.blocks)
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    buffer = deque(maxlen=args.buffer)
    it = 0
    total_games = 0
    log_path = os.path.join(HERE, "train_log.jsonl")
    latest = os.path.join(CKPT_DIR, "latest.pt")
    if args.resume and os.path.exists(latest):
        ck = torch.load(latest, weights_only=False)
        net.load_state_dict(ck["net"])
        opt.load_state_dict(ck["opt"])
        it = ck["iter"]
        total_games = ck["games"]
        buffer.extend(ck.get("buffer", []))
        print(f"再開: 反復 {it}, 自己対局 {total_games} 局, バッファ {len(buffer)}")

    deadline = time.time() + args.hours * 3600
    ctx = mp.get_context("fork")
    with ctx.Pool(args.workers) as pool:
        while time.time() < deadline:
            it += 1
            t0 = time.time()
            # 後半は学習率を下げる
            for g in opt.param_groups:
                g["lr"] = 1e-3 if it <= 60 else 3e-4
            sd = {k: v.cpu() for k, v in net.state_dict().items()}
            jobs = [(sd, args.games, args.sims, it * 1000 + w, args.channels, args.blocks)
                    for w in range(args.workers)]
            results = pool.map(worker, jobs)
            n_pos = 0
            outcomes = []
            for data, res in results:
                buffer.extend(data)
                n_pos += len(data)
                outcomes.extend(res)
            total_games += len(outcomes)
            t_play = time.time() - t0

            steps = args.steps if len(buffer) > 20_000 else args.steps // 3
            losses = train_steps(net, opt, list(buffer), steps)
            t_all = time.time() - t0
            black_rate = sum(1 for r in outcomes if r > 0) / len(outcomes)
            rec = {"iter": it, "games": total_games, "positions": n_pos, "buffer": len(buffer),
                   "loss": round(losses["loss"], 4), "loss_v": round(losses["v"], 4),
                   "loss_p": round(losses["p"], 4), "black_win": round(black_rate, 3),
                   "sec_play": round(t_play, 1), "sec_total": round(t_all, 1)}
            print(json.dumps(rec, ensure_ascii=False), flush=True)
            with open(log_path, "a") as f:
                f.write(json.dumps(rec) + "\n")

            torch.save({"net": net.state_dict(), "opt": opt.state_dict(), "iter": it,
                        "games": total_games, "channels": args.channels, "blocks": args.blocks},
                       os.path.join(CKPT_DIR, f"iter{it:04d}.pt"))
            torch.save({"net": net.state_dict(), "opt": opt.state_dict(), "iter": it,
                        "games": total_games, "buffer": list(buffer)[-50_000:],
                        "channels": args.channels, "blocks": args.blocks}, latest)
            if it % args.export_every == 0:
                meta = {"iter": it, "selfPlayGames": total_games}
                save_export(net, os.path.join(CKPT_DIR, f"iter{it:04d}.json"), meta)

    meta = {"iter": it, "selfPlayGames": total_games}
    save_export(net, os.path.join(CKPT_DIR, f"iter{it:04d}.json"), meta)
    print("学習終了", meta)


if __name__ == "__main__":
    main()
