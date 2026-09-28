"""
alphazero.py — オセロ用 AlphaZero（ニューラルネット + モンテカルロ木探索 + 自己対局学習）

・ネットワーク : 残差ネット（ResNet）。入力は手番側から見た盤面、出力は
                 方策 p（65手それぞれの確率）と価値 v（手番側の勝ちやすさ -1〜+1）
・探索        : PUCT によるモンテカルロ木探索（MCTS）。ルートにディリクレノイズ
・学習        : 自己対局の (局面, 探索の訪問回数分布 π, 最終結果 z) で
                 損失 (z - v)^2 - π·log p + L2 を最小化。盤の8対称で水増し
人間の棋譜や評価関数は一切使わず、ルールだけから強くなる。
"""
import base64
import math
import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from othello import N_ACTIONS, PASS, State, encode


# ---------------------------------------------------------------- ネットワーク
class ResBlock(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


class AZNet(nn.Module):
    def __init__(self, channels=64, blocks=4):
        super().__init__()
        self.channels = channels
        self.n_blocks = blocks
        self.stem = nn.Conv2d(3, channels, 3, padding=1, bias=False)
        self.stem_bn = nn.BatchNorm2d(channels)
        self.blocks = nn.ModuleList([ResBlock(channels) for _ in range(blocks)])
        # 方策ヘッド
        self.p_conv = nn.Conv2d(channels, 2, 1, bias=False)
        self.p_bn = nn.BatchNorm2d(2)
        self.p_fc = nn.Linear(2 * 64, N_ACTIONS)
        # 価値ヘッド
        self.v_conv = nn.Conv2d(channels, 1, 1, bias=False)
        self.v_bn = nn.BatchNorm2d(1)
        self.v_fc1 = nn.Linear(64, 64)
        self.v_fc2 = nn.Linear(64, 1)

    def forward(self, x):
        x = F.relu(self.stem_bn(self.stem(x)))
        for b in self.blocks:
            x = b(x)
        p = F.relu(self.p_bn(self.p_conv(x))).flatten(1)
        p = self.p_fc(p)  # logits
        v = F.relu(self.v_bn(self.v_conv(x))).flatten(1)
        v = torch.tanh(self.v_fc2(F.relu(self.v_fc1(v)))).squeeze(1)
        return p, v


# ---------------------------------------------------------------- 探索
class Node:
    __slots__ = ("state", "actions", "P", "N", "W", "children", "expanded", "noised")

    def __init__(self, state):
        self.state = state
        self.actions = None
        self.P = None
        self.N = None
        self.W = None
        self.children = None
        self.expanded = False
        self.noised = False

    def expand(self, policy_logits):
        acts = self.state.legal_actions()
        self.actions = acts
        if acts == [PASS]:
            self.P = np.ones(1, dtype=np.float64)
        else:
            lg = policy_logits[acts].astype(np.float64)
            lg -= lg.max()
            e = np.exp(lg)
            self.P = e / e.sum()
        self.N = np.zeros(len(acts), dtype=np.float64)
        self.W = np.zeros(len(acts), dtype=np.float64)
        self.children = [None] * len(acts)
        self.expanded = True

    def add_noise(self, alpha, eps):
        if len(self.actions) > 1:
            noise = np.random.dirichlet([alpha] * len(self.actions))
            self.P = (1 - eps) * self.P + eps * noise
        self.noised = True

    def select(self, c_puct):
        total = self.N.sum()
        q = np.where(self.N > 0, self.W / np.maximum(self.N, 1), 0.0)
        u = c_puct * self.P * math.sqrt(total + 1) / (1 + self.N)
        return int(np.argmax(q + u))


class MCTSConfig:
    def __init__(self, sims=100, c_puct=1.5, dir_alpha=0.5, dir_eps=0.25, noise=True):
        self.sims = sims
        self.c_puct = c_puct
        self.dir_alpha = dir_alpha
        self.dir_eps = dir_eps
        self.noise = noise


def descend(root, c_puct):
    """ルートから葉までたどる。(経路, 葉ノード) を返す。"""
    path = []
    node = root
    while node.expanded and not node.state.is_terminal():
        i = node.select(c_puct)
        path.append((node, i))
        child = node.children[i]
        if child is None:
            child = Node(node.state.play(node.actions[i]))
            node.children[i] = child
        node = child
    return path, node


def backup(path, v):
    """v は葉ノードの手番側から見た価値。1段上がるごとに符号が反転する。"""
    for node, i in reversed(path):
        v = -v
        node.N[i] += 1
        node.W[i] += v


@torch.no_grad()
def evaluate_batch(net, states):
    x = torch.from_numpy(np.stack([encode(s) for s in states]))
    logits, v = net(x)
    return logits.numpy(), v.numpy()


def run_mcts_batch(net, roots, cfg):
    """複数の木で同時に MCTS を進める（葉の評価をまとめて1回のネット計算にする）"""
    # 使い回した（展開済みの）ルートには探索の前にノイズを入れる
    if cfg.noise:
        for root in roots:
            if root.expanded and not root.noised:
                root.add_noise(cfg.dir_alpha, cfg.dir_eps)
    for _ in range(cfg.sims):
        pending = []
        for root in roots:
            path, leaf = descend(root, cfg.c_puct)
            if leaf.state.is_terminal():
                backup(path, float(leaf.state.result()))
            else:
                pending.append((root, path, leaf))
        if not pending:
            continue
        logits, values = evaluate_batch(net, [lf.state for _, _, lf in pending])
        for (root, path, leaf), lg, v in zip(pending, logits, values):
            if not leaf.expanded:
                leaf.expand(lg)
                if leaf is root and cfg.noise and not root.noised:
                    root.add_noise(cfg.dir_alpha, cfg.dir_eps)
            backup(path, float(v))


def visit_policy(root):
    pi = np.zeros(N_ACTIONS, dtype=np.float32)
    total = root.N.sum()
    for a, n in zip(root.actions, root.N):
        pi[a] = n / total
    return pi


def pick_action(root, temperature):
    if temperature <= 1e-6:
        best = np.flatnonzero(root.N == root.N.max())
        return int(random.choice(best))
    p = root.N ** (1.0 / temperature)
    p /= p.sum()
    return int(np.random.choice(len(p), p=p))


# ---------------------------------------------------------------- 自己対局
def self_play(net, n_games, cfg, temp_moves=12):
    """n_games 局を同時に自己対局し、学習データ [(入力, π, z)] を返す"""
    net.eval()
    games = [{"root": Node(State.initial()), "hist": [], "moves": 0} for _ in range(n_games)]
    active = list(games)
    data = []
    results = []
    while active:
        roots = [g["root"] for g in active]
        run_mcts_batch(net, roots, cfg)
        still = []
        for g in active:
            root = g["root"]
            pi = visit_policy(root)
            g["hist"].append((encode(root.state), pi, root.state.color))
            temp = 1.0 if g["moves"] < temp_moves else 0.0
            i = pick_action(root, temp)
            child = root.children[i]
            if child is None:
                child = Node(root.state.play(root.actions[i]))
            child.noised = False
            g["root"] = child
            g["moves"] += 1
            if child.state.is_terminal():
                s = child.state
                # 黒から見た結果
                r = s.result() * s.color
                results.append(r)
                for planes, pi_, color in g["hist"]:
                    data.append((planes, pi_, float(r * color)))
            else:
                still.append(g)
        active = still
    return data, results


# ---------------------------------------------------------------- 学習
def symmetries(planes, pi):
    """盤の8対称（回転・反転）"""
    board_pi = pi[:64].reshape(8, 8)
    out = []
    for k in range(4):
        for flip in (False, True):
            p = np.rot90(planes, k, axes=(1, 2))
            b = np.rot90(board_pi, k)
            if flip:
                p = p[:, :, ::-1]
                b = b[:, ::-1]
            out.append((np.ascontiguousarray(p), np.concatenate([b.reshape(64), pi[64:]])))
    return out


def random_symmetry(planes, pi):
    k = random.randrange(4)
    flip = random.random() < 0.5
    p = np.rot90(planes, k, axes=(1, 2))
    b = np.rot90(pi[:64].reshape(8, 8), k)
    if flip:
        p = p[:, :, ::-1]
        b = b[:, ::-1]
    return np.ascontiguousarray(p), np.concatenate([b.reshape(64), pi[64:]]).astype(np.float32)


def train_steps(net, opt, buffer, steps, batch_size=256):
    net.train()
    tot = {"loss": 0.0, "v": 0.0, "p": 0.0}
    for _ in range(steps):
        batch = random.sample(buffer, min(batch_size, len(buffer)))
        xs, pis, zs = [], [], []
        for planes, pi, z in batch:
            p, q = random_symmetry(planes, pi)
            xs.append(p)
            pis.append(q)
            zs.append(z)
        x = torch.from_numpy(np.stack(xs))
        target_pi = torch.from_numpy(np.stack(pis))
        target_z = torch.tensor(zs, dtype=torch.float32)
        logits, v = net(x)
        loss_v = F.mse_loss(v, target_z)
        loss_p = -(target_pi * F.log_softmax(logits, dim=1)).sum(1).mean()
        loss = loss_v + loss_p
        opt.zero_grad()
        loss.backward()
        opt.step()
        tot["loss"] += loss.item()
        tot["v"] += loss_v.item()
        tot["p"] += loss_p.item()
    return {k: v / steps for k, v in tot.items()}


# ---------------------------------------------------------------- 書き出し（ブラウザ用）
def fold_bn(conv_w, bn):
    """Conv(bias なし) + BatchNorm を、重みとバイアスを持つ1つの Conv にまとめる"""
    scale = bn.weight.detach() / torch.sqrt(bn.running_var + bn.eps)
    w = conv_w.detach() * scale.view(-1, 1, 1, 1)
    b = bn.bias.detach() - bn.running_mean * scale
    return w, b


def _b64(t):
    """float32 リトルエンディアンの base64 文字列（JSON を小さくするため）"""
    return base64.b64encode(t.detach().contiguous().numpy().astype("<f4").tobytes()).decode("ascii")


def export_weights(net):
    """JS で推論するための重み（BN を畳み込み済み）を dict で返す"""
    net.eval()
    layers = []

    def conv(conv_mod, bn):
        w, b = fold_bn(conv_mod.weight, bn)
        return {"w": _b64(w), "b": _b64(b),
                "out": w.shape[0], "in": w.shape[1], "k": w.shape[2]}

    layers.append(conv(net.stem, net.stem_bn))
    blocks = [{"c1": conv(b.c1, b.b1), "c2": conv(b.c2, b.b2)} for b in net.blocks]

    def lin(m):
        return {"w": _b64(m.weight), "b": _b64(m.bias),
                "out": m.weight.shape[0], "in": m.weight.shape[1]}

    return {
        "format": "othello-alphazero-v1-b64",
        "channels": net.channels,
        "blocks": net.n_blocks,
        "stem": layers[0],
        "res": blocks,
        "policy": {"conv": conv(net.p_conv, net.p_bn), "fc": lin(net.p_fc)},
        "value": {"conv": conv(net.v_conv, net.v_bn), "fc1": lin(net.v_fc1), "fc2": lin(net.v_fc2)},
    }
