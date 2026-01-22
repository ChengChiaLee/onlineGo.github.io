(() => {
  const canvas = document.getElementById("goCanvas");
  const ctx = canvas.getContext("2d");

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
  let captures = {1:0, 2:0};
  let history = []; // deep copies of board after each ply (including passes)
  let moves = [];
  let consecutivePasses = 0;

  // geometry
  let pad = 26;
  let grid = 0;
  let stoneR = 0;

  let isThinking = false;
  const KOMI = 6.5; // UI does not change komi; server uses this for eval

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
    if(inBounds(x-1,y)) out.push([x-1,y]);
    if(inBounds(x+1,y)) out.push([x+1,y]);
    if(inBounds(x,y-1)) out.push([x,y-1]);
    if(inBounds(x,y+1)) out.push([x,y+1]);
    return out;
  }

  function groupInfo(b, sx, sy){
    const color = b[sy][sx];
    const q = [[sx,sy]];
    const seen = Array.from({length:N}, () => Array(N).fill(false));
    seen[sy][sx] = true;

    const stones = [];
    const libs = new Set();
    while(q.length){
      const [x,y] = q.pop();
      stones.push([x,y]);
      for(const [nx,ny] of neighbors(x,y)){
        const v = b[ny][nx];
        if(v === 0) libs.add(nx + "," + ny);
        else if(v === color && !seen[ny][nx]){
          seen[ny][nx] = true;
          q.push([nx,ny]);
        }
      }
    }
    return {stones, liberties:libs};
  }

  function removeStones(b, stones){
    for(const [x,y] of stones) b[y][x] = 0;
  }

  function coordName(x,y){
    const letters = "ABCDEFGHJKLMNOPQRSTUVWXZY"; // skips I
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

  function log(msg, ok=true){
    const line = (ok ? "[OK] " : "[ERR] ") + msg;
    const prev = logEl.textContent.trim();
    logEl.textContent = prev ? (prev + "\n" + line) : line;
    const lines = logEl.textContent.split("\n");
    if(lines.length > 20) logEl.textContent = lines.slice(lines.length-20).join("\n");
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

    const w = rect.width;
    const minSide = w;
    pad = Math.max(18, minSide * 0.055);
    grid = (minSide - 2*pad) / (N - 1);
    stoneR = grid * 0.46;
    draw();
  }

  function draw(){
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;

    ctx.clearRect(0,0,w,w);

    // grid lines
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

        const grad = ctx.createRadialGradient(
          cx - stoneR*0.35, cy - stoneR*0.35, stoneR*0.2,
          cx, cy, stoneR*1.2
        );
        if(v === 1){
          grad.addColorStop(0, "rgba(255,255,255,.18)");
          grad.addColorStop(1, "#0b0f14");
        }else{
          grad.addColorStop(0, "#ffffff");
          grad.addColorStop(1, "#d7dbe6");
        }

        ctx.beginPath();
        ctx.fillStyle = grad;
        ctx.arc(cx, cy, stoneR, 0, Math.PI*2);
        ctx.fill();

        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,.25)";
        ctx.stroke();
      }
    }
  }

  function isLegalAndApply(x,y){
    if(board[y][x] !== 0) return {ok:false, msg:`${coordName(x,y)} occupied.`};

    const me = toPlay;
    const opp = (me === 1 ? 2 : 1);
    const next = deepCopyBoard(board);
    next[y][x] = me;

    // capture adjacent opponent groups with no liberties
    let captured = 0;
    const groupsToRemove = [];
    for(const [nx,ny] of neighbors(x,y)){
      if(next[ny][nx] !== opp) continue;
      const info = groupInfo(next, nx, ny);
      if(info.liberties.size === 0) groupsToRemove.push(info.stones);
    }
    for(const stones of groupsToRemove){
      captured += stones.length;
      removeStones(next, stones);
    }

    // suicide check
    const myInfo = groupInfo(next, x, y);
    if(myInfo.liberties.size === 0){
      return {ok:false, msg:`Illegal suicide at ${coordName(x,y)}.`};
    }

    // simple ko
    if(history.length >= 2 && sameBoard(next, history[history.length-2])){
      return {ok:false, msg:`Illegal ko at ${coordName(x,y)}.`};
    }

    // commit
    board = next;
    history.push(deepCopyBoard(board));
    if(captured) captures[me] += captured;

    const label = (me===1?"B ":"W ") + coordName(x,y) + (captured?` (+${captured})`:"");
    moves.push({type:"move", player:me, x, y, captured, label});
    consecutivePasses = 0;

    toPlay = opp;
    setTurnUI();
    updateKPIs();
    draw();

    return {ok:true, msg:`Played ${label}.`};
  }

  function playMove(x,y){
    const res = isLegalAndApply(x,y);
    log(res.msg, res.ok);
    maybeAIMove();
  }

  function pass(){
    const me = toPlay;
    const opp = (me === 1 ? 2 : 1);
    history.push(deepCopyBoard(board));
    moves.push({type:"pass", player:me, label:(me===1?"B pass":"W pass")});
    consecutivePasses += 1;

    toPlay = opp;
    setTurnUI();
    updateKPIs();
    draw();
    log(`${me===1?"Black":"White"} passes.`);

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
    history.pop();
    board = deepCopyBoard(history[history.length-1]);

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

    // If AI was thinking, ignore its pending result.
    isThinking = false;
    setAIState("idle");
  }

  function clearBoardOnly(){
    board = Array.from({length:N}, () => Array(N).fill(0));
    toPlay = 1;
    captures = {1:0, 2:0};
    history = [deepCopyBoard(board)];
    moves = [];
    consecutivePasses = 0;
    isThinking = false;

    setTurnUI();
    updateKPIs();
    draw();
    log("Board cleared.");
    setAIState("idle");
    maybeAIMove();
  }

  function resetGame(newSize){
    N = newSize;
    board = Array.from({length:N}, () => Array(N).fill(0));
    toPlay = 1;
    captures = {1:0, 2:0};
    history = [deepCopyBoard(board)];
    moves = [];
    consecutivePasses = 0;
    isThinking = false;

    setTurnUI();
    updateKPIs();
    logEl.textContent = "";
    resize();
    log(`New ${N}×${N} game started.`);
    setAIState("idle");
    maybeAIMove();
  }

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

  function setAIState(s){ aiState.textContent = s; }

  function isAITurn(){
    if(!aiToggle.checked) return false;
    const aiColor = parseInt(aiColorSel.value, 10);
    return toPlay === aiColor;
  }

  async function requestAIMove(){
    if(isThinking) return;
    isThinking = true;
    setAIState("thinking");

    const koBoard = (history.length >= 2) ? history[history.length-2] : null;
    const payload = {
      size: N,
      board: board,
      toPlay: toPlay,
      ko: koBoard,
      komi: KOMI,
      thinking_ms: parseInt(thinkMs.value, 10)
    };

    try{
      const resp = await fetch("/api/move", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(payload)
      });
      if(!resp.ok){
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt}`);
      }
      const data = await resp.json();

      // If user changed state (undo/new) mid-think, we just stop.
      if(!isAITurn()){
        isThinking = false;
        setAIState("idle");
        return;
      }

      if(data.pass){
        log("AI plays: pass");
        isThinking = false;
        setAIState("idle");
        pass();
        return;
      }

      const x = data.x, y = data.y;
      if(typeof x !== "number" || typeof y !== "number" || !inBounds(x,y)){
        log("AI returned invalid move; forcing pass.", false);
        isThinking = false;
        setAIState("idle");
        pass();
        return;
      }

      const res = isLegalAndApply(x,y);
      if(!res.ok){
        log(`AI suggested illegal move ${coordName(x,y)}; forcing pass.`, false);
        isThinking = false;
        setAIState("idle");
        pass();
        return;
      }
      log(`AI plays: ${(toPlay===1?"W ":"B ")}${coordName(x,y)}`); // toPlay already swapped; label is fine in log
      isThinking = false;
      setAIState("idle");
      maybeAIMove();
    }catch(err){
      log(`AI request failed: ${String(err)}`, false);
      isThinking = false;
      setAIState("idle");
    }
  }

  function maybeAIMove(){
    if(isAITurn()){
      // lock input during AI thinking
      requestAIMove();
    }
  }

  // UI events
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const p = closestIntersection(e.clientX - rect.left, e.clientY - rect.top);
    coordHint.textContent = p ? `Hover: ${p.label}` : "—";
  });
  canvas.addEventListener("mouseleave", () => coordHint.textContent = "—");

  canvas.addEventListener("click", (e) => {
    if(isThinking) return;
    if(isAITurn()) return; // prevent human from playing AI's turn
    const rect = canvas.getBoundingClientRect();
    const p = closestIntersection(e.clientX - rect.left, e.clientY - rect.top);
    if(!p) return;
    playMove(p.ix, p.iy);
  });

  newBtn.addEventListener("click", () => resetGame(parseInt(sizeSel.value,10)));
  passBtn.addEventListener("click", () => { if(!isThinking) pass(); });
  undoBtn.addEventListener("click", undo);
  clearBtn.addEventListener("click", clearBoardOnly);

  sizeSel.addEventListener("change", () => resetGame(parseInt(sizeSel.value,10)));
  starSel.addEventListener("change", draw);

  aiToggle.addEventListener("change", () => {
    setAIState("idle");
    maybeAIMove();
  });
  aiColorSel.addEventListener("change", () => {
    setAIState("idle");
    maybeAIMove();
  });

  thinkMs.addEventListener("input", () => thinkMsLabel.textContent = thinkMs.value);
  thinkMsLabel.textContent = thinkMs.value;

  window.addEventListener("resize", resize);

  // init
  resetGame(19);
})();
