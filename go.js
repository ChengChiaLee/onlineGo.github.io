"use strict";

/* =========================
   Constants / Utilities
   ========================= */
const EMPTY = 0;
const BLACK = 1;
const WHITE = -1;

function opp(c){ return -c; }

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(x, lo, hi){
  return Math.max(lo, Math.min(hi, x));
}

function randInt(n){
  return Math.floor(Math.random() * n);
}

// Go coordinates (skip I)
function xToLetter(x){
  const letters = "ABCDEFGHJKLMNOPQRSTUVWXZY"; // enough for 25
  return letters[x] || "?";
}
function moveToText(size, mv){
  if(mv.pass) return "pass";
  // standard-ish: letters + (size - y)
  return `${xToLetter(mv.x)}${size - mv.y}`;
}

/* =========================
   Go Rules Engine (simple ko)
   - captures
   - no suicide
   - simple ko via koPoint
   - end by 2 consecutive passes
   ========================= */
class GoGame{
  constructor(size, komi){
    this.size = size;
    this.komi = komi;

    this.board = new Int8Array(size * size);
    this.toPlay = BLACK;

    this.capturesB = 0;
    this.capturesW = 0;

    this.consecutivePasses = 0;
    this.koPoint = -1; // board index forbidden for next player (simple ko)

    this.moveNumber = 0;
    this.lastMove = null;
    this.moves = []; // history of moves: {x,y,pass,color,captured}
  }

  idx(x,y){ return y * this.size + x; }
  inBounds(x,y){ return x >= 0 && x < this.size && y >= 0 && y < this.size; }
  atIdx(p){ return this.board[p]; }

  neighborsIdx(p){
    const s = this.size;
    const x = p % s;
    const y = (p / s) | 0;
    const out = [];
    if(x > 0) out.push(p - 1);
    if(x + 1 < s) out.push(p + 1);
    if(y > 0) out.push(p - s);
    if(y + 1 < s) out.push(p + s);
    return out;
  }

  cloneShallowState(){
    // for MCTS we only need current position, koPoint, toPlay, passes
    return {
      size: this.size,
      komi: this.komi,
      board: new Int8Array(this.board),
      toPlay: this.toPlay,
      koPoint: this.koPoint,
      consecutivePasses: this.consecutivePasses
    };
  }

