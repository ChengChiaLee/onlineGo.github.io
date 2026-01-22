#!/usr/bin/env python3
import json
import math
import os
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# -----------------------------
# Go engine (simple rules)
# 0 empty, 1 black, 2 white
# Implements: capture, suicide illegal, simple ko (compare to board from 2 plies ago), pass
# Scoring for MCTS rollout: approximate Tromp-Taylor area + komi (simple territory floodfill).
# -----------------------------

def in_bounds(n, x, y):
    return 0 <= x < n and 0 <= y < n

def neighbors(n, x, y):
    if x > 0:      yield (x-1, y)
    if x+1 < n:    yield (x+1, y)
    if y > 0:      yield (x, y-1)
    if y+1 < n:    yield (x, y+1)

def copy_board(b):
    return [row[:] for row in b]

def group_and_liberties(board, x0, y0):
    n = len(board)
    color = board[y0][x0]
    stack = [(x0, y0)]
    seen = set([(x0, y0)])
    stones = []
    liberties = set()

    while stack:
        x, y = stack.pop()
        stones.append((x, y))
        for nx, ny in neighbors(n, x, y):
            v = board[ny][nx]
            if v == 0:
                liberties.add((nx, ny))
            elif v == color and (nx, ny) not in seen:
                seen.add((nx, ny))
                stack.append((nx, ny))

    return stones, liberties

def remove_stones(board, stones):
    for x, y in stones:
        board[y][x] = 0

def apply_move(board, player, move, ko_board):
    """
    move: (x,y) or None for pass
    returns new_board or None if illegal
    """
    n = len(board)
    if move is None:
        # pass is always legal
        return copy_board(board)

    x, y = move
    if not in_bounds(n, x, y):
        return None
    if board[y][x] != 0:
        return None

    opp = 2 if player == 1 else 1
    nb = copy_board(board)
    nb[y][x] = player

    # capture adjacent opponent groups with no liberties
    captured_any = False
    checked = set()
    for nx, ny in neighbors(n, x, y):
        if nb[ny][nx] != opp:
            continue
        if (nx, ny) in checked:
            continue
        stones, libs = group_and_liberties(nb, nx, ny)
        for s in stones:
            checked.add(s)
        if len(libs) == 0:
            remove_stones(nb, stones)
            captured_any = True

    # suicide check after captures
    stones, libs = group_and_liberties(nb, x, y)
    if len(libs) == 0:
        return None

    # simple ko check
    if ko_board is not None and nb == ko_board:
        return None

    return nb

def occupied_points(board):
    n = len(board)
    pts = []
    for y in range(n):
        row = board[y]
        for x in range(n):
            if row[x] != 0:
                pts.append((x, y))
    return pts

def capture_candidates(board, player):
    """Return set of empty points that would capture an opponent group in atari (1 liberty)."""
    n = len(board)
    opp = 2 if player == 1 else 1
    cand = set()
    seen = set()
    for y in range(n):
        for x in range(n):
            if board[y][x] != opp:
                continue
            if (x, y) in seen:
                continue
            stones, libs = group_and_liberties(board, x, y)
            for s in stones:
                seen.add(s)
            if len(libs) == 1:
                (lx, ly) = next(iter(libs))
                if board[ly][lx] == 0:
                    cand.add((lx, ly))
    return cand

def local_candidate_moves(board):
    """Prune moves: empties within manhattan distance <= 2 of any stone."""
    n = len(board)
    occ = occupied_points(board)
    if not occ:
        c = n // 2
        return {(c, c)}
    cand = set()
    for (x, y) in occ:
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                if abs(dx) + abs(dy) > 2:
                    continue
                nx, ny = x + dx, y + dy
                if in_bounds(n, nx, ny) and board[ny][nx] == 0:
                    cand.add((nx, ny))
    return cand

def legal_moves(board, player, ko_board):
    n = len(board)
    moves = set()

    # Must include tactical capture candidates
    moves |= capture_candidates(board, player)

    # Add local candidates (keeps branching manageable)
    moves |= local_candidate_moves(board)

    # If still tiny, add a few random empties to avoid deadlock in weird shapes
    if len(moves) < 10:
        empties = [(x, y) for y in range(n) for x in range(n) if board[y][x] == 0]
        random.shuffle(empties)
        for p in empties[: min(40, len(empties))]:
            moves.add(p)

    # Filter illegal
    out = []
    for mv in moves:
        nb = apply_move(board, player, mv, ko_board)
        if nb is not None:
            out.append(mv)

    # Always allow pass
    out.append(None)
    return out

