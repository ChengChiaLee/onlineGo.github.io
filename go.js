(() => {
  const canvas = document.getElementById("goCanvas");
  const ctx = canvas.getContext("2d");
  const autoPlayToggle = document.getElementById("autoPlayToggle");


  const sizeSel = document.getElementById("sizeSel");
  const starSel = document.getElementById("starSel");
  const newBtn  = document.getElementById("newBtn");
  const passBtn = document.getElementById("passBtn");
  const undoBtn = document.getElementById("undoBtn");
  const clearBtn= document.getElementById("clearBtn");

  const turnDot = document.getElementById("turnDot");
  const turnText= document.getElementById("turnText");
  const coordHint = document.getElementById("coordHint");
  const logEl  = document.getElementById("log");

  const capBEl = document.getElementById("capB");
  const capWEl = document.getElementById("capW");
  const moveNoEl = document.getElementById("moveNo");
  const lastMoveEl= document.getElementById("lastMove");

  const aiToggle = document.getElementById("aiToggle");
  const aiColorSel = document.getElementById("aiColorSel");
  const thinkMs = document.getElementById("thinkMs");
  const thinkMsLabel = document.getElementById("thinkMsLabel");
  const aiState = document.getElementById("aiState");

  // 0 empty, 1 black, 2 white
  let N = 19;
  let board = [];
  let toPlay = 1;

  // history: store boards AFTER each ply (including passes)
  // history[history.length-1] is current board position
  let history = [];
  let captures = {1:0, 2:0};
  let moves = [];
  let consecutivePasses = 0;

  // geometry
  let pad = 26, grid = 0, stoneR = 0;

  // AI
  let isThinking = false;
  let thinkToken = 0;
  const KOMI = 6.5; // used by MCTS eval

  function deepCopyBoard(b){ return b.map(r => r.slice()); }
  function sameBoard(a,b){
    if(!a || !b || a.length !== b.length) return false;
    for(let y=0;y<a.length;y++){
      for(let x=0;x<a.length;x++){
        if(a[y][x] !== b[y][x]) return false;
      }
    }
    return true;
  }

  function inBounds(x,y){ return x>=0 && x<N && y>=0 && y<N; }
  function neighbors(x,y){
    const out = [];
    if(x>0) out.push([x-1,y]);
    if(x+1<N) out.push([x+1,y]);
    if(y>0) out.push([x,y-1]);
    if(y+1<N) out.push([x,y+1]);
    return out;
  }

  function groupInfo(b, sx, sy){
    const color = b[sy][sx];
    const stack = [[sx,sy]];
    const seen = Array.from({length:N}, () => Array(N).fill(false));
    seen[sy][sx] = true;
    const stones = [];
    const libs = new Set();

    while(stack.length){
      const [x,y] = stack.pop();
      stones.push([x,y]);
      for(const [nx,ny] of neighbors(x,y)){
        const v = b[ny][nx];
        if(v === 0) libs.add(nx + "," + ny);
        else if(v === color && !seen[ny][nx]){
          seen[ny][nx] = true;
          stack.push([nx,ny]);
        }
      }
    }
    return {stones, liberties:libs};
  }

  function removeStones(b, stones){
    for(const [x,y] of stones) b[y][x] = 0;
  }

  function coordName(x,y){
    const letters = "ABCDEFGHJKLMNOPQRSTUVWXZY"; // skip I
    const col = letters[x] || "?";
    const row = (N - y);
    return col + row;
  }

  function computeStarPoints(n){
    if(n === 19) return [[3,3],[9,3],[15,3],[3,9],[9,9],[15,9],[3,15],[9,15],[15,15]];
    if(n === 13) return [[3,3],[6,3],[9,3],[3,6],[6,6],[9,6],[3,9],[6,9],[9,9]];
    if(n === 9)  return [[2,2],[4,2],[6,2],[2,4],[4,4],[6,4],[2,6],[4,6],[6,6]];
    return [];
  }

  function setTurnUI(){
    if(toPlay === 1){
      turnDot.classList.remove("white");
      turnDot.classList.add("black");
      turnText.textContent = "Black to play";
    }else{
      turnDot.classList.remove("black");
      turnDot.classList.add("white");
      turnText.textContent = "White to play";
    }
  }

  function setAIState(s){ aiState.textContent = s; }

  function log(msg, ok=true){
    const line = (ok ? "[OK] " : "[ERR] ") + msg;
    const prev = logEl.textContent.trim();
    logEl.textContent = prev ? (prev + "\n" + line) : line;
    const lines = logEl.textContent.split("\n");
    if(lines.length > 22) logEl.textContent = lines.slice(lines.length-22).join("\n");
  }

  function updateKPIs(){
    capBEl.textContent = String(captures[1]);
    capWEl.textContent = String(captures[2]);
    moveNoEl.textContent = String(moves.length);
    lastMoveEl.textContent = moves.length ? moves[moves.length-1].label : "—";
  }

  function resize(){
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width  = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);

    const minSide = rect.width;
    pad = Math.max(18, minSide * 0.055);
    grid = (minSide - 2*pad) / (N - 1);
    stoneR = grid * 0.46;
    draw();
  }

  function draw(){
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;

    ctx.clearRect(0,0,w,w);

    // grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--line").trim() || "rgba(0,0,0,.6)";
    for(let i=0;i<N;i++){
      const x = pad + i*grid;
      const y = pad + i*grid;

      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad + (N-1)*grid, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, pad + (N-1)*grid); ctx.stroke();
    }

    // star points
    if(starSel.value === "auto"){
      const stars = computeStarPoints(N);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--star").trim() || "rgba(0,0,0,.65)";
      for(const [sx,sy] of stars){
        const x = pad + sx*grid;
        const y = pad + sy*grid;
        ctx.beginPath();
        ctx.arc(x,y, Math.max(2.1, grid*0.12), 0, Math.PI*2);
        ctx.fill();
      }
    }

    // stones
    for(let y=0;y<N;y++){
      for(let x=0;x<N;x++){
        const v = board[y][x];
        if(v === 0) continue;

        const cx = pad + x*grid;
        const cy = pad + y*grid;

        // shadow
        ctx.beginPath();
        ctx.fillStyle = "rgba(0,0,0,.22)";
        ctx.arc(cx + grid*0.06, cy + grid*0.06, stoneR*0.98, 0, Math.PI*2);
        ctx.fill();

        // stone body
        if(v === 1){
          // BLACK: solid (實心)
          ctx.beginPath();
          ctx.fillStyle = "#0b0f14";
          ctx.arc(cx, cy, stoneR, 0, Math.PI*2);
          ctx.fill();

          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(255,255,255,.06)";
          ctx.stroke();
        }else{
          // WHITE: slightly shaded
          const grad = ctx.createRadialGradient(
            cx - stoneR*0.35, cy - stoneR*0.35, stoneR*0.2,
            cx, cy, stoneR*1.2
          );
          grad.addColorStop(0, "#ffffff");
          grad.addColorStop(1, "#d7dbe6");

          ctx.beginPath();
          ctx.fillStyle = grad;
          ctx.arc(cx, cy, stoneR, 0, Math.PI*2);
          ctx.fill();

          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(0,0,0,.18)";
          ctx.stroke();
        }
      }
    }
  }

  // -----------------------------
  // Game rules (simple ko = cannot repeat previous position)
  // Compare candidate next board to previous board (history[-2]) when available.
  // -----------------------------
  function applyMove(b, player, mv, prevBoard){
    // mv: {x,y} or null for pass
    if(mv === null) return {board: deepCopyBoard(b), captured: 0, pass: true};

    const x = mv.x, y = mv.y;
    if(!inBounds(x,y)) return null;
    if(b[y][x] !== 0) return null;

    const opp = (player === 1 ? 2 : 1);
    const nb = deepCopyBoard(b);
    nb[y][x] = player;

    // capture opponent groups with no liberties
    let captured = 0;
    const removedGroups = [];
    for(const [nx,ny] of neighbors(x,y)){
      if(nb[ny][nx] !== opp) continue;
      const info = groupInfo(nb, nx, ny);
      if(info.liberties.size === 0) removedGroups.push(info.stones);
    }
    for(const stones of removedGroups){
      captured += stones.length;
      removeStones(nb, stones);
    }

    // suicide check
    const myInfo = groupInfo(nb, x, y);
    if(myInfo.liberties.size === 0) return null;

    // simple ko: forbid repeating previous position
    if(prevBoard && sameBoard(nb, prevBoard)) return null;

    return {board: nb, captured, pass: false};
  }

  function currentPrevBoard(){
    // previous position (one ply ago)
    if(history.length >= 2) return history[history.length - 2];
    return null;
  }

  function playMoveInternal(x,y){
    const prev = currentPrevBoard();
    const res = applyMove(board, toPlay, {x,y}, prev);
    if(!res) return {ok:false, msg:`Illegal move at ${coordName(x,y)}.`};

    board = res.board;
    history.push(deepCopyBoard(board));

    if(res.captured) captures[toPlay] += res.captured;

    const label = (toPlay===1?"B ":"W ") + coordName(x,y) + (res.captured?` (+${res.captured})`:"");
    moves.push({type:"move", player:toPlay, x, y, captured:res.captured, label});
    consecutivePasses = 0;

    toPlay = (toPlay===1?2:1);
    setTurnUI();
    updateKPIs();
    draw();
    return {ok:true, msg:`Played ${label}.`};
  }

  function pass(){
    const prev = currentPrevBoard();
    const res = applyMove(board, toPlay, null, prev);
    board = res.board;
    history.push(deepCopyBoard(board));

    moves.push({type:"pass", player:toPlay, label:(toPlay===1?"B pass":"W pass")});
    consecutivePasses += 1;

    const pName = (toPlay===1?"Black":"White");
    toPlay = (toPlay===1?2:1);

    setTurnUI();
    updateKPIs();
    draw();
    log(`${pName} passes.`);

    if(consecutivePasses >= 2){
      log("Two consecutive passes: game end (no scoring UI).");
      consecutivePasses = 0;
    }
    maybeAIMove();
  }

  function undo(){
    if(history.length <= 1 || moves.length === 0){
      log("Nothing to undo.", false);
      return;
    }

    // cancel AI in-flight
    thinkToken++;
    isThinking = false;
    setAIState("idle");

    history.pop();
    board = deepCopyBoard(history[history.length - 1]);

    const last = moves.pop();
    if(last.type === "move" && last.captured){
      captures[last.player] -= last.captured;
      if(captures[last.player] < 0) captures[last.player] = 0;
    }

    toPlay = last.player;
    consecutivePasses = 0;

    setTurnUI();
    updateKPIs();
    draw();
    log(`Undid: ${last.label}.`);

    maybeAIMove();
  }

  function clearBoardOnly(){
    thinkToken++;
    isThinking = false;
    setAIState("idle");

    board = Array.from({length:N}, () => Array(N).fill(0));
    toPlay = 1;
    captures = {1:0, 2:0};
    history = [deepCopyBoard(board)];
    moves = [];
    consecutivePasses = 0;

    setTurnUI();
    updateKPIs();
    draw();
    log("Board cleared.");
    maybeAIMove();
  }

  function resetGame(newSize){
    thinkToken++;
    isThinking = false;
    setAIState("idle");

    N = newSize;
    board = Array.from({length:N}, () => Array(N).fill(0));
    toPlay = 1;
    captures = {1:0, 2:0};
    history = [deepCopyBoard(board)];
    moves = [];
    consecutivePasses = 0;

    setTurnUI();
    updateKPIs();
    logEl.textContent = "";
    resize();
    log(`New ${N}×${N} game started.`);
    maybeAIMove();
  }

  // -----------------------------
  // Mouse mapping
  // -----------------------------
  function closestIntersection(px,py){
    const ix = Math.round((px - pad) / grid);
    const iy = Math.round((py - pad) / grid);
    if(!inBounds(ix,iy)) return null;

    const cx = pad + ix*grid;
    const cy = pad + iy*grid;
    const dist2 = (px-cx)*(px-cx) + (py-cy)*(py-cy);
    const tol = (grid*0.55)*(grid*0.55);
    if(dist2 > tol) return null;

    return {ix,iy, label: coordName(ix,iy)};
  }

  // -----------------------------
  // MCTS (UCT) in JS
  // - uses local move pruning to keep branching manageable
  // - rollouts are light + biased toward captures
  // -----------------------------
  function boardKey(b){
    // fast-ish string key; enough for local use
    let s = "";
    for(let y=0;y<N;y++){
      for(let x=0;x<N;x++) s += String(b[y][x]);
      s += "|";
    }
    return s;
  }

  function occupiedPoints(b){
    const pts = [];
    for(let y=0;y<N;y++) for(let x=0;x<N;x++) if(b[y][x] !== 0) pts.push([x,y]);
    return pts;
  }

  function captureCandidates(b, player){
    const opp = (player===1?2:1);
    const cand = new Set();
    const seen = Array.from({length:N}, () => Array(N).fill(false));
    for(let y=0;y<N;y++){
      for(let x=0;x<N;x++){
        if(b[y][x] !== opp || seen[y][x]) continue;
        const info = groupInfo(b, x, y);
        for(const [sx,sy] of info.stones) seen[sy][sx] = true;
        if(info.liberties.size === 1){
          const one = info.liberties.values().next().value; // "x,y"
          const [lx,ly] = one.split(",").map(Number);
          if(b[ly][lx] === 0) cand.add(lx + "," + ly);
        }
      }
    }
    return cand;
  }

  function localCandidateMoves(b){
    const occ = occupiedPoints(b);
    if(occ.length === 0){
      const c = Math.floor(N/2);
      return new Set([c + "," + c]);
    }
    const cand = new Set();
    for(const [x,y] of occ){
      for(let dx=-2; dx<=2; dx++){
        for(let dy=-2; dy<=2; dy++){
          if(Math.abs(dx) + Math.abs(dy) > 2) continue;
          const nx = x+dx, ny = y+dy;
          if(inBounds(nx,ny) && b[ny][nx] === 0) cand.add(nx + "," + ny);
        }
      }
    }
    return cand;
  }

  function legalMovesForMCTS(b, player, prevBoard){
    // union: capture candidates + local candidates + a few random empties if too small
    const s = new Set();
    for(const k of captureCandidates(b, player)) s.add(k);
    for(const k of localCandidateMoves(b)) s.add(k);

    if(s.size < 10){
      const empties = [];
      for(let y=0;y<N;y++) for(let x=0;x<N;x++) if(b[y][x] === 0) empties.push([x,y]);
      for(let i=empties.length-1;i>0;i--){
        const j = (Math.random() * (i+1)) | 0;
        [empties[i], empties[j]] = [empties[j], empties[i]];
      }
      for(let i=0;i<Math.min(40, empties.length); i++){
        s.add(empties[i][0] + "," + empties[i][1]);
      }
    }

    const out = [];
    for(const key of s){
      const [x,y] = key.split(",").map(Number);
      const res = applyMove(b, player, {x,y}, prevBoard);
      if(res) out.push({x,y});
    }
    out.push(null); // pass always allowed
    return out;
  }

  function trompTaylorWinner(b, komi){
    // area scoring approximation (stones + surrounded empty regions)
    let bSt = 0, wSt = 0;
    for(let y=0;y<N;y++){
      for(let x=0;x<N;x++){
        if(b[y][x] === 1) bSt++;
        else if(b[y][x] === 2) wSt++;
      }
    }

    const seen = Array.from({length:N}, () => Array(N).fill(false));
    let bTerr = 0, wTerr = 0;

    for(let y0=0;y0<N;y0++){
      for(let x0=0;x0<N;x0++){
        if(b[y0][x0] !== 0 || seen[y0][x0]) continue;
        // flood empty region
        const stack = [[x0,y0]];
        seen[y0][x0] = true;
        const region = [];
        const borders = new Set();

        while(stack.length){
          const [x,y] = stack.pop();
          region.push([x,y]);
          for(const [nx,ny] of neighbors(x,y)){
            const v = b[ny][nx];
            if(v === 0 && !seen[ny][nx]){
              seen[ny][nx] = true;
              stack.push([nx,ny]);
            }else if(v === 1 || v === 2){
              borders.add(v);
            }
          }
        }

        if(borders.size === 1){
          const c = borders.values().next().value;
          if(c === 1) bTerr += region.length;
          else wTerr += region.length;
        }
      }
    }

    const bScore = bSt + bTerr;
    const wScore = wSt + wTerr + komi;

    if(bScore > wScore) return 1;
    if(wScore > bScore) return 2;
    return 0;
  }

  function rolloutSim(startBoard, startPlayer, startPrevBoard, startPasses, komi, maxPlies){
    let b = deepCopyBoard(startBoard);
    let player = startPlayer;
    let prevBoard = startPrevBoard;
    let passes = startPasses;

    for(let ply=0; ply<maxPlies; ply++){
      if(passes >= 2) break;

      // biased to captures
      let mv = null;
      const caps = Array.from(captureCandidates(b, player));
      if(caps.length){
        for(let k=0; k<Math.min(8, caps.length); k++){
          const idx = (Math.random() * caps.length) | 0;
          const [x,y] = caps[idx].split(",").map(Number);
          const tryRes = applyMove(b, player, {x,y}, prevBoard);
          if(tryRes){
            mv = {x,y};
            b = tryRes.board;
            prevBoard = deepCopyBoard(prevBoard ? prevBoard : prevBoard); // keep reference safe
            prevBoard = deepCopyBoard(prevBoard ?? b); // overwritten below anyway
            break;
          }
        }
      }

      if(mv === null){
        const mvs = legalMovesForMCTS(b, player, prevBoard);
        const nonPass = mvs.filter(x => x !== null);
        let chosen = null;

        if(nonPass.length) chosen = nonPass[(Math.random() * nonPass.length) | 0];
        else chosen = null;

        const res = applyMove(b, player, chosen, prevBoard);
        if(!res){
          // fallback pass
          const r2 = applyMove(b, player, null, prevBoard);
          b = r2.board;
          passes += 1;
          prevBoard = deepCopyBoard(b); // after pass, "prev position" becomes old position; approximation OK
        }else{
          const old = b;
          b = res.board;
          passes = (chosen === null) ? (passes + 1) : 0;
          prevBoard = old;
        }
      }else{
        // if capture chosen
        const old = b; // note: b already updated above in capture branch; keep correct prevBoard update
        // This path is messy; easiest: re-apply properly:
        const res = applyMove(old, player, mv, prevBoard);
        if(res){
          const pre = old;
          b = res.board;
          prevBoard = pre;
          passes = 0;
        }else{
          const r2 = applyMove(old, player, null, prevBoard);
          b = r2.board;
          prevBoard = old;
          passes += 1;
        }
      }

      player = (player===1?2:1);
    }

    return trompTaylorWinner(b, komi);
  }

  class MCTSNode{
    constructor(board, player, prevBoard, passes, parent=null, move=null){
      this.board = board;
      this.player = player;     // to play at this node
      this.prevBoard = prevBoard; // previous position (for simple ko)
      this.passes = passes;

      this.parent = parent;
      this.move = move;
      this.children = [];
      this.untried = null;

      this.visits = 0;
      this.wins = 0.0; // from ROOT player's perspective
    }
    ensureUntried(){
      if(this.untried === null){
        this.untried = legalMovesForMCTS(this.board, this.player, this.prevBoard);
      }
    }
  }

  function uctSelect(node, c=1.35){
    const lnN = Math.log(Math.max(1, node.visits));
    let best = null;
    let bestVal = -1e100;

    for(const ch of node.children){
      if(ch.visits === 0) return ch;
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

  function mctsAsync(rootBoard, rootPlayer, rootPrevBoard, komi, thinkingMs){
    const start = performance.now();
    const deadline = start + Math.max(50, thinkingMs);

    const root = new MCTSNode(deepCopyBoard(rootBoard), rootPlayer, rootPrevBoard ? deepCopyBoard(rootPrevBoard) : null, 0);
    root.ensureUntried();

    const maxPlies = Math.min(N*N*2, (N===9?180:(N===13?260:320)));

    let iters = 0;

    function iterateOnce(){
      iters++;
      let node = root;

      // selection
      while(true){
        node.ensureUntried();
        if(node.untried && node.untried.length > 0) break;
        if(node.children.length === 0) break;
        node = uctSelect(node);
      }

      // expansion
      node.ensureUntried();
      if(node.untried && node.untried.length > 0){
        const idx = (Math.random() * node.untried.length) | 0;
        const mv = node.untried[idx];
        node.untried[idx] = node.untried[node.untried.length - 1];
        node.untried.pop();

        const res = applyMove(node.board, node.player, mv, node.prevBoard);
        if(!res){
          return; // illegal candidate
        }

        const nextPlayer = (node.player===1?2:1);
        const nextPasses = mv === null ? (node.passes + 1) : 0;

        // child's "prevBoard" is this node's board (previous position for next move)
        const childPrev = node.board;

        const child = new MCTSNode(res.board, nextPlayer, childPrev, nextPasses, node, mv);
        node.children.push(child);
        node = child;
      }

      // simulation
      const winner = rolloutSim(node.board, node.player, node.prevBoard, node.passes, komi, maxPlies);

      // backprop (root-player perspective)
      const result = (winner === rootPlayer) ? 1.0 : (winner === 0 ? 0.5 : 0.0);
      while(node){
        node.visits += 1;
        node.wins += result;
        node = node.parent;
      }
    }

    return new Promise(resolve => {
      function loop(){
        const tokenSliceEnd = Math.min(deadline, performance.now() + 12); // yield every ~12ms
        while(performance.now() < tokenSliceEnd && performance.now() < deadline){
          iterateOnce();
        }

        if(performance.now() < deadline){
          setTimeout(loop, 0);
        }else{
          // choose child with max visits
          let best = null;
          for(const ch of root.children){
            if(!best || ch.visits > best.visits) best = ch;
          }
          resolve({move: best ? best.move : null, iters});
        }
      }
      loop();
    });
  }

  // -----------------------------
  // AI integration
  // -----------------------------
  function isAITurn(){
    if(!aiToggle.checked) return false;

    // If autoplay is on, BOTH sides are AI.
    if(autoPlayToggle && autoPlayToggle.checked) return true;

    const aiColor = parseInt(aiColorSel.value, 10);
    return toPlay === aiColor;
  }


  async function maybeAIMove(){
    if(!isAITurn() || isThinking) return;

    // prevent human input while thinking
    isThinking = true;
    const myToken = ++thinkToken;
    setAIState("thinking");

    const ms = parseInt(thinkMs.value, 10);
    const prev = currentPrevBoard();

    try{
      const {move, iters} = await mctsAsync(board, toPlay, prev, KOMI, ms);

      // canceled by undo/new/etc
      if(myToken !== thinkToken){
        isThinking = false;
        setAIState("idle");
        return;
      }

      if(!isAITurn()){
        isThinking = false;
        setAIState("idle");
        return;
      }

      setAIState(`move (${iters} iters)`);

      if(move === null){
        isThinking = false;
        setAIState("idle");
        log("AI plays: pass");
        pass(); // pass() calls maybeAIMove() again
        return;
      }

      const res = playMoveInternal(move.x, move.y);
      isThinking = false;
      setAIState("idle");
      log(`AI plays: ${coordName(move.x, move.y)} (${iters} iters)`, res.ok);

      if(!res.ok){
        log("AI produced illegal move; forcing pass.", false);
        pass();
        return;
      }

      maybeAIMove();
    }catch(e){
      isThinking = false;
      setAIState("idle");
      log(`AI error: ${String(e)}`, false);
    }
  }
  function kickAutoplay(){
    if(!autoPlayToggle || !autoPlayToggle.checked) return;
    // Keep the engine moving; maybeAIMove() is safe-guarded by isThinking.
    maybeAIMove();
  }

  // -----------------------------
  // UI events
  // -----------------------------
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const p = closestIntersection(e.clientX - rect.left, e.clientY - rect.top);
    coordHint.textContent = p ? `Hover: ${p.label}` : "—";
  });
  canvas.addEventListener("mouseleave", () => coordHint.textContent = "—");

  canvas.addEventListener("click", (e) => {
    if(isThinking) return;
    if(isAITurn()) return;

    const rect = canvas.getBoundingClientRect();
    const p = closestIntersection(e.clientX - rect.left, e.clientY - rect.top);
    if(!p) return;

    const res = playMoveInternal(p.ix, p.iy);
    log(res.msg, res.ok);
    maybeAIMove();
  });

  newBtn.addEventListener("click", () => resetGame(parseInt(sizeSel.value,10)));
  passBtn.addEventListener("click", () => { if(!isThinking) pass(); });
  undoBtn.addEventListener("click", undo);
  clearBtn.addEventListener("click", clearBoardOnly);

  sizeSel.addEventListener("change", () => resetGame(parseInt(sizeSel.value,10)));
  starSel.addEventListener("change", draw);

  aiToggle.addEventListener("change", () => { setAIState("idle"); maybeAIMove(); });
  aiColorSel.addEventListener("change", () => { setAIState("idle"); maybeAIMove(); });

  if(autoPlayToggle){
    autoPlayToggle.addEventListener("change", () => {
      setAIState("idle");
      if(autoPlayToggle.checked){
        // ensure AI is enabled
        aiToggle.checked = true;
      }
      maybeAIMove();
    });
  }


  thinkMs.addEventListener("input", () => thinkMsLabel.textContent = thinkMs.value);
  thinkMsLabel.textContent = thinkMs.value;

  window.addEventListener("resize", resize);

  // init
  function init(){
    board = Array.from({length:N}, () => Array(N).fill(0));
    toPlay = 1;
    captures = {1:0, 2:0};
    history = [deepCopyBoard(board)];
    moves = [];
    consecutivePasses = 0;

    setTurnUI();
    updateKPIs();
    setAIState("idle");
    resize();
    log("Ready.");
    maybeAIMove();
  }

  init();
})();