  // Collect group stones; early-exit if a liberty found (for speed).
  // Returns { stones: Int32Array|Array, hasLiberty: boolean }
  collectGroup(boardArr, startP){
    const color = boardArr[startP];
    const s = this.size;
    const seen = new Uint8Array(s * s);
    const stack = [startP];
    seen[startP] = 1;

    const stones = [];
    while(stack.length){
      const p = stack.pop();
      stones.push(p);

      const nbs = this.neighborsIdx(p);
      for(const q of nbs){
        const v = boardArr[q];
        if(v === EMPTY){
          return { stones: [], hasLiberty: true }; // early-exit: not captured
        }
        if(v === color && !seen[q]){
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    // no liberty discovered
    return { stones, hasLiberty: false };
  }

  // Count liberties for a single stone only (unique is trivial here).
  singleStoneLiberties(boardArr, p){
    let libs = 0;
    for(const q of this.neighborsIdx(p)){
      if(boardArr[q] === EMPTY) libs++;
    }
    return libs;
  }

  isSingleStone(boardArr, p, color){
    for(const q of this.neighborsIdx(p)){
      if(boardArr[q] === color) return false;
    }
    return true;
  }

  // Simulate move; returns { ok, nextState, capturedCount, capturedPos, reason }
  simulateMove(state, mv){
    const s = state.size;
    const board = state.board;

    if(mv.pass){
      // pass is always legal; also clears ko restriction in simple ko sense
      return {
        ok: true,
        capturedCount: 0,
        capturedPos: -1,
        nextState: {
          size: s,
          komi: state.komi,
          board: new Int8Array(board),
          toPlay: opp(state.toPlay),
          koPoint: -1,
          consecutivePasses: state.consecutivePasses + 1
        }
      };
    }

    const x = mv.x, y = mv.y;
    if(x < 0 || x >= s || y < 0 || y >= s){
      return { ok:false, reason:"out_of_bounds" };
    }

    const p = y * s + x;
    if(board[p] !== EMPTY) return { ok:false, reason:"occupied" };
    if(p === state.koPoint) return { ok:false, reason:"ko" };

    const color = state.toPlay;
    const nextBoard = new Int8Array(board);
    nextBoard[p] = color;

    // capture opponent groups with no liberties
    let captured = 0;
    let capturedPos = -1;

    const nbs = this.neighborsIdx(p);
    for(const q of nbs){
      if(nextBoard[q] === opp(color)){
        const info = this.collectGroup(nextBoard, q);
        if(!info.hasLiberty){
          for(const stoneP of info.stones){
            nextBoard[stoneP] = EMPTY;
            captured++;
            capturedPos = stoneP; // if multiple, last overwrite; only matters when captured==1
          }
        }
      }
    }

    // check suicide (after captures)
    const selfInfo = this.collectGroup(nextBoard, p);
    if(!selfInfo.hasLiberty){
      return { ok:false, reason:"suicide" };
    }

    // compute new koPoint (classic single-stone ko approximation)
    let nextKo = -1;
    if(captured === 1){
      // only if placed stone is a single stone and has exactly 1 liberty
      if(this.isSingleStone(nextBoard, p, color) && this.singleStoneLiberties(nextBoard, p) === 1){
        nextKo = capturedPos;
      }
    }

    return {
      ok: true,
      capturedCount: captured,
      capturedPos,
      nextState: {
        size: s,
        komi: state.komi,
        board: nextBoard,
        toPlay: opp(color),
        koPoint: nextKo,
        consecutivePasses: 0
      }
    };
  }

  // Apply move to actual game
  play(mv){
    const state = this.cloneShallowState();
    const res = this.simulateMove(state, mv);
    if(!res.ok) return res;

    this.board = res.nextState.board;
    const justPlayed = this.toPlay;

    if(res.capturedCount > 0){
      if(justPlayed === BLACK) this.capturesB += res.capturedCount;
      else this.capturesW += res.capturedCount;
    }

    this.toPlay = res.nextState.toPlay;
    this.koPoint = res.nextState.koPoint;
    this.consecutivePasses = res.nextState.consecutivePasses;

    this.moveNumber++;
    this.lastMove = { ...mv, color: justPlayed, captured: res.capturedCount };
    this.moves.push(this.lastMove);

    return { ok:true, captured: res.capturedCount };
  }

  isOver(){
    return this.consecutivePasses >= 2;
  }

  // Area scoring (Chinese-like):
  // score = stones + surrounded empty; white gets komi
  computeAreaScore(boardArr){
    const s = this.size;
    let blackStones = 0, whiteStones = 0;

    for(let i=0;i<boardArr.length;i++){
      if(boardArr[i] === BLACK) blackStones++;
      else if(boardArr[i] === WHITE) whiteStones++;
    }

    const seen = new Uint8Array(s * s);
    let blackTerr = 0, whiteTerr = 0;

    const nbsIdx = (p) => this.neighborsIdx(p);

    for(let p=0;p<s*s;p++){
      if(seen[p]) continue;
      if(boardArr[p] !== EMPTY) { seen[p] = 1; continue; }

      // BFS empty region
      const stack = [p];
      seen[p] = 1;
      const empties = [];
      let touchesB = false;
      let touchesW = false;

      while(stack.length){
        const u = stack.pop();
        empties.push(u);

        for(const v of nbsIdx(u)){
          const cell = boardArr[v];
          if(cell === EMPTY && !seen[v]){
            seen[v] = 1;
            stack.push(v);
          }else if(cell === BLACK){
            touchesB = true;
          }else if(cell === WHITE){
            touchesW = true;
          }
        }
      }

      if(touchesB && !touchesW) blackTerr += empties.length;
      else if(touchesW && !touchesB) whiteTerr += empties.length;
      // else dame/seki-ish => ignore
    }

    const blackScore = blackStones + blackTerr;
    const whiteScore = whiteStones + whiteTerr + this.komi;
    return { blackScore, whiteScore };
  }
}

/* =========================
   Opening Book (very small)
   This is NOT a full joseki library.
   It's a short set of "reasonable" early patterns.
   If any move is blocked/illegal, book stops.
   ========================= */
function buildOpeningBook(size){
  // coordinates are 0-indexed (x,y), y=0 is top
  if(size === 9){
    return [
      [{x:2,y:2},{x:6,y:6},{x:2,y:6},{x:6,y:2},{x:4,y:4}],
      [{x:2,y:6},{x:6,y:2},{x:2,y:2},{x:6,y:6},{x:4,y:4}],
    ];
  }
  if(size === 13){
    return [
      [{x:3,y:3},{x:9,y:9},{x:3,y:9},{x:9,y:3},{x:6,y:6}],
      [{x:3,y:9},{x:9,y:3},{x:3,y:3},{x:9,y:9},{x:6,y:6}],
    ];
  }
  // 19
  return [
    [{x:3,y:3},{x:15,y:15},{x:3,y:15},{x:15,y:3},{x:9,y:9}],
    [{x:15,y:3},{x:3,y:15},{x:15,y:15},{x:3,y:3},{x:9,y:9}],
  ];
}

function getBookMove(game, bookLines){
  const k = game.moves.length;
  for(const line of bookLines){
    if(k >= line.length) continue;

    // check prefix matches exactly
    let ok = true;
    for(let i=0;i<k;i++){
      const mv = game.moves[i];
      const want = line[i];
      if(mv.pass) { ok = false; break; }
      if(mv.x !== want.x || mv.y !== want.y) { ok = false; break; }
    }
    if(!ok) continue;

    // propose next
    const next = line[k];
    return { x: next.x, y: next.y, pass:false, fromBook:true };
  }
  return null;
}

/* =========================
   MCTS (UCT)
   - correctness: uses the same simulateMove() legality
   - controllable iterations/depth
   ========================= */
class MCTSNode{
  constructor(state, parent, move){
    this.state = state;     // position after applying move from parent
    this.parent = parent;
    this.move = move;       // move that led here (null for root)
    this.children = [];
    this.untriedMoves = null;

    this.visits = 0;
    this.wins = 0;          // from root player's perspective
  }

  uctSelectChild(c){
    // maximize: (wins/visits) + c*sqrt(ln(N)/visits)
    let best = null;
    let bestVal = -1e100;
    const lnN = Math.log(this.visits + 1);

    for(const ch of this.children){
      if(ch.visits === 0){
        return ch;
      }
      const exploit = ch.wins / ch.visits;
      const explore = c * Math.sqrt(lnN / ch.visits);
      const val = exploit + explore;
      if(val > bestVal){
        bestVal = val;
        best = ch;
      }
    }
    return best;
  }
}

class MCTS{
  constructor(rulesEngine){
    this.rules = rulesEngine; // uses GoGame methods (simulateMove, scoring)
  }

  legalMoves(state){
    const s = state.size;
    const moves = [];

    // include pass always (so rollouts can end)
    moves.push({ pass:true });

    for(let y=0;y<s;y++){
      for(let x=0;x<s;x++){
        const p = y*s + x;
        if(state.board[p] !== EMPTY) continue;
        if(p === state.koPoint) continue; // fast reject
        const res = this.rules.simulateMove(state, {x,y,pass:false});
        if(res.ok) moves.push({x,y,pass:false});
      }
    }
    return moves;
  }

  // simple rollout policy: prefer captures, avoid early pass a bit
  rollout(state, depthLimit){
    let st = state;
    for(let ply=0; ply<depthLimit; ply++){
      if(st.consecutivePasses >= 2) break;

      const moves = this.legalMoves(st);
      if(moves.length === 0) break;

      // Heuristic pick:
      // 1) if any capture exists, prefer among them
      // 2) otherwise avoid pass unless near the end (later depth)
      let best = null;
      let bestScore = -1e100;

      for(const mv of moves){
        if(mv.pass){
          // discourage early pass
          const passPenalty = (ply < depthLimit * 0.6) ? 2.0 : 0.2;
          const sc = -passPenalty + (Math.random() * 0.01);
          if(sc > bestScore){ bestScore = sc; best = mv; }
          continue;
        }
        const res = this.rules.simulateMove(st, mv);
        if(!res.ok) continue;

        // capture bonus
        let sc = res.capturedCount * 5.0;

        // mild penalty for filling surrounded point (very rough "eye-like" check)
        // If all neighbors are same color and no capture, penalize.
        if(res.capturedCount === 0){
          const p = mv.y * st.size + mv.x;
          let allSame = true;
          for(const q of this.rules.neighborsIdx(p)){
            if(res.nextState.board[q] !== st.toPlay){
              allSame = false; break;
            }
          }
          if(allSame) sc -= 1.0;
        }

        sc += Math.random() * 0.05;
        if(sc > bestScore){ bestScore = sc; best = mv; }
      }

      if(!best) best = { pass:true };
      const step = this.rules.simulateMove(st, best);
      st = step.ok ? step.nextState : { ...st, consecutivePasses: st.consecutivePasses + 1 };
    }

    // Determine winner by area score
    const tmpGame = new GoGame(st.size, st.komi);
    tmpGame.board = st.board;
    const { blackScore, whiteScore } = tmpGame.computeAreaScore(st.board);

    if(blackScore > whiteScore) return BLACK;
    if(whiteScore > blackScore) return WHITE;
    return 0; // tie
  }

  search(rootState, iterations, depthLimit, explorationC){
    const rootPlayer = rootState.toPlay;
    const root = new MCTSNode(rootState, null, null);
    root.untriedMoves = this.legalMoves(rootState);

    for(let i=0;i<iterations;i++){
      let node = root;

      // Selection
      while(node.untriedMoves.length === 0 && node.children.length > 0){
        node = node.uctSelectChild(explorationC);
      }

      // Expansion
      if(node.untriedMoves.length > 0){
        const m = node.untriedMoves.splice(randInt(node.untriedMoves.length), 1)[0];
        const res = this.rules.simulateMove(node.state, m);
        if(res.ok){
          const child = new MCTSNode(res.nextState, node, m);
          child.untriedMoves = this.legalMoves(child.state);
          node.children.push(child);
          node = child;
        }
      }

      // Rollout
      const winner = this.rollout(node.state, depthLimit);

      // Backprop (wins for rootPlayer)
      while(node){
        node.visits++;
        if(winner === 0) node.wins += 0.5;
        else if(winner === rootPlayer) node.wins += 1.0;
        node = node.parent;
      }
    }

    // Choose best by visits (more stable than raw winrate)
    if(root.children.length === 0){
      return { pass:true };
    }
    let bestChild = root.children[0];
    for(const ch of root.children){
      if(ch.visits > bestChild.visits) bestChild = ch;
    }
    return bestChild.move || { pass:true };
  }
}

/* =========================
   UI / Rendering
   ========================= */
const canvas = document.getElementById("goCanvas");
const ctx = canvas.getContext("2d");

const sizeSel = document.getElementById("sizeSel");
const komiInp = document.getElementById("komiInp");
const delayInp = document.getElementById("delayInp");
const iterInp  = document.getElementById("iterInp");
const depthInp = document.getElementById("depthInp");
const cInp     = document.getElementById("cInp");
const bookChk  = document.getElementById("bookChk");
const showHintsChk = document.getElementById("showHintsChk");

const newBtn   = document.getElementById("newBtn");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stepBtn  = document.getElementById("stepBtn");
const passBtn  = document.getElementById("passBtn");

const turnText = document.getElementById("turnText");
const moveNoEl = document.getElementById("moveNo");
const passNoEl = document.getElementById("passNo");
const capBEl   = document.getElementById("capB");
const capWEl   = document.getElementById("capW");
const lastMoveEl = document.getElementById("lastMove");
const logEl = document.getElementById("log");

let game = null;
let mcts = null;

let running = false;
let openingBook = [];
let openingBookActive = true;

function logLine(html){
  const div = document.createElement("div");
  div.innerHTML = html;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog(){
  logEl.innerHTML = "";
}

function newGame(){
  const size = parseInt(sizeSel.value, 10);
  const komi = parseFloat(komiInp.value);

  game = new GoGame(size, komi);
  mcts = new MCTS(game);

  openingBook = buildOpeningBook(size);
  openingBookActive = true;

  running = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;

  clearLog();
  logLine(`<span class="dim">New game: ${size}×${size}, komi=${komi}</span>`);
  draw();
  updateStatus();
}

function updateStatus(){
  turnText.textContent = (game.toPlay === BLACK) ? "Black" : "White";
  moveNoEl.textContent = String(game.moveNumber);
  passNoEl.textContent = String(game.consecutivePasses);
  capBEl.textContent = String(game.capturesB);
  capWEl.textContent = String(game.capturesW);

  if(!game.lastMove){
    lastMoveEl.textContent = "—";
  }else{
    const mv = game.lastMove;
    const who = (mv.color === BLACK) ? "B" : "W";
    const txt = mv.pass ? "pass" : moveToText(game.size, mv);
    lastMoveEl.textContent = `${who} ${txt}${mv.captured ? ` (x${mv.captured})` : ""}`;
  }

  if(game.isOver()){
    const { blackScore, whiteScore } = game.computeAreaScore(game.board);
    logLine(`<span class="good">Game over (2 passes). Area score: B=${blackScore.toFixed(1)}, W=${whiteScore.toFixed(1)}</span>`);
  }
}

function starPoints(size){
  // Common star points (not exact for all boards, but reasonable)
  if(size === 9)  return [2, 4, 6];
  if(size === 13) return [3, 6, 9];
  if(size === 19) return [3, 9, 15];
  // fallback
  const mid = (size/2)|0;
  return [mid];
}

function draw(){
  const s = game.size;

  // Fit board into canvas
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  const margin = 40;
  const boardSizePx = Math.min(W,H) - margin*2;
  const cell = boardSizePx / (s - 1);

  const ox = (W - boardSizePx)/2;
  const oy = (H - boardSizePx)/2;

  // Grid
  ctx.strokeStyle = "#2b1f12";
  ctx.lineWidth = 1;

  for(let i=0;i<s;i++){
    // vertical
    ctx.beginPath();
    ctx.moveTo(ox + i*cell, oy);
    ctx.lineTo(ox + i*cell, oy + boardSizePx);
    ctx.stroke();

    // horizontal
    ctx.beginPath();
    ctx.moveTo(ox, oy + i*cell);
    ctx.lineTo(ox + boardSizePx, oy + i*cell);
    ctx.stroke();
  }

  // Star points
  const sp = starPoints(s);
  ctx.fillStyle = "#2b1f12";
  for(const x of sp){
    for(const y of sp){
      // standard 9/13/19: only draw if meaningful
      if((s === 9 || s === 13 || s === 19) && sp.length >= 3){
        // draw all 9 points
      }
      const cx = ox + x*cell;
      const cy = oy + y*cell;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI*2);
      ctx.fill();
    }
  }

  // Stones
  const r = cell * 0.45;
  for(let y=0;y<s;y++){
    for(let x=0;x<s;x++){
      const v = game.board[y*s + x];
      if(v === EMPTY) continue;

      const cx = ox + x*cell;
      const cy = oy + y*cell;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI*2);

      if(v === BLACK){
        ctx.fillStyle = "#111";
        ctx.fill();
        ctx.strokeStyle = "#000";
        ctx.stroke();
      }else{
        ctx.fillStyle = "#f0f0f0";
        ctx.fill();
        ctx.strokeStyle = "#999";
        ctx.stroke();
      }
    }
  }

  // Last move marker
  if(game.lastMove && !game.lastMove.pass){
    const cx = ox + game.lastMove.x*cell;
    const cy = oy + game.lastMove.y*cell;
    ctx.fillStyle = "#c41d2f";
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI*2);
    ctx.fill();
  }

  // Debug hint: show koPoint
  if(showHintsChk.checked && game.koPoint !== -1){
    const x = game.koPoint % s;
    const y = (game.koPoint / s) | 0;
    const cx = ox + x*cell;
    const cy = oy + y*cell;
    ctx.strokeStyle = "#c41d2f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r*0.6, 0, Math.PI*2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function pickAIMove(){
  // Opening book first (if enabled and still matching)
  if(bookChk.checked && openingBookActive){
    const bm = getBookMove(game, openingBook);
    if(bm){
      // must still be legal
      const res = game.simulateMove(game.cloneShallowState(), bm);
      if(res.ok){
        return bm;
      }
    }
    openingBookActive = false;
  }

  const iterations = clamp(parseInt(iterInp.value,10) || 200, 10, 5000);
  const depth = clamp(parseInt(depthInp.value,10) || 120, 20, 2000);
  const c = clamp(parseFloat(cInp.value) || 1.4, 0.0, 5.0);

  const rootState = game.cloneShallowState();
  return mcts.search(rootState, iterations, depth, c);
}

function doOneStep(){
  if(game.isOver()){
    updateStatus();
    return;
  }
  const mv = pickAIMove();

  const res = game.play(mv.pass ? {pass:true} : {x:mv.x, y:mv.y, pass:false});
  if(!res.ok){
    logLine(`<span class="bad">Illegal move rejected (${res.reason}). Forcing pass.</span>`);
    game.play({pass:true});
  }else{
    const who = (game.lastMove.color === BLACK) ? "B" : "W";
    const txt = game.lastMove.pass ? "pass" : moveToText(game.size, game.lastMove);
    const src = mv.fromBook ? " <span class='dim'>(book)</span>" : "";
    logLine(`${who} ${txt}${game.lastMove.captured ? ` <span class="good">(x${game.lastMove.captured})</span>` : ""}${src}`);
  }

  draw();
  updateStatus();
}

async function runLoop(){
  running = true;
  startBtn.disabled = true;
  pauseBtn.disabled = false;

  while(running && !game.isOver()){
    doOneStep();
    const delay = clamp(parseInt(delayInp.value,10) || 0, 0, 5000);
    if(delay > 0) await sleep(delay);
    else await sleep(0);
  }

  running = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;
}

newBtn.addEventListener("click", () => {
  running = false;
  newGame();
});

startBtn.addEventListener("click", () => {
  if(!game) newGame();
  if(!running) runLoop();
});

pauseBtn.addEventListener("click", () => {
  running = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  logLine(`<span class="dim">Paused.</span>`);
});

stepBtn.addEventListener("click", () => {
  if(!game) newGame();
  if(running) return;
  doOneStep();
});

passBtn.addEventListener("click", () => {
  if(!game) newGame();
  if(running) return;
  const who = (game.toPlay === BLACK) ? "B" : "W";
  game.play({pass:true});
  logLine(`${who} pass <span class="dim">(forced)</span>`);
  draw();
  updateStatus();
});

// optional: click-to-play when paused (useful to test correctness)
canvas.addEventListener("click", (ev) => {
  if(!game) return;
  if(running) return;

  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const py = (ev.clientY - rect.top) * (canvas.height / rect.height);

  const s = game.size;
  const margin = 40;
  const boardSizePx = Math.min(canvas.width, canvas.height) - margin*2;
  const cell = boardSizePx / (s - 1);
  const ox = (canvas.width - boardSizePx)/2;
  const oy = (canvas.height - boardSizePx)/2;

  const x = Math.round((px - ox) / cell);
  const y = Math.round((py - oy) / cell);
  if(x < 0 || x >= s || y < 0 || y >= s) return;

  const mv = {x,y,pass:false};
  const res = game.play(mv);
  if(!res.ok){
    logLine(`<span class="bad">Manual move illegal (${res.reason}).</span>`);
  }else{
    const who = (game.lastMove.color === BLACK) ? "B" : "W";
    logLine(`${who} ${moveToText(game.size, game.lastMove)} <span class="dim">(manual)</span>`);
  }
  openingBookActive = false; // if you intervene, book is no longer reliable
  draw();
  updateStatus();
});

// init
newGame();