def tromp_taylor_winner(board, komi):
    """
    Approximate area scoring:
      score(color) = stones + empty regions fully surrounded by that color
    This ignores seki nuances but is fine for a toy MCTS.
    """
    n = len(board)
    seen = [[False]*n for _ in range(n)]
    b_stones = 0
    w_stones = 0
    for y in range(n):
        for x in range(n):
            if board[y][x] == 1: b_stones += 1
            elif board[y][x] == 2: w_stones += 1

    b_terr = 0
    w_terr = 0

    for y0 in range(n):
        for x0 in range(n):
            if board[y0][x0] != 0 or seen[y0][x0]:
                continue
            # flood fill empty region
            stack = [(x0, y0)]
            seen[y0][x0] = True
            region = []
            border_colors = set()
            while stack:
                x, y = stack.pop()
                region.append((x, y))
                for nx, ny in neighbors(n, x, y):
                    v = board[ny][nx]
                    if v == 0 and not seen[ny][nx]:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
                    elif v in (1, 2):
                        border_colors.add(v)
            if len(border_colors) == 1:
                c = next(iter(border_colors))
                if c == 1:
                    b_terr += len(region)
                else:
                    w_terr += len(region)

    b_score = b_stones + b_terr
    w_score = w_stones + w_terr + komi

    if b_score > w_score:
        return 1
    if w_score > b_score:
        return 2
    return 0

# -----------------------------
# MCTS (UCT), root-player win-tracking
# -----------------------------

class Node:
    __slots__ = ("board", "player", "ko_board", "parent", "move", "children",
                 "untried", "visits", "wins", "passes")

    def __init__(self, board, player, ko_board, parent=None, move=None, passes=0):
        self.board = board
        self.player = player           # player to play at this node
        self.ko_board = ko_board       # board from 2 plies ago relative to this node
        self.parent = parent
        self.move = move               # move that led here (from parent)
        self.children = []
        self.untried = None
        self.visits = 0
        self.wins = 0.0                # wins from ROOT player perspective
        self.passes = passes           # consecutive passes so far

    def ensure_untried(self):
        if self.untried is None:
            self.untried = legal_moves(self.board, self.player, self.ko_board)

def uct_select(node, c=1.35):
    # maximize UCT for root-player win rate
    best = None
    best_val = -1e100
    lnN = math.log(max(1, node.visits))
    for ch in node.children:
        if ch.visits == 0:
            return ch
        exploit = ch.wins / ch.visits
        explore = c * math.sqrt(lnN / ch.visits)
        val = exploit + explore
        if val > best_val:
            best_val = val
            best = ch
    return best

def rollout(board, player, ko_board, passes, komi, max_plies):
    """
    Random simulation with light capture bias.
    """
    cur_board = copy_board(board)
    cur_player = player
    cur_ko = ko_board
    cur_passes = passes

    for _ in range(max_plies):
        if cur_passes >= 2:
            break

        # bias to capturing moves
        caps = list(capture_candidates(cur_board, cur_player))
        random.shuffle(caps)
        mv = None

        if caps:
            # pick a legal capture if possible
            for cand in caps[:8]:
                nb = apply_move(cur_board, cur_player, cand, cur_ko)
                if nb is not None:
                    mv = cand
                    break

        if mv is None:
            mvs = legal_moves(cur_board, cur_player, cur_ko)
            # reduce pass frequency unless forced
            non_pass = [m for m in mvs if m is not None]
            if non_pass:
                mv = random.choice(non_pass)
            else:
                mv = None

        nb = apply_move(cur_board, cur_player, mv, cur_ko)
        if nb is None:
            # fallback to pass
            mv = None
            nb = apply_move(cur_board, cur_player, None, cur_ko)

        # update ko: next node's ko board should be current board from 2 plies ago,
        # so we shift: new_ko = previous position (before move) of the current ply,
        # but our apply_move checks against cur_ko already. We keep (ko) as "two plies ago":
        # For next ply, the "ko_board" should become the board from one ply ago's parent,
        # which here is cur_board's parent; approximated by setting next_ko = prev_prev,
        # but we don't keep full history in rollout. We can approximate simple-ko by:
        # check against the board from 2 plies ago using a 2-board window.
        # We'll implement exact simple-ko with a rolling window of last two boards.
        #
        # We'll maintain last2 (board from 2 plies ago) and last1 (board from 1 ply ago).
        # Here: cur_ko == last2 and cur_board == last1 is NOT guaranteed initially, so build them.
        cur_board = nb

        if mv is None:
            cur_passes += 1
        else:
            cur_passes = 0

        cur_player = 2 if cur_player == 1 else 1

    return tromp_taylor_winner(cur_board, komi)

