"""
export_model.py — チェックポイントをブラウザ用の重みファイル（models/*.js）に書き出す

  python3 train/export_model.py --iter 110 --name az       → models/alphazero.js
  python3 train/export_model.py --iter 20  --name az-mid   → models/alphazero-mid.js

.js 形式にしているのは、index.html をダブルクリックで開いた場合（file://）でも
<script> で読み込めるようにするため。
"""
import argparse
import json
import os

import torch

from alphazero import AZNet, export_weights

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = {"az": "alphazero.js", "az-mid": "alphazero-mid.js"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iter", required=True, help="反復番号 または latest")
    ap.add_argument("--name", choices=list(FILES), default="az")
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    name = "latest.pt" if args.iter == "latest" else f"iter{int(args.iter):04d}.pt"
    ck = torch.load(os.path.join(HERE, "checkpoints", name), weights_only=False)
    net = AZNet(ck["channels"], ck["blocks"])
    net.load_state_dict(ck["net"])
    w = export_weights(net)
    w["meta"] = {"iter": ck["iter"], "selfPlayGames": ck["games"], "note": args.note}
    body = json.dumps(w, separators=(",", ":"))
    out = os.path.join(HERE, "..", "models", FILES[args.name])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        f.write("/* 自動生成: train/export_model.py （AlphaZero の学習済み重み） */\n")
        f.write("(function (g) {\n")
        f.write("  var data = " + body + ";\n")
        f.write(f"  g.OTHELLO_AZ_MODELS = g.OTHELLO_AZ_MODELS || {{}};\n")
        f.write(f"  g.OTHELLO_AZ_MODELS[{json.dumps(args.name)}] = data;\n")
        f.write("  if (typeof module !== 'undefined' && module.exports) module.exports = data;\n")
        f.write("})(typeof window !== 'undefined' ? window : globalThis);\n")
    print(f"{out} に書き出しました（反復 {ck['iter']}, 自己対局 {ck['games']} 局, {os.path.getsize(out) // 1024} KB）")


if __name__ == "__main__":
    main()
