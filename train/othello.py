"""
othello.py — 学習用の高速なオセロのルール（ビットボード）

盤面は「手番側の石」P と「相手の石」O の2つの64ビット整数で持つ。
ビット i はマス index i = row * 8 + col（JS 版 js/game.js と同じ並び）。
行動は 0〜63 がマス、64 がパス。
"""
import numpy as np

FULL = (1 << 64) - 1
NOT_A = FULL ^ 0x0101010101010101  # col 0 (a列) 以外
NOT_H = FULL ^ 0x8080808080808080  # col 7 (h列) 以外
PASS = 64
N_ACTIONS = 65


def _shifts(x):
    """8方向にずらした盤面を返す（盤外に出たビットは消す）"""
    return (
        (x << 1) & NOT_A & FULL,   # 右 (col+1)
        (x >> 1) & NOT_H,          # 左 (col-1)
        (x << 8) & FULL,           # 下 (row+1)
        x >> 8,                    # 上 (row-1)
        (x << 9) & NOT_A & FULL,   # 右下
        (x << 7) & NOT_H & FULL,   # 左下
        (x >> 7) & NOT_A,          # 右上
        (x >> 9) & NOT_H,          # 左上
    )


def _shift(x, d):
    if d == 0:
        return (x << 1) & NOT_A & FULL
    if d == 1:
        return (x >> 1) & NOT_H
    if d == 2:
        return (x << 8) & FULL
    if d == 3:
        return x >> 8
    if d == 4:
        return (x << 9) & NOT_A & FULL
    if d == 5:
        return (x << 7) & NOT_H & FULL
    if d == 6:
        return (x >> 7) & NOT_A
    return (x >> 9) & NOT_H


def legal_mask(P, O):
    empty = ~(P | O) & FULL
    moves = 0
    for d in range(8):
        t = _shift(P, d) & O
        for _ in range(5):
            t |= _shift(t, d) & O
        moves |= _shift(t, d) & empty
    return moves


def flips(P, O, m):
    """m (1ビット) に打ったときに返る石"""
    f = 0
    for d in range(8):
        x = _shift(m, d)
        line = 0
        while x & O:
            line |= x
            x = _shift(x, d)
        if x & P:
            f |= line
    return f


def bits(x):
    out = []
    while x:
        low = x & -x
        out.append(low.bit_length() - 1)
        x ^= low
    return out


def popcount(x):
    return bin(x).count("1")


class State:
    """手番側から見た局面。color は手番の色（1=黒, -1=白）。"""
    __slots__ = ("P", "O", "color", "_legal")

    def __init__(self, P, O, color):
        self.P = P
        self.O = O
        self.color = color
        self._legal = None

    @staticmethod
    def initial():
        # d4=27 白, e4=28 黒, d5=35 黒, e5=36 白。黒番。
        black = (1 << 28) | (1 << 35)
        white = (1 << 27) | (1 << 36)
        return State(black, white, 1)

    def legal_actions(self):
        """合法手のリスト。打てる場所がなく相手は打てるならパス [64]、終局なら []"""
        if self._legal is None:
            m = legal_mask(self.P, self.O)
            if m:
                self._legal = bits(m)
            elif legal_mask(self.O, self.P):
                self._legal = [PASS]
            else:
                self._legal = []
        return self._legal

    def is_terminal(self):
        return len(self.legal_actions()) == 0

    def play(self, a):
        if a == PASS:
            return State(self.O, self.P, -self.color)
        m = 1 << a
        f = flips(self.P, self.O, m)
        P = self.P | m | f
        O = self.O & ~f
        return State(O, P, -self.color)

    def result(self):
        """終局時、手番側から見た結果 (+1 勝ち / 0 引き分け / -1 負け)"""
        p, o = popcount(self.P), popcount(self.O)
        return (p > o) - (p < o)

    def disc_diff(self):
        return popcount(self.P) - popcount(self.O)

    def empties(self):
        return 64 - popcount(self.P | self.O)

    def black_white(self):
        return (self.P, self.O) if self.color == 1 else (self.O, self.P)


def _to_plane(x):
    return np.unpackbits(np.array([x], dtype=np.uint64).view(np.uint8), bitorder="little").astype(np.float32)


def encode(state):
    """ニューラルネットへの入力 (3, 8, 8): 手番側の石 / 相手の石 / 合法手"""
    legal = legal_mask(state.P, state.O)
    planes = np.stack([_to_plane(state.P), _to_plane(state.O), _to_plane(legal)])
    return planes.reshape(3, 8, 8)