def mcts_best_move(root_board, root_player, ko_board, komi, thinking_ms):
    start = time.perf_counter()
    deadline = start + max(0.05, thinking_ms / 1000.0)

    root = Node(copy_board(root_board), root_player, ko_board, parent=None, move=None, passes=0)
    root.ensure_untried()

    # scale rollout length by board size
    n = len(root_board)
    max_plies = min(n*n*2, 180 if n == 9 else (260 if n == 13 else 320))

    iters = 0
    while time.perf_counter() < deadline:
        iters += 1
        node = root

        # SELECTION
        while True:
            node.ensure_untried()
            if node.untried and len(node.untried) > 0:
                break
            if not node.children:
                break
            node = uct_select(node)

        # EXPANSION
        node.ensure_untried()
        if node.untried:
            mv = node.untried.pop(random.randrange(len(node.untried)))
            nb = apply_move(node.board, node.player, mv, node.ko_board)
            if nb is None:
                # illegal due to stale candidate filtering; continue
                continue

            next_player = 2 if node.player == 1 else 1
            next_passes = node.passes + 1 if mv is None else 0

            # For strict simple-ko, you'd pass "board from 2 plies ago" into child.
            # We can do that exactly with 2-step memory by setting child's ko_board = node.parent.board if exists.
            child_ko = node.parent.board if node.parent is not None else None

            child = Node(nb, next_player, child_ko, parent=node, move=mv, passes=next_passes)
            node.children.append(child)
            node = child

        # SIMULATION
        winner = rollout(node.board, node.player, node.ko_board, node.passes, komi, max_plies)

        # BACKPROP (win from root player's perspective)
        result = 1.0 if winner == root_player else (0.5 if winner == 0 else 0.0)
        cur = node
        while cur is not None:
            cur.visits += 1
            cur.wins += result
            cur = cur.parent

    # pick child with max visits
    if not root.children:
        return None, iters

    best = max(root.children, key=lambda c: c.visits)
    return best.move, iters

# -----------------------------
# HTTP server (serves files + /api/move)
# -----------------------------

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
}

ALLOWED_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/style.css": "style.css",
    "/go.js": "go.js",
}

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path not in ALLOWED_FILES:
            self._send(404, "Not found")
            return

        fn = ALLOWED_FILES[path]
        if not os.path.exists(fn):
            self._send(404, f"Missing file: {fn}")
            return

        ext = os.path.splitext(fn)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(fn, "rb") as f:
            data = f.read()
        self._send(200, data, ctype)

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/move":
            self._send(404, "Not found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))

            n = int(payload.get("size"))
            to_play = int(payload.get("toPlay"))
            komi = float(payload.get("komi", 6.5))
            thinking_ms = int(payload.get("thinking_ms", 700))

            board = payload.get("board")
            ko = payload.get("ko", None)

            if n not in (9, 13, 19):
                raise ValueError("size must be 9/13/19")
            if to_play not in (1, 2):
                raise ValueError("toPlay must be 1 or 2")
            if not isinstance(board, list) or len(board) != n:
                raise ValueError("board shape invalid")

            # sanitize board values
            b = []
            for row in board:
                if not isinstance(row, list) or len(row) != n:
                    raise ValueError("board row invalid")
                b.append([0 if v not in (1,2) else int(v) for v in row])

            ko_board = None
            if ko is not None:
                if isinstance(ko, list) and len(ko) == n:
                    kb = []
                    ok = True
                    for row in ko:
                        if not isinstance(row, list) or len(row) != n:
                            ok = False
                            break
                        kb.append([0 if v not in (1,2) else int(v) for v in row])
                    if ok:
                        ko_board = kb

            mv, iters = mcts_best_move(b, to_play, ko_board, komi, thinking_ms)

            if mv is None:
                out = {"pass": True, "iters": iters}
            else:
                x, y = mv
                out = {"x": x, "y": y, "pass": False, "iters": iters}

            self._send(200, json.dumps(out), "application/json; charset=utf-8")

        except Exception as e:
            self._send(400, json.dumps({"error": str(e)}), "application/json; charset=utf-8")

def main():
    host = "127.0.0.1"
    port = 8000
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving on http://{host}:{port}")
    print("Files expected in same folder: index.html, style.css, go.js, mcts_server.py")
    httpd.serve_forever()

if __name__ == "__main__":
    random.seed()
    main()
