/* 軍儀 Webアプリ: 盤面UI・CPU（Web Worker）・形勢表示 */
(function () {
  'use strict';
  const G = {};
  GungiCore(G);
  GungiAI(G);
  const W = G.upgradeWeights((typeof GUNGI_WEIGHTS !== 'undefined' && GUNGI_WEIGHTS) ? GUNGI_WEIGHTS : G.defaultWeights());
  const { Position, BLACK, WHITE, KANJI, NAMES, DONE, DROP, SETUP, MAIN, SUI } = G;
  const $ = id => document.getElementById(id);
  const FW = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SIDE = ['先手', '後手'];
  const MARK = ['▲', '△'];
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerType = 'mouse'; // 最後に使われた触れ方（タッチではホバーの表示を使わない）
  document.addEventListener('pointerdown', e => { pointerType = e.pointerType || 'mouse'; }, true);

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: 'すぐ指します。目の前の駒の取り合いだけ読みます', time: 300, depth: 1, noise: 120 },
    normal: { label: 'ふつう', stars: 2, desc: '3手先まで読みます', time: 700, depth: 3, noise: 15 },
    strong: { label: 'つよい', stars: 3, desc: '1手2秒。学習済みの評価で深く読みます', time: 2000 },
    max: { label: '最強', stars: 4, desc: '1手8秒。全力で読みます', time: 8000 },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const ANALYZE_MS = 6000, HINT_MS = 2500;

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('gungi-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('gungi-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'black', cpuB: 'strong', cpuW: 'strong', level: 'jokyu', setup: 'free' }, store.get('cfg2', {}));
  if (!G.LEVELS[cfg.level]) cfg.level = 'jokyu';
  // AI補助: showEval = 形勢（評価値・グラフ）を見せる、arrow = 最善手の矢印を見せる
  const settings = Object.assign({ sound: true, anim: true, arrow: true, reach: true, analyze: true, showEval: true }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.arrow;

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    level: 'jokyu', setup: 'free', seats: ['human', 'normal'],
    pos: null, moves: [], texts: [], evals: [], legal: [],
    view: null, dpos: null, sel: null, targets: new Map(),
    result: null, flip: false, info: null, cpuInfo: null, agents: [null, null], timer: 0, thinking: false,
    autoSetup: [null, null], hover: -1, resultShown: false,
    online: null,   // オンライン対局: { gid, myColor, opp: {name, ai, hints}, myHints, oppPresent, lostAt, myRe, oppRe }
    inspect: -1,    // 利きを見ている駒のマス（相手の駒や、動かせない自分の駒をタップしたとき）
    pending: -1,    // 「取る / ツケ」を選ぶメニューを出しているマス
  };
  const live = () => S.view === null;
  const shownPos = () => (live() ? S.pos : S.dpos);
  const shownPly = () => (live() ? S.moves.length : S.view);
  const isCPU = c => !!CPU[S.seats[c]];
  const isRemote = c => S.seats[c] === 'remote';
  const isHuman = c => S.seats[c] === 'human';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const seatLabel = c => (isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : isRemote(c) ? (S.online ? `${esc(S.online.opp.name)}さん` : '相手') : (S.seats[c ^ 1] !== 'human' ? 'あなた' : '人間'));

  // ------------------------------------------------------------------ CPU（Web Worker）
  // ワーカー: 'init' で重み（と共有の置換表・停止フラグ）を受け取り、'think' で読む
  function workerMain() {
    const G = {};
    GungiCore(G);
    GungiAI(G);
    let searcher = null, helper = 0;
    const pack = r => ({ move: r.move, score: r.score, depth: r.depth, pv: r.pv, nodes: r.nodes, time: r.time });
    self.onmessage = e => {
      const j = e.data;
      if (j.type === 'init') {
        helper = j.helper || 0;
        searcher = new G.Searcher(j.weights, { ttBits: 20, sharedTT: j.sharedTT, stopFlag: j.stopFlag, helper });
        return;
      }
      const pos = G.Position.fromMoves(j.level, j.moves, j.setup);
      // 評価にわざと揺らぎを入れる弱いCPUのあとは、置換表に残った雑な読みを捨てる
      if ((j.noise || 0) !== searcher.noise) searcher.clearTT();
      searcher.noise = j.noise || 0;
      searcher.salt = (Math.random() * 1e9) | 0;
      const onInfo = helper ? null : info => self.postMessage({ id: j.id, type: 'info', info: pack(info) });
      const r = searcher.think(pos, { timeMs: j.timeMs, maxDepth: j.maxDepth, analyze: j.analyze, jobId: j.id, onInfo });
      self.postMessage({ id: j.id, type: 'done', helper, info: pack(r) });
    };
  }

  // CPU の思考。ページが共有メモリを使える状態（start.bat のサーバで開いたとき）なら、
  // 複数のワーカーが置換表を共有して同じ局面を読む（Lazy SMP）。そうでなければワーカー1つで読む。
  const SMP = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  const THREADS = SMP ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  const AI = {
    pool: [], id: 0, busy: false, fallback: null,
    tt: SMP ? G.makeTT(21, true) : null,
    flag: SMP ? new SharedArrayBuffer(4) : null,
    make(i) {
      try {
        const src = GungiCore.toString() + '\n' + GungiAI.toString() + '\n(' + workerMain.toString() + ')();';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.postMessage({ type: 'init', weights: W, sharedTT: this.tt, stopFlag: this.flag, helper: i });
        return w;
      } catch (e) {
        return null; // Worker が使えない環境ではメインスレッドで考える
      }
    },
    ensure(n) {
      while (this.pool.length < n) { const w = this.make(this.pool.length); if (!w) break; this.pool.push(w); }
      return this.pool.length;
    },
    start(job, onInfo, onDone) {
      this.cancel();
      const id = ++this.id;
      this.busy = true;
      const n = this.ensure(job.parallel ? THREADS : 1);
      const finish = r => { if (id !== this.id) return; this.busy = false; onDone(r); };
      if (!n) {
        setTimeout(() => {
          if (id !== this.id) return;
          if (!this.fallback) this.fallback = new G.Searcher(W, { ttBits: 18 });
          const pos = Position.fromMoves(job.level, job.moves, job.setup);
          this.fallback.noise = job.noise || 0;
          finish(this.fallback.think(pos, { timeMs: Math.min(job.timeMs, 1500), maxDepth: job.maxDepth, analyze: job.analyze }));
        }, 30);
        return;
      }
      if (this.flag) Atomics.store(new Int32Array(this.flag), 0, id);
      const msg = { type: 'think', id, level: job.level, setup: job.setup, moves: job.moves, noise: job.noise, timeMs: job.timeMs, maxDepth: job.maxDepth, analyze: job.analyze };
      this.pool.slice(0, n).forEach((w, i) => {
        w.onmessage = e => {
          const m = e.data;
          if (m.id !== this.id || i !== 0) return; // 結果は主ワーカー（0番）のものを使う
          if (m.type === 'info') { if (onInfo) onInfo(m.info); return; }
          if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -id); // 補助ワーカーも止める
          finish(m.info);
        };
        w.postMessage(msg);
      });
    },
    cancel() {
      if (this.busy) {
        if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -this.id); // 共有の停止フラグで全員止める（置換表は残る）
        else { this.pool.forEach(w => w.terminate()); this.pool = []; } // 止められないので作り直す
      }
      this.busy = false;
      this.id++;
    },
  };

  // ------------------------------------------------------------------ 駒音（WebAudio で合成）
  let actx = null;
  function clack(kind) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime, len = 0.06, n = Math.floor(actx.sampleRate * len);
      const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 5);
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'cap' ? 950 : kind === 'tsuke' ? 1500 : 1250; bp.Q.value = 2.2;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'cap' ? 1.6 : 1.1, t);
      src.connect(bp).connect(g).connect(actx.destination);
      src.start(t);
      const o = actx.createOscillator(), og = actx.createGain();
      o.frequency.setValueAtTime(kind === 'cap' ? 160 : 220, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
      og.gain.setValueAtTime(0.35, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.1);
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg2', cfg);
    AI.cancel(); clearTimeout(S.timer);
    let seats;
    if (cfg.mode === 'pvp') seats = ['human', 'human'];
    else if (cfg.mode === 'watch') seats = [cfg.cpuB, cfg.cpuW];
    else {
      const humanColor = cfg.side === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : cfg.side === 'white' ? WHITE : BLACK;
      seats = humanColor === BLACK ? ['human', cfg.cpu] : [cfg.cpu, 'human'];
    }
    loadGame({ level: cfg.level, setup: cfg.setup, seats, moves: [] });
  }

  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.level = g.level; S.setup = g.setup; S.seats = g.seats; S.online = g.online || null;
    S.pos = new Position(g.level, { setup: g.setup });
    S.moves = []; S.texts = []; S.evals = g.evals ? g.evals.slice() : [];
    for (const m of g.moves) { S.texts.push(S.pos.moveText(m)); S.pos.make(m); S.moves.push(m); }
    S.view = null; S.dpos = null; S.sel = null; S.result = g.result || null; S.info = null; S.cpuInfo = null;
    S.agents = [0, 1].map(() => new G.Agent(W, { ttBits: 8 }));
    S.autoSetup = [null, null];
    S.resultShown = !!g.result;
    S.flip = g.flip != null ? g.flip : (S.seats[BLACK] !== 'human' && S.seats[WHITE] === 'human');
    afterChange();
  }

  function saveGame() {
    const online = S.online ? { gid: S.online.gid, myColor: S.online.myColor, opp: S.online.opp, myHints: S.online.myHints } : null;
    store.set('game', { level: S.level, setup: S.setup, seats: S.seats, moves: S.moves, result: S.result, flip: S.flip, evals: S.evals.map(v => (v == null ? null : Math.round(v))), online });
  }

  function rebuild(n) {
    S.moves.length = n; S.texts.length = n; S.evals.length = Math.min(S.evals.length, n + 1);
    S.pos = Position.fromMoves(S.level, S.moves, S.setup);
    S.result = null; S.resultShown = false;
  }

  function play(m, fromRemote) {
    if (!m) return;
    const anim = animOrigin(m);
    const kind = m === DONE ? null : G.mvAct(m) === G.ACT_CAP ? 'cap' : G.mvAct(m) === G.ACT_TSUKE ? 'tsuke' : 'move';
    S.texts.push(S.pos.moveText(m));
    S.pos.make(m);
    S.moves.push(m);
    if (S.online && NET && !fromRemote) NET.send({ t: 'mv', n: S.moves.length, m });
    if (kind) clack(kind);
    afterChange(anim);
    if (S.online && NET) NET.saveState({ moves: S.moves, r: S.result ? 1 : 0 });
  }

  function afterChange(anim) {
    S.sel = null; S.targets = new Map(); S.hover = -1; S.inspect = -1;
    hideChooser();
    if (!S.result) S.result = S.pos.result();
    S.legal = S.result ? [] : S.pos.legalMoves();
    S.info = null; S.cpuInfo = null;
    if (live() && S.pos.phase === SETUP && isHuman(S.pos.stm) && S.pos.king[S.pos.stm] < 0) selectHand(SUI, false);
    saveGame();
    render();
    if (anim) runAnim(anim);
    if (S.result && !S.resultShown && live()) { S.resultShown = true; setTimeout(showResult, 450); }
    schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    if (!live() || S.result) { analyze(); return; }
    const c = S.pos.stm;
    if (S.pos.phase === SETUP && (isCPU(c) || S.autoSetup[c])) {
      AI.cancel();
      const tpl = S.autoSetup[c];
      S.timer = setTimeout(() => {
        const ag = S.agents[c];
        if (tpl) ag.template = tpl;
        play(ag.chooseSetup(S.pos, false));
      }, tpl ? 90 : 160);
      return;
    }
    if (isRemote(c)) { AI.cancel(); renderEval(); return; } // オンラインの相手の番: 届くのを待つ
    if (!isCPU(c)) { analyze(); return; }
    const cpu = CPU[S.seats[c]], ply = S.moves.length;
    S.thinking = true;
    renderPlayers();
    AI.start({ level: S.level, setup: S.setup, moves: S.moves.slice(), timeMs: cpu.time, maxDepth: cpu.depth, noise: cpu.noise, parallel: !cpu.depth },
      info => onInfo(ply, c, info, 'cpu'),
      info => {
        onInfo(ply, c, info, 'cpu');
        S.thinking = false;
        if (live() && S.moves.length === ply && !S.result) S.timer = setTimeout(() => play(info.move), 120);
      });
  }

  // 人間の手番（または棋譜を見返しているとき）に形勢を読む
  function analyze(force, ms) {
    const pos = shownPos();
    if (((!settings.analyze || !aiOn()) && !force) || pos.phase !== MAIN || pos.result()) { AI.cancel(); renderEval(); return; }
    const ply = shownPly(), c = pos.stm;
    AI.start({ level: S.level, setup: S.setup, moves: S.moves.slice(0, ply), timeMs: ms || ANALYZE_MS, analyze: true, parallel: true },
      info => onInfo(ply, c, info, 'analysis'), info => onInfo(ply, c, info, 'analysis'));
  }

  function onInfo(ply, c, info, kind) {
    if (!info || !info.depth) return;
    const scoreB = c === BLACK ? info.score : -info.score;
    // CPU（やさしい・ふつう）は読みが浅いので形勢グラフには使わない
    const cpuWeak = kind === 'cpu' && CPU[S.seats[c]] && CPU[S.seats[c]].noise;
    if (!cpuWeak || S.evals[ply] == null) S.evals[ply] = scoreB;
    const rec = { ply, scoreB, pv: info.pv || [], depth: info.depth, nodes: info.nodes, time: info.time, stm: c, kind };
    if (kind === 'cpu') S.cpuInfo = rec;
    if (!cpuWeak || !S.info || S.info.ply !== ply) S.info = rec;
    renderEval(); renderGraph(); renderKifu(); renderArrows();
    if (kind === 'cpu') renderPlayers();
  }

  // ------------------------------------------------------------------ 入力
  const humanTurn = () => live() && !S.result && isHuman(S.pos.stm) && !(S.pos.phase === SETUP && S.autoSetup[S.pos.stm]);

  // 盤のマスをタップしたとき
  //   ・自分の動かせる駒 → 選ぶ（行き先以外のマスがやんわり暗くなる。もう一度タップで解除）
  //   ・選んだ駒の行き先 → すぐ指す（取るとツケの両方ができるマスだけ、どちらにするかを選ぶ）
  //   ・相手の駒・動かせない自分の駒 → その駒の利きを見る（利き以外が暗くなる。もう一度タップで消す）
  //   ・空きマス → 選択や利きの表示を消す
  function onSquare(sq) {
    hideChooser();
    const pos = shownPos(), top = pos.topAt(sq);
    if (!humanTurn()) { setInspect(top && S.inspect !== sq ? sq : -1); return; }
    const c = pos.stm;
    if (S.sel && S.targets.has(sq)) {
      const ms = S.targets.get(sq);
      if (ms.length === 1) play(ms[0]); else showChooser(sq, ms);
      return;
    }
    if (pos.phase === SETUP) {
      if (!(S.sel && S.sel.hand)) setInspect(top && S.inspect !== sq ? sq : -1);
      return; // 配置中は選んだ手駒を保つ
    }
    if (top && (top >> 4) === c && canMoveFrom(sq)) {
      if (S.sel && S.sel.sq === sq) { clearSel(); return; }
      S.inspect = -1;
      selectSq(sq);
      return;
    }
    S.sel = null; S.targets = new Map();
    setInspect(top && S.inspect !== sq ? sq : -1);
  }
  const canMoveFrom = sq => S.legal.some(m => m !== DONE && G.mvFrom(m) === sq);
  function setInspect(sq) {
    S.inspect = sq;
    renderBoard(); renderPlayers(); renderSqInfo();
  }
  function clearSel() {
    S.sel = null; S.targets = new Map(); S.inspect = -1;
    renderBoard(); renderPlayers(); renderSqInfo();
  }

  function collectTargets(pred) {
    const t = new Map();
    for (const m of S.legal) {
      if (m === DONE || !pred(m)) continue;
      const to = G.mvTo(m);
      if (!t.has(to)) t.set(to, []);
      t.get(to).push(m);
    }
    return t;
  }
  function selectSq(sq) { S.sel = { sq }; S.targets = collectTargets(m => G.mvFrom(m) === sq); renderBoard(); renderPlayers(); renderSqInfo(); }
  function selectHand(t, draw = true) {
    S.sel = { hand: t }; S.inspect = -1;
    S.targets = collectTargets(m => G.mvFrom(m) === DROP && G.mvDrop(m) === t);
    if (draw) { renderBoard(); renderPlayers(); renderSqInfo(); }
  }

  function moveLabel(m) {
    const tier = S.pos.landingTier(m), act = G.mvAct(m);
    if (m & G.BETRAY) return `ツケて寝返らせる（${tier}段目）`;
    if (act === G.ACT_CAP) return tier > 1 ? `取る（${tier}段目に乗る）` : '取る';
    if (act === G.ACT_TSUKE) return `ツケる（${tier}段目）`;
    return '移動';
  }
  const shortName = t => NAMES[t].replace(/（.*/, '');
  // 駒の乗ったマスへの手を確かめるメニュー（マスの横に出す）。指す手のほかに「この駒を選ぶ / この駒の利きを見る」も選べる
  function showChooser(sq, ms) {
    const pos = S.pos, top = pos.topAt(sq), h = pos.hgt[sq];
    const box = document.createElement('div');
    box.className = 'choose'; box.id = 'chooser'; box.setAttribute('role', 'menu');
    if (top) {
      const ttl = document.createElement('div');
      ttl.className = 'ttl';
      ttl.innerHTML = `${miniDisc(top >> 4, top & 15)}<span>${sqLabel(sq)}　${SIDE[top >> 4]}の${shortName(top & 15)}${h > 1 ? `（${h}段目）` : ''}</span>`;
      box.appendChild(ttl);
    }
    const add = (label, cls, fn) => {
      const b = document.createElement('button');
      b.textContent = label; b.className = cls; b.setAttribute('role', 'menuitem');
      b.addEventListener('click', e => { e.stopPropagation(); hideChooser(); fn(); });
      box.appendChild(b);
    };
    ms.forEach(m => add(moveLabel(m), 'act', () => play(m)));
    if (top && pos.phase === MAIN) {
      if ((top >> 4) === pos.stm && canMoveFrom(sq)) add('この駒を選ぶ', 'sub', () => { S.inspect = -1; selectSq(sq); });
      else add('この駒の利きを見る', 'sub', () => { S.sel = null; S.targets = new Map(); setInspect(sq); });
    }
    add('やめる', 'quiet', () => {});
    S.pending = sq;
    renderMarks();
    const el = sqEl(sq), wrap = $('board-wrap');
    const r = el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    wrap.appendChild(box);
    let left = r.right - wr.left + 6, top2 = r.top - wr.top;
    if (left + box.offsetWidth > wr.width) left = r.left - wr.left - box.offsetWidth - 6;
    if (left < 0) left = Math.max(0, Math.min(wr.width - box.offsetWidth, r.left - wr.left));
    if (top2 + box.offsetHeight > wr.height) top2 = wr.height - box.offsetHeight;
    box.style.left = left + 'px'; box.style.top = Math.max(0, top2) + 'px';
    if (pointerType !== 'touch') box.querySelector('button').focus();
  }
  function hideChooser() {
    const c = $('chooser');
    if (c) c.remove();
    if (S.pending >= 0) { S.pending = -1; renderMarks(); }
  }

  // ある駒の利き（王の安全は考えない。段の条件・飛び越え込み）
  function pieceReach(pos, sq) {
    const h = pos.hgt[sq];
    if (!h) return [];
    const p = pos.stk[sq * 3 + h - 1], c = p >> 4, t = p & 15, out = [];
    const idx = G.rIdx(c, t, h, sq);
    let r = G.RSTART[idx];
    const e = G.REND[idx], RAY = G.RAY;
    while (r < e) {
      if (RAY[r] === 0) {
        const end = r + 2 + RAY[r + 1];
        for (r += 2; r < end; r++) {
          const d = RAY[r], hd = pos.hgt[d];
          if (!hd) { out.push(d); continue; }
          if (hd <= h) out.push(d);
          break;
        }
        r = end;
      } else {
        const d = RAY[r + 1], ni = RAY[r + 2];
        let ok = true;
        for (let i = 0; i < ni; i++) if (pos.hgt[RAY[r + 3 + i]] > h) { ok = false; break; }
        r += 3 + ni;
        if (ok && pos.hgt[d] <= h) out.push(d);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 描画
  const sqLabel = sq => FW[9 - (sq % 9)] + KN[((sq / 9) | 0) + 1];
  const sqEl = sq => $('grid').children[S.flip ? 80 - sq : sq];
  const topColor = () => (S.flip ? BLACK : WHITE);

  function render() {
    document.body.classList.toggle('eval-off', !settings.showEval);
    renderPlayers(); renderBoard(); renderControls(); renderKifu(); renderTape(); renderEval(); renderGraph(); renderArrows(); renderSqInfo();
    fitBoardSoon();
  }

  // 盤の大きさ: 盤・情報の行・自分の手駒・ボタンが画面の高さに収まる大きさにする（盤を見ている間はスクロールしなくていいように）
  let fitPending = 0;
  function fitBoardSoon() { if (!fitPending) fitPending = setTimeout(() => { fitPending = 0; fitBoard(); }, 0); }
  function fitBoard() {
    const col = document.querySelector('.board-col'), row = document.querySelector('.board-row'), frame = document.querySelector('.board-frame');
    if (!col || !col.offsetParent) return;
    const cs = getComputedStyle(col), gap = parseFloat(cs.rowGap) || 0;
    let other = 0, n = 0;
    for (const el of col.children) {
      if (el === row || getComputedStyle(el).display === 'none') continue;
      other += el.getBoundingClientRect().height; n++;
    }
    const top = col.getBoundingClientRect().top + window.scrollY;
    const fcs = getComputedStyle(frame);
    const padV = parseFloat(fcs.paddingTop) + parseFloat(fcs.paddingBottom), padH = parseFloat(fcs.paddingLeft) + parseFloat(fcs.paddingRight);
    const rowExtra = row.getBoundingClientRect().width - frame.getBoundingClientRect().width; // 評価値バーの分
    const avail = window.innerHeight - top - other - gap * n - 12; // 下に少し余白
    // 盤の枠の高さ = 盤の幅 − 横の余白 + 縦の余白
    const w = Math.round(Math.max(260, Math.min(680, avail - padV + padH + rowExtra)));
    const cur = document.documentElement.style.getPropertyValue('--board-w');
    if (cur !== w + 'px') document.documentElement.style.setProperty('--board-w', w + 'px');
  }

  // 駒の文字は SVG で描き、実際に描かれる文字の形（インクの範囲）を測って円の中心に置く。
  // フォントごとの上下の余白（游明朝などで文字が下にずれる）に左右されない。
  const GLYPH_FS = 60;
  const GLYPH = {};
  let glyphFont = '';
  function measureGlyphs() {
    const fam = getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim() || 'serif';
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `800 ${GLYPH_FS}px ${fam}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let t = 1; t < KANJI.length; t++) {
      const m = ctx.measureText(KANJI[t]);
      const ok = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0;
      GLYPH[t] = ok
        ? { x: 50 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, y: 50 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 }
        : { x: 50, y: 50 + GLYPH_FS * 0.36 };
    }
    glyphFont = fam + '|' + (document.fonts && document.fonts.check ? document.fonts.check(`800 20px ${fam}`) : '');
  }
  measureGlyphs();
  const glyphSVG = t => `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><text x="${GLYPH[t].x.toFixed(1)}" y="${GLYPH[t].y.toFixed(1)}">${KANJI[t]}</text></svg>`;
  function discHTML(color, type, cls = '', style = '') {
    return `<span class="disc ${color ? 'w' : 'b'} ${cls}"${style ? ` style="${style}"` : ''}>${glyphSVG(type)}</span>`;
  }
  const miniDisc = (c, t) => `<span class="mini-disc ${c ? 'w' : 'b'}" title="${NAMES[t]}">${glyphSVG(t)}</span>`;

  function lostPieces(pos, c) {
    const r = [];
    for (const t of pos.level.types) {
      let n = G.PIECE_COUNT[t] - pos.hand[c * 16 + t];
      for (let s = 0; s < 81; s++) for (let i = 0; i < pos.hgt[s]; i++) if (pos.stk[s * 3 + i] === (t | (c << 4))) n--;
      for (let k = 0; k < n; k++) r.push(t);
    }
    return r;
  }

  function renderPlayers() {
    const pos = shownPos(), tc = topColor();
    [['player-top', tc], ['player-bottom', tc ^ 1]].forEach(([id, c]) => {
      const el = $(id);
      const myTurn = live() && !S.result && pos.stm === c;
      el.classList.toggle('turn', myTurn);
      const can = humanTurn() && pos.stm === c;
      let st = '';
      if (myTurn && isCPU(c) && pos.phase === MAIN && S.thinking) {
        const ci = S.cpuInfo;
        st = `<span class="think"><i></i>考え中${ci ? `・深さ${ci.depth}` : ''}</span>`;
      } else if (myTurn && isRemote(c)) {
        st = S.online && NET && NET.status === 'on' && !S.online.oppPresent ? '<span class="think" style="color:var(--bad)">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      } else if (S.result && live()) {
        st = S.result.winner === c ? '<span class="think" style="color:var(--good)">勝ち</span>' : S.result.winner === -1 ? '<span class="think">引き分け</span>' : '<span class="think" style="color:var(--muted)">負け</span>';
      } else {
        // 取った駒は右端に小さく（最近の4枚と残りの数）
        const lost = lostPieces(pos, c ^ 1);
        if (lost.length) st = `<span class="caps" title="取った駒 ${lost.length}枚">${lost.slice(-4).map(t => miniDisc(c ^ 1, t)).join('')}${lost.length > 4 ? `<span class="more">+${lost.length - 4}</span>` : ''}</span>`;
      }
      let hand = '';
      for (let t = 1; t < G.NT; t++) {
        const n = pos.handCount(c, t);
        if (!n) continue;
        const sel = live() && S.sel && S.sel.hand === t && pos.stm === c;
        const usable = can && S.legal.some(m => m !== DONE && G.mvFrom(m) === DROP && G.mvDrop(m) === t);
        hand += `<button class="hp${sel ? ' sel' : ''}" data-hand="${t}" data-color="${c}" ${usable ? '' : 'disabled'} aria-label="${SIDE[c]}の手駒 ${NAMES[t]} ${n}枚" title="${NAMES[t]}">${discHTML(c, t)}<span class="n">${n}</span></button>`;
      }
      const on = S.online;
      const nm = on ? (c === on.myColor ? 'あなた' : esc(on.opp.name)) : SIDE[c];
      const tag = on ? aiTagHTML(c === on.myColor ? aiFlags() : on.opp.ai, c === on.myColor ? on.myHints : on.opp.hints) : '';
      el.innerHTML = `
        <div class="id"><span class="stone ${c ? 'w' : 'b'}"></span><span class="name">${MARK[c]}${nm}</span><span class="sub">${on ? SIDE[c] : seatLabel(c)}</span>${tag}</div>
        <div class="hand" aria-label="${SIDE[c]}の手駒">${hand || '<span class="empty-note">手駒なし</span>'}</div>
        <div class="st">${st}</div>`;
      // 選んでいる手駒が見えるように（横にスクロールする手駒の列）
      const selEl = el.querySelector('.hp.sel');
      if (selEl) { const hd = el.querySelector('.hand'); if (selEl.offsetLeft < hd.scrollLeft || selEl.offsetLeft + selEl.offsetWidth > hd.scrollLeft + hd.clientWidth) hd.scrollLeft = selEl.offsetLeft - 8; }
    });
  }

  const stackKey = (pos, sq) => { let k = ''; for (let i = 0; i < pos.hgt[sq]; i++) k += pos.stk[sq * 3 + i] + ','; return k; };
  // 重なりの描き方: 一番上の駒だけを円盤で描き、下の駒はその下の「縁」（持ち主の色）で見せる。マスの外にははみ出さない
  const RIM = { b: ['#2c3036', 'rgba(0,0,0,.6)'], w: ['#ddd3be', '#8a7f68'] };
  function stackHTML(pos, sq, tc) {
    const h = pos.hgt[sq];
    if (!h) return '';
    const p = pos.stk[sq * 3 + h - 1], c = p >> 4, t = p & 15;
    let style = '';
    if (h > 1) {
      const sh = [c ? '0 2px 0 #988d74' : '0 2px 0 #000'];
      let y = 2;
      for (let k = h - 2; k >= 0; k--) {
        const [rim, sep] = RIM[(pos.stk[sq * 3 + k] >> 4) ? 'w' : 'b'];
        sh.push(`0 ${y + 1}px 0 ${sep}`, `0 ${y + 4}px 0 ${rim}`);
        y += 4;
      }
      sh.push(`0 ${y + 2}px 6px rgba(0,0,0,.35)`);
      style = `top:-${(h - 1) * 2}px;bottom:${(h - 1) * 2}px;box-shadow:${sh.join(',')}`;
    }
    return `<span class="stack">${discHTML(c, t, 'top' + (c === tc ? ' rot' : ''), style)}${h > 1 ? `<span class="tier">${h}</span>` : ''}</span>`;
  }

  function renderBoard() {
    const pos = shownPos(), grid = $('grid');
    if (grid.children.length !== 81) {
      grid.innerHTML = '';
      for (let i = 0; i < 81; i++) {
        const b = document.createElement('button');
        b.className = 'sq';
        b.innerHTML = '<span class="tint"></span><span class="pc"></span><span class="mark"></span>';
        b.addEventListener('click', e => { e.stopPropagation(); onSquare(Number(b.dataset.sq)); });
        // マウスを乗せたときだけ利きを見せる（タッチではタップで見る。指で触れたときの擬似的なホバーは使わない）
        b.addEventListener('mouseenter', () => { if (pointerType === 'mouse') onHover(Number(b.dataset.sq)); });
        b.addEventListener('mouseleave', () => { if (S.hover >= 0) onHover(-1); });
        b.addEventListener('focus', () => { if (b.matches(':focus-visible')) onHover(Number(b.dataset.sq)); });
        b.addEventListener('blur', () => { if (S.hover >= 0) onHover(-1); });
        grid.appendChild(b);
      }
    }
    const tc = topColor();
    const lm = live() ? S.moves[S.moves.length - 1] : (S.view ? S.moves[S.view - 1] : 0);
    const lastTo = lm && lm !== DONE ? G.mvTo(lm) : -1, lastFrom = lm && lm !== DONE && G.mvFrom(lm) !== DROP ? G.mvFrom(lm) : -1;
    const checkSq = pos.phase === MAIN && pos.inCheck(pos.stm) ? pos.king[pos.stm] : -1;
    const zoneC = live() && pos.phase === SETUP && humanTurn() ? pos.stm : -1;
    for (let i = 0; i < 81; i++) {
      const sq = S.flip ? 80 - i : i, b = grid.children[i];
      b.dataset.sq = sq;
      const y = (sq / 9) | 0;
      let cls = 'sq';
      if ((zoneC === BLACK && y >= 6) || (zoneC === WHITE && y <= 2)) cls += ' zone';
      if (sq === lastTo) cls += ' last'; else if (sq === lastFrom) cls += ' from';
      if (live() && S.sel && S.sel.sq === sq) cls += ' selected';
      if (S.inspect === sq) cls += ' inspect';
      if (sq === checkSq) cls += ' check';
      b.className = cls;
      const key = stackKey(pos, sq) + tc + glyphFont, pc = b.children[1];
      if (pc.dataset.key !== key) {
        pc.dataset.key = key;
        pc.innerHTML = stackHTML(pos, sq, tc);
        const desc = [];
        for (let k = pos.hgt[sq] - 1; k >= 0; k--) { const p = pos.stk[sq * 3 + k]; desc.push(`${k + 1}段目 ${SIDE[p >> 4]}の${KANJI[p & 15]}`); }
        b.setAttribute('aria-label', `${sqLabel(sq)} ${desc.length ? desc.join('、') : '空き'}`);
      }
    }
    renderMarks();
    const cols = [], rows = [];
    for (let i = 0; i < 9; i++) { cols.push(`<span>${S.flip ? FW[i + 1] : FW[9 - i]}</span>`); rows.push(`<span>${S.flip ? KN[9 - i] : KN[i + 1]}</span>`); }
    $('coords-top').innerHTML = cols.join('');
    $('coords-right').innerHTML = rows.join('');
  }

  // マスの塗り（駒の下）と印（駒の上）だけを更新（ホバーで頻繁に呼ぶ）
  //   選んだ駒の行き先: 薄い青で塗り、空きマスは点、取るは赤い輪、ツケは青い点線の輪
  //   利きを見ている駒（タップした相手の駒など）: 利きのマスを赤く塗り、駒が乗っていれば細い赤の輪
  //   マウスを乗せた駒: 自分の手番の自分の駒なら動ける先を薄い青、それ以外は利きを赤（何も選んでいないときだけ）
  function renderMarks() {
    const pos = shownPos(), grid = $('grid');
    if (grid.children.length !== 81) return;
    let preview = null, reach = null;
    if (S.inspect >= 0 && pos.hgt[S.inspect]) reach = new Set(pieceReach(pos, S.inspect));
    else if (settings.reach && !S.sel) {
      if (S.hoverHand && humanTurn()) {
        preview = new Set(S.legal.filter(m => m !== DONE && G.mvFrom(m) === DROP && G.mvDrop(m) === S.hoverHand).map(G.mvTo));
      } else if (S.hover >= 0 && pos.hgt[S.hover]) {
        const top = pos.topAt(S.hover);
        if (humanTurn() && pos.phase === MAIN && (top >> 4) === pos.stm && canMoveFrom(S.hover)) preview = new Set(S.legal.filter(m => m !== DONE && G.mvFrom(m) === S.hover).map(G.mvTo));
        else if (pos.phase === MAIN) reach = new Set(pieceReach(pos, S.hover));
      }
    }
    // 明るく残すマス（駒を選んだとき = 行き先、利きを見ているとき = 利き）。それ以外はやんわり暗くする
    let focus = null;
    if (live() && S.sel && S.targets.size) focus = S.targets;
    else if (S.inspect >= 0 && reach) focus = reach;
    const keep = live() && S.sel && S.sel.sq != null ? S.sel.sq : S.inspect;
    for (let i = 0; i < 81; i++) {
      const sq = S.flip ? 80 - i : i, el = grid.children[i], tint = el.firstChild, mk = el.lastChild;
      let tc = 'tint', mc = 'mark';
      if (live() && S.targets.has(sq)) {
        const ms = S.targets.get(sq);
        const cap = ms.some(m => G.mvAct(m) === G.ACT_CAP), ts = ms.some(m => G.mvAct(m) === G.ACT_TSUKE);
        mc += cap ? ' cap' : ''; mc += ts ? ' tsuke' : ''; if (!cap && !ts) mc += ' move';
      } else if (preview && preview.has(sq)) tc += ' prev';
      else if (reach && reach.has(sq)) { tc += ' reach'; if (pos.hgt[sq]) mc += ' ring'; }
      if (focus && !focus.has(sq) && sq !== keep) mc += ' dim';
      if (sq === S.pending) mc += ' pending';
      if (tint.className !== tc) tint.className = tc;
      if (mk.className !== mc) mk.className = mc;
    }
  }

  function onHover(sq) {
    S.hover = sq;
    renderMarks();
    renderSqInfo();
  }

  // 盤の下の情報の行: 選んだ駒・利きを見ている駒・マウスを乗せた駒（重なりの中身つき）、何もなければ直前の手
  const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  function layersHTML(pos, sq) {
    const h = pos.hgt[sq];
    if (h < 2) return '';
    let s = '<span class="layers"><span class="up">上から</span>';
    for (let k = h - 1; k >= 0; k--) { const p = pos.stk[sq * 3 + k]; s += miniDisc(p >> 4, p & 15); }
    return s + '</span>';
  }
  function pieceTitle(pos, sq) {
    const p = pos.topAt(sq), h = pos.hgt[sq];
    return `${sqLabel(sq)}の${SIDE[p >> 4]}の${shortName(p & 15)}${h > 1 ? `（${h}段目）` : ''}`;
  }
  function renderSqInfo() {
    const el = $('sqinfo'), pos = shownPos();
    if (!el) return;
    let html = '', tools = '', cls = 'sqinfo';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    const c = pos.stm;
    // 配置中（自分の番）は、何を選んでいても「済」「おまかせ」を出しておく
    const setupTools = live() && pos.phase === SETUP && humanTurn()
      ? (pos.king[c] < 0 ? '' : btn('done', '済', ' gold')) + btn('auto', 'おまかせ') : '';
    if (live() && S.sel && S.sel.sq != null) {
      let mv = 0, cap = 0, ts = 0;
      S.targets.forEach(ms => { if (ms.some(m => G.mvAct(m) === G.ACT_CAP)) cap++; if (ms.some(m => G.mvAct(m) === G.ACT_TSUKE)) ts++; if (ms.some(m => G.mvAct(m) === G.ACT_MOVE)) mv++; });
      html = `${layersHTML(pos, S.sel.sq)}<span class="txt"><b>${pieceTitle(pos, S.sel.sq)}</b>　<span class="muted">移動${mv}・取る${cap}・ツケ${ts}</span></span>`;
      tools = `<button class="ibtn" data-act="desel" aria-label="選択を解除" title="選択を解除">${CLOSE}</button>`;
    } else if (live() && S.sel && S.sel.hand) {
      html = `${miniDisc(c, S.sel.hand)}<span class="txt"><b>${shortName(S.sel.hand)}</b>を置くマスを選んでください</span>`;
      tools = setupTools || `<button class="ibtn" data-act="desel" aria-label="選択を解除" title="選択を解除">${CLOSE}</button>`;
      if (setupTools) cls += ' setup';
    } else if (S.inspect >= 0 && pos.hgt[S.inspect]) {
      html = `${layersHTML(pos, S.inspect)}<span class="txt"><b>${pieceTitle(pos, S.inspect)}</b>の利き</span>`;
      tools = `<button class="ibtn" data-act="desel" aria-label="利きの表示を消す" title="利きの表示を消す">${CLOSE}</button>`;
    } else if (S.hover >= 0 && pos.hgt[S.hover]) {
      html = `${layersHTML(pos, S.hover)}<span class="txt"><b>${pieceTitle(pos, S.hover)}</b></span>`;
    } else if (!live()) {
      cls += ' view';
      const t = S.texts[S.view - 1];
      html = `<span class="txt"><b>${S.view}手目</b>${t ? ` ${t}` : '（開始局面）'}</span>`;
      tools = btn('branch', 'ここから指す') + btn('live', '最新へ', ' primary');
    } else if (S.result && S.online) {
      cls += ' result';
      const r = S.result, o = S.online, nm = esc(o.opp.name);
      const head = r.winner === -1 ? '引き分け' : r.winner === o.myColor ? 'あなたの勝ち' : `${nm}さんの勝ち`;
      if (o.oppRe && !o.myRe) { html = `<span class="txt"><b>${nm}さんがもう一局を希望</b>（先後を交代）</span>`; tools = btn('rematch', '受ける', ' primary') + btn('lobby', 'ロビーへ'); }
      else if (o.myRe) { html = `<span class="txt"><b>${head}</b>　もう一局の返事を待っています…</span>`; tools = btn('lobby', 'ロビーへ'); }
      else { html = `<span class="txt"><b>${head}</b>（${esc(r.reason)}）</span>`; tools = btn('rematch', 'もう一局', ' primary') + btn('lobby', 'ロビーへ'); }
    } else if (S.result) {
      cls += ' result';
      const r = S.result;
      html = `<span class="txt"><b>${r.winner === -1 ? '引き分け' : SIDE[r.winner] + 'の勝ち'}</b>（${r.reason}）</span>`;
      tools = btn('review', '振り返る') + btn('again', 'もう一局', ' primary');
    } else if (S.online && NET && NET.status !== 'on') {
      cls += ' alert';
      html = `<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>`;
    } else if (S.online && !S.online.oppPresent && S.online.lostAt) {
      cls += ' alert';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else if (S.online && isRemote(c) && pos.phase === MAIN && !pos.inCheck(c)) {
      html = `<span class="txt"><b>${esc(S.online.opp.name)}さん</b>の番です　<span class="muted">${S.texts.length ? `直前 ${S.texts[S.texts.length - 1]}` : ''}</span></span>`;
    } else if (pos.phase === SETUP) {
      cls += ' setup';
      if (humanTurn()) {
        html = `<span class="txt">${pos.king[c] < 0 ? '最初に<b>帥</b>を自陣（手前3段）に置きます' : '手駒を選んで自陣に置き、終わったら「済」'}</span>`;
        tools = setupTools;
      } else if (S.autoSetup[c]) {
        html = `<span class="txt"><b>おまかせ配置中</b>（${S.autoSetup[c].name}）</span>`;
        tools = btn('auto-stop', '自分で置く');
      } else html = `<span class="txt">${SIDE[c]}（${seatLabel(c)}）が駒を置いています</span>`;
    } else if (pos.inCheck(c)) {
      cls += ' alert';
      html = `<span class="txt">帥手（王手）：${SIDE[c]}の帥が狙われています</span>`;
    } else {
      const ply = shownPly(), t = S.texts[ply - 1];
      html = `<span class="txt muted">${ply ? `${ply}手目 <b style="color:var(--ink)">${t}</b>` : '開始局面'}${ply ? '　駒をタップで行き先・利き' : ''}</span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }

  // 棋譜テープ（盤の下で横に流れる手の一覧）。タップでその局面へ。今の手を真ん中に
  function renderTape() {
    const el = $('tape');
    if (!el) return;
    const cur = shownPly();
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">開始</button>`;
    S.texts.forEach((t, i) => {
      const s2 = S.evals[i + 1], prev = S.evals[i];
      let bad = false;
      if (settings.showEval && s2 != null && prev != null) {
        const mover = t.startsWith('▲') ? BLACK : WHITE;
        bad = (winP(s2) - winP(prev)) * (mover === BLACK ? 1 : -1) < -0.15;
      }
      html += `<button data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}${bad ? ' bad' : ''}"><span class="no">${i + 1}</span>${t.replace(/\(\d\d\)$/, '')}${bad ? '?' : ''}</button>`;
    });
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    const c = el.querySelector('.cur');
    if (c) el.scrollLeft = c.offsetLeft - el.clientWidth / 2 + c.offsetWidth / 2;
    const nav = $('navrow');
    nav.querySelector('[data-nav="first"]').disabled = cur === 0;
    nav.querySelector('[data-nav="prev"]').disabled = cur === 0;
    nav.querySelector('[data-nav="next"]').disabled = live();
    nav.querySelector('[data-nav="last"]').disabled = live();
  }

  // 最善手の矢印。何をする手か（取る・ツケ・寝返り・新）を色と札で示す
  const ARROW = { move: '#2e8c50', cap: '#c8321e', tsuke: '#1d3f95', betray: '#7a2fa0', drop: '#2e8c50' };
  function renderArrows() {
    const wrapEl = $('grid');
    let svg = $('arrows');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'arrows'; svg.setAttribute('class', 'arrows'); svg.setAttribute('viewBox', '0 0 900 900'); svg.setAttribute('preserveAspectRatio', 'none');
      wrapEl.appendChild(svg);
    }
    const info = S.info, pos = shownPos();
    const ok = info && info.kind !== 'cpu' && (info.kind === 'hint' || settings.arrow) && info.ply === shownPly() && info.pv && info.pv.length && pos.phase === MAIN && !(live() && S.result);
    if (!ok) { svg.innerHTML = ''; return; }
    const m = info.pv[0];
    if (!pos.legalMoves().includes(m)) { svg.innerHTML = ''; return; }
    const cxy = sq => { const i = S.flip ? 80 - sq : sq; return [(i % 9) * 100 + 50, ((i / 9) | 0) * 100 + 50]; };
    const [tx, ty] = cxy(G.mvTo(m));
    const drop = G.mvFrom(m) === DROP, act = G.mvAct(m);
    const kind = (m & G.BETRAY) ? 'betray' : act === G.ACT_CAP ? 'cap' : act === G.ACT_TSUKE ? 'tsuke' : drop ? 'drop' : 'move';
    const col = ARROW[kind], tier = pos.landingTier(m);
    const label = kind === 'cap' ? (tier > 1 ? `取る・${tier}段` : '取る') : kind === 'tsuke' ? `ツケ${tier}段` : kind === 'betray' ? '寝返り' : drop ? `新・${KANJI[G.mvDrop(m)]}${tier > 1 ? `${tier}段` : ''}` : '';
    let html = `<defs><marker id="ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker></defs>`;
    if (drop) {
      html += `<circle cx="${tx}" cy="${ty}" r="40" fill="none" stroke="${col}" stroke-width="5" stroke-dasharray="9 6" opacity=".95"/>`;
    } else {
      const [fx, fy] = cxy(G.mvFrom(m));
      const dx = tx - fx, dy = ty - fy, L = Math.hypot(dx, dy) || 1;
      const ex = tx - dx / L * 26, ey = ty - dy / L * 26;
      html += `<line x1="${fx}" y1="${fy}" x2="${ex}" y2="${ey}" stroke="${col}" stroke-opacity=".85" stroke-width="14" stroke-linecap="round" marker-end="url(#ah)"${kind === 'tsuke' ? ' stroke-dasharray="26 14"' : ''}/>`;
    }
    if (label) {
      // 札: 行き先のマスの上側（盤の上端なら下側）に、矢印の色で
      const w = 22 + label.length * 21, h = 34;
      let bx = Math.max(4, Math.min(896 - w, tx - w / 2)), by = ty - 50 - h;
      if (by < 2) by = ty + 50;
      html += `<g><rect x="${bx}" y="${by}" width="${w}" height="${h}" rx="17" fill="${col}"/><text x="${bx + w / 2}" y="${by + 24}" text-anchor="middle" fill="#fff" style="font:700 21px var(--font-body)">${label}</text></g>`;
    }
    svg.innerHTML = html;
  }

  function renderControls() {
    const pos = S.pos;
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    $('btn-undo').disabled = !S.moves.length || !!S.online;
    const humans = [BLACK, WHITE].filter(c => isHuman(c));
    $('btn-resign').disabled = !live() || !!S.result || !humans.length || pos.phase !== MAIN;
    $('btn-hint').disabled = !humanTurn() || pos.phase !== MAIN;
    $('viewing').hidden = live();
    if (!live()) $('viewing-text').textContent = `${S.view}手目を表示中`;
    const L = G.LEVELS[S.level];
    $('kifu-info').textContent = `${L.name}・${S.setup === 'fixed' ? '固定配置' : '自由配置'}・${S.moves.length}手`;
  }

  function fmtScore(s) {
    if (G.isMate(s)) { const n = G.MATE - Math.abs(s); return (s > 0 ? '先手' : '後手') + `勝ち（${n}手で詰み）`; }
    return (s > 0 ? '+' : s < 0 ? '−' : '±') + Math.abs(Math.round(s));
  }
  const winP = s => (G.isMate(s) ? (s > 0 ? 1 : 0) : G.winRate(s));

  function renderEval() {
    const ply = shownPly(), pos = shownPos();
    const info = S.info && S.info.ply === ply ? S.info : null;
    const sB = info ? info.scoreB : S.evals[ply];
    const num = $('ev-num'), lbl = $('ev-label');
    $('ev-who').textContent = info ? (info.kind === 'cpu' ? `${seatLabel(info.stm)}の読み` : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    const strip = (n, l, best, more) => {
      $('evs-num').textContent = n; $('evs-lbl').textContent = l; $('evs-best').textContent = best;
      $('evs-more').innerHTML = more; $('evs-more').hidden = !S.evOpen || !more;
    };
    if (sB == null) {
      num.textContent = '—';
      lbl.textContent = pos.phase === SETUP ? '配置が終わると表示します' : (settings.analyze || S.thinking) ? '読んでいます…' : '「ヒント」で読みます';
      setWR(0.5); $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip('—', lbl.textContent, '', '');
      return;
    }
    if (G.isMate(sB)) { num.textContent = '詰'; lbl.textContent = fmtScore(sB); }
    else {
      num.textContent = fmtScore(sB);
      const a = Math.abs(sB);
      lbl.textContent = a < 150 ? '互角' : (sB > 0 ? '先手' : '後手') + (a < 500 ? 'やや有利' : a < 1200 ? '有利' : a < 2500 ? '優勢' : '勝勢');
    }
    setWR(winP(sB));
    let best = '', more = '';
    if (info) {
      const p = Position.fromMoves(S.level, S.moves.slice(0, ply), S.setup);
      const txt = [];
      for (const m of info.pv.slice(0, 12)) {
        if (!p.legalMoves().includes(m)) break;
        txt.push(p.moveText(m).replace(/\(\d\d\)$/, ''));
        p.make(m);
      }
      $('pv').innerHTML = txt.length ? `<span class="k">読み筋</span><span class="best">${txt[0]}</span> ${txt.slice(1).join(' ')}` : '';
      const nps = info.time ? Math.round(info.nodes / info.time * 1000) : 0;
      $('ev-meta').textContent = `深さ ${info.depth} ・ ${info.nodes.toLocaleString()} 局面 ・ ${(info.time / 1000).toFixed(1)}秒 ・ ${nps.toLocaleString()} 局面/秒`;
      if (txt.length && info.kind !== 'cpu') best = `${info.kind === 'hint' ? 'ヒント' : '最善'} ${txt[0]}`;
      if (txt.length) more = `${$('pv').innerHTML}<div class="meta">${$('ev-meta').textContent}</div>`;
    } else { $('pv').innerHTML = ''; $('ev-meta').textContent = ''; }
    strip(num.textContent === '詰' ? '詰' : num.textContent, lbl.textContent, best, more);
  }
  function setWR(p) {
    $('wr-b').style.width = (p * 100).toFixed(1) + '%';
    $('evs-b').style.width = (p * 100).toFixed(1) + '%';
    $('wr-bt').textContent = `先手 ${(p * 100).toFixed(1)}%`;
    $('wr-wt').textContent = `後手 ${(100 - p * 100).toFixed(1)}%`;
    const bar = $('evalbar'), fill = $('evalbar-fill');
    bar.classList.toggle('flip', S.flip);
    fill.style.height = (p * 100).toFixed(1) + '%';
    fill.style.setProperty('--w', (p * 100).toFixed(1) + '%');
  }

  function renderGraph() {
    const svg = $('graph'), Wd = 300, H = 130, n = Math.max(S.moves.length, 40);
    const x = i => (i / n) * Wd, y = p => (1 - p) * (H - 14) + 7;
    const pts = [];
    for (let i = 0; i <= S.moves.length; i++) { const s = S.evals[i]; if (s != null) pts.push([x(i), y(winP(s))]); }
    let html = `<line class="axis" x1="0" y1="${H - 0.5}" x2="${Wd}" y2="${H - 0.5}"/><line class="mid" x1="0" y1="${y(0.5)}" x2="${Wd}" y2="${y(0.5)}"/>`;
    html += `<text x="3" y="13">先手</text><text x="3" y="${H - 4}">後手</text>`;
    if (pts.length) {
      const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      html += `<polygon class="areab" points="${pts[0][0].toFixed(1)},${y(0.5)} ${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0.5)}"/><polyline class="lineb" points="${line}"/>`;
    }
    const cx = x(shownPly());
    html += `<line class="now" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>`;
    const cs = S.evals[shownPly()];
    if (cs != null) html += `<circle class="dot" cx="${cx}" cy="${y(winP(cs))}" r="3.5"/>`;
    svg.innerHTML = html;
  }

  function renderKifu() {
    const el = $('kifu'), cur = shownPly();
    const rows = [`<li data-ply="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span>開始局面</span><span class="ev"></span></li>`];
    S.texts.forEach((t, i) => {
      const s = S.evals[i + 1], prev = S.evals[i];
      let ev = '', bad = false;
      if (s != null && settings.showEval) {
        ev = G.isMate(s) ? '詰' : (s > 0 ? '+' : '') + Math.round(s);
        // 指した側から見て勝率が大きく下がった手に印
        if (prev != null && t[0] !== undefined && i + 1 >= 1) {
          const mover = t.startsWith('▲') ? BLACK : WHITE;
          const d = (winP(s) - winP(prev)) * (mover === BLACK ? 1 : -1);
          bad = d < -0.15;
        }
      }
      rows.push(`<li data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span><span>${t}${bad ? ' ?' : ''}</span><span class="ev${bad ? ' bad' : ''}">${ev}</span></li>`);
    });
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.innerHTML = rows.join('');
    const c = el.querySelector('.cur');
    if (c && (atEnd || !live())) {
      const top = c.offsetTop, bottom = top + c.offsetHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }
  }

  // ------------------------------------------------------------------ アニメーション
  function animOrigin(m) {
    if (!settings.anim || reduceMotion || m === DONE || !live()) return null;
    let el = null;
    if (G.mvFrom(m) === DROP) el = document.querySelector(`.hp[data-hand="${G.mvDrop(m)}"][data-color="${S.pos.stm}"] .disc`);
    else el = sqEl(G.mvFrom(m)).querySelector('.disc.top');
    if (!el) return null;
    return { rect: el.getBoundingClientRect(), to: G.mvTo(m) };
  }
  function runAnim(a) {
    const el = sqEl(a.to).querySelector('.disc.top');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (a.rect.left + a.rect.width / 2) - (r.left + r.width / 2), dy = (a.rect.top + a.rect.height / 2) - (r.top + r.height / 2);
    const base = el.style.transform || '';
    const stack = el.parentElement;
    stack.parentElement.parentElement.classList.add('moving');
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px) ${base} scale(1.08)`;
    el.getBoundingClientRect();
    el.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
    el.style.transform = base;
    setTimeout(() => { el.style.transition = ''; const sq = stack.parentElement && stack.parentElement.parentElement; if (sq) sq.classList.remove('moving'); }, 260);
  }

  // ------------------------------------------------------------------ 棋譜・操作
  function viewPly(p) {
    hideChooser();
    if (p >= S.moves.length) { S.view = null; S.dpos = null; }
    else { S.view = Math.max(0, p); S.dpos = Position.fromMoves(S.level, S.moves.slice(0, S.view), S.setup); }
    S.sel = null; S.targets = new Map(); S.info = null; S.inspect = -1;
    render();
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }

  function undo() {
    if (!S.moves.length || S.online) return; // オンライン対局では待ったなし
    AI.cancel(); clearTimeout(S.timer);
    S.view = null; S.dpos = null; S.autoSetup = [null, null];
    let n = S.moves.length - 1;
    if ([BLACK, WHITE].some(c => isHuman(c))) {
      while (n > 0 && isCPU(Position.fromMoves(S.level, S.moves.slice(0, n), S.setup).stm)) n--;
    }
    rebuild(n);
    afterChange();
  }

  function resign() {
    if (!live() || S.result) return;
    const humans = [BLACK, WHITE].filter(c => isHuman(c));
    const loser = humans.includes(S.pos.stm) ? S.pos.stm : humans[0];
    AI.cancel(); clearTimeout(S.timer);
    S.result = { winner: loser ^ 1, reason: `${SIDE[loser]}の投了` };
    if (S.online && NET) { NET.send({ t: 'resign' }); NET.saveState({ moves: S.moves, r: 1 }); }
    afterChange();
  }

  function kifuText() {
    const L = G.LEVELS[S.level];
    const lines = [`軍儀 棋譜（${L.name}・${S.setup === 'fixed' ? '固定配置' : '自由配置'}）`, `先手：${seatLabel(BLACK)} / 後手：${seatLabel(WHITE)}`];
    S.texts.forEach((t, i) => lines.push(`${i + 1} ${t}`));
    if (S.result) lines.push(S.result.winner === -1 ? `まで 引き分け（${S.result.reason}）` : `まで ${SIDE[S.result.winner]}の勝ち（${S.result.reason}）`);
    return lines.join('\n');
  }

  function importKifu(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const head = lines.find(l => /軍儀 棋譜/.test(l)) || '';
    const lm = head.match(/（(入門|初級|中級|上級)・(固定配置|自由配置)）/);
    if (!lm) throw new Error('1行目の「軍儀 棋譜（上級・自由配置）」が見つかりません');
    const level = G.LEVEL_KEYS.find(k => G.LEVELS[k].name === lm[1]);
    const setup = lm[2] === '固定配置' ? 'fixed' : 'free';
    const pos = new Position(level, { setup }), moves = [];
    for (const l of lines) {
      const mm = l.match(/^(\d+)\s+([▲△]\S+)/);
      if (!mm) continue;
      const m = pos.legalMoves().find(x => pos.moveText(x) === mm[2]);
      if (m === undefined) throw new Error(`${mm[1]}手目「${mm[2]}」が指せません`);
      pos.make(m); moves.push(m);
    }
    const r = lines.find(l => /^まで/.test(l));
    let result = null;
    if (r && /投了/.test(r)) { const w = /先手の勝ち/.test(r) ? BLACK : WHITE; result = { winner: w, reason: `${SIDE[w ^ 1]}の投了` }; }
    loadGame({ level, setup, seats: ['human', 'human'], moves, result });
  }

  // ------------------------------------------------------------------ ダイアログ
  let draft = null;
  function openNew() {
    draft = Object.assign({}, cfg);
    drawNew();
    $('dlg-new').hidden = false;
    $('ng-start').focus();
  }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['pvp', 'ふたりで対局'], ['watch', 'CPUどうしを観戦']], draft.mode);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-side', [['black', '先手（先に指す）'], ['white', '後手'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    seg('ng-level', G.LEVEL_KEYS.map(k => [k, G.LEVELS[k].name]), draft.level);
    seg('ng-setup', [['fixed', '固定配置'], ['free', '自由配置']], draft.setup);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
    const L = G.LEVELS[draft.level];
    $('ng-level-hint').textContent = `ツケは${L.maxTier}段まで・${L.types.length === 14 ? '特殊駒（弓・筒・砲・謀）あり（25枚）' : L.types.includes(G.YUM) ? '特殊駒は弓のみ（22枚）' : '特殊駒なし（20枚）'}・帥のツケ${L.kingTsuke ? 'あり' : 'なし'}`;
    $('ng-setup-hint').textContent = draft.setup === 'fixed'
      ? '決まった並びから始めます（並べなかった駒は手駒）。' + (L.fixed ? '公式もこの段階は固定配置です。' : '公式ではこの段階は自由配置です。')
      : '交互に自陣3段へ1枚ずつ置き、「済」で始めます（最初は帥）。' + (L.fixed ? '公式ではこの段階は固定配置です。' : '公式もこの段階は自由配置です。');
  }

  function showResult() {
    const r = S.result;
    if (!r) return;
    const humans = [BLACK, WHITE].filter(c => isHuman(c));
    let title = r.winner === -1 ? '引き分け' : `${SIDE[r.winner]}の勝ち`;
    if (humans.length === 1 && r.winner !== -1) title = r.winner === humans[0] ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${G.LEVELS[S.level].name}・${S.setup === 'fixed' ? '固定配置' : '自由配置'}・${S.moves.length}手${S.online ? '・オンライン' : ''}`;
    $('rs-title').textContent = title;
    const opp = S.online ? `相手は ${S.online.opp.name} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : humans.length === 1 ? `相手は CPU（${CPU[S.seats[humans[0] ^ 1]].label}）でした。` : '';
    $('rs-body').textContent = r.winner === -1 ? `${r.reason}。${opp}` : `${r.reason}。${opp}`;
    $('rs-again').textContent = S.online ? 'もう一局（先後交代）' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  // ------------------------------------------------------------------ ルール / AI ページ
  const MOVE_TEXT = ['', '全方向に1マス', '縦横にどこまでも＋斜めに1マス', '斜めにどこまでも＋縦横に1マス', '前・斜め前・横・後ろに1マス',
    '前・斜め前・後ろに1マス', '前に2マス、斜め前・後ろに1マス', '前後に2マス、左右に1マス', '斜めに2マス', '前・横・斜め後ろに1マス',
    '前後に1マス', '前方へ飛び越えて2マス先（正面と左右斜め）、後ろに1マス', '前方へ飛び越えて2マス先、斜め後ろに1マス',
    '前方へ飛び越えて3マス先、横・後ろに1マス', '斜め前・後ろに1マス。ツケた相手駒を寝返らせる'];

  function diagram(t, k) {
    const cells = new Array(81).fill('');
    const cx = 4, cy = 5;
    for (const m of G.moveSpec(t, k)) {
      if (m.jump) { const x = cx + m.dx, y = cy + m.dy; if (x >= 0 && x < 9 && y >= 0 && y < 9) cells[y * 9 + x] = 'j'; }
      else for (let i = 1; i <= m.d; i++) {
        const x = cx + m.dx * i, y = cy + m.dy * i;
        if (x < 0 || x > 8 || y < 0 || y > 8) break;
        cells[y * 9 + x] = m.d >= 8 ? 'r' : 'm';
      }
    }
    cells[cy * 9 + cx] = 'c';
    return cells.map(c => `<i class="${c}"></i>`).join('');
  }
  function setupDiagram(levelKey) {
    const p = new Position(levelKey, { setup: 'fixed' });
    let html = '<div class="mini" style="max-width:240px">';
    for (let s = 0; s < 81; s++) {
      const h = p.hgt[s];
      if (!h) { html += '<i></i>'; continue; }
      const q = p.stk[s * 3 + h - 1];
      html += `<i style="display:grid;place-items:center;background:${q >> 4 ? 'var(--pc-white)' : 'var(--pc-black)'};color:${q >> 4 ? '#16181b' : '#f3eddf'};font:800 10px/1 var(--font-display)">${KANJI[q & 15]}</i>`;
    }
    html += '</div>';
    const hand = []; for (let t = 1; t < G.NT; t++) if (p.hand[t]) hand.push(KANJI[t] + (p.hand[t] > 1 ? p.hand[t] : ''));
    return html + `<p class="hint" style="margin:4px 0 0">手駒: ${hand.join('・') || 'なし'}</p>`;
  }

  function renderRules() {
    const chips = PIECE_ORDER.map(t => `<button type="button" data-t="${t}" aria-pressed="${t === SUI}" title="${NAMES[t]}">${discHTML(BLACK, t)}</button>`).join('');
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>9×9の盤で、相手の<b>帥（スイ）</b>を取るか<b>詰み</b>にすれば勝ち。同じ局面が4回で<b>千日手</b>（引き分け）。</li>
          <li>1手で「移動」「取る」「ツケ」「新」のどれか1つを行います。</li>
          <li><b>ツケ</b>：駒の上に駒を重ねます（上級は3段、それ以外は2段まで）。重なった駒は一番上だけが動けます。段が上がると利きが1マスずつ伸びます。</li>
          <li>自分のいる段より<b>高い</b>駒には、取ることもツケることもできません。帥の上には何も重ねられません（帥が他の駒にツケるのは中級・上級のみ）。</li>
          <li><b>取る</b>：そのマスの相手駒はまとめて取ります（取った駒は使えません）。下に自分の駒が埋まっていれば、それはそのまま残ります。</li>
          <li><b>新（あらた）</b>：手駒を打ちます。打てるのは「自分の一番前にいる駒」と同じ段か、それより自陣側。空きマスか自分の駒の上だけです。</li>
          <li><b>謀（ボウショウ）の寝返り</b>：謀で相手の駒にツケたとき（新で打ったときも可）、その相手駒を自分の手駒の同じ駒と入れ替えられます。2段なら全部まとめて。手駒が足りなければできません。</li>
          <li>弓・筒・砲は駒を<b>飛び越えて</b>動けます（自分の段より高い駒は飛び越えられません）。それ以外の駒は途中に駒があると止まります。</li>
        </ul>
      </div>
      <div class="card" data-tab="配置">
        <h3>初期配置</h3>
        <p>公式では<b>入門・初級は固定配置</b>、<b>中級・上級は自由配置</b>です。このアプリでは「新しい対局」でどの段階でも切り替えられます。</p>
        <p><b>自由配置</b>：先手から交互に自陣3段へ1枚ずつ置き（最初は帥）、「済」で終わります。後手が済とした時点で対局開始（先手から）。「おまかせ」でCPUの型どおりに置けます。</p>
        <p class="hint">下は固定配置のときの並び（先手側）。</p>
        <div class="setup3" style="margin-top:8px">
          <div><b>入門</b>${setupDiagram('nyumon')}</div>
          <div><b>初級</b>${setupDiagram('shokyu')}</div>
          <div><b>中級・上級</b>${setupDiagram('jokyu')}</div>
        </div>
        <p class="hint">固定配置の並びは公式のものを確認できなかったため、このアプリ独自のものです。</p>
      </div>
      <div class="card" data-tab="駒の動き">
        <h3>駒の動き</h3>
        <div class="pchips" id="pchips">${chips}</div>
        <div class="pview" id="pview"></div>
      </div>
      <div class="card" data-tab="段階">
        <h3>ルールの段階</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>段階</th><th>公式の配置</th><th>使う駒</th><th>ツケ</th><th>帥のツケ</th></tr></thead><tbody>
          <tr><td>入門</td><td>固定</td><td>特殊駒なし（20枚）</td><td>2段</td><td>なし</td></tr>
          <tr><td>初級</td><td>固定</td><td>弓のみ追加（22枚）</td><td>2段</td><td>なし</td></tr>
          <tr><td>中級</td><td>自由</td><td>全14種（25枚）</td><td>2段</td><td>あり</td></tr>
          <tr><td>上級</td><td>自由</td><td>全14種（25枚）</td><td>3段</td><td>あり</td></tr>
        </tbody></table></div>
      </div>
      <div class="card src" data-tab="出典">
        <h3>出典</h3>
        <ul style="font-size:13px">
          <li><a href="https://www.universal-music.co.jp/other/hunter-gungi__qa/" target="_blank" rel="noopener">HUNTER×HUNTER 軍儀 Q＆A（ユニバーサル ミュージック）</a>：ツケ・取り・新・帥・謀の扱い、段階ごとの配置</li>
          <li><a href="https://www.kyproduce.com/gungi/rules/pieces/" target="_blank" rel="noopener">軍儀Web コマの説明</a>：段ごとの駒の利き</li>
          <li><a href="https://note.com/gungi_problem/m/m9ce4f999f0e9" target="_blank" rel="noopener">源川さとし「軍儀・ルール解説」</a>：駒の動きの照合</li>
          <li><a href="https://note.com/roggysan_phd/n/n903eeed54e90" target="_blank" rel="noopener">ロジーさん「軍儀の考察 第二弾 公式ルールと棋譜」</a>：段階ごとの違い・千日手</li>
        </ul>
      </div>`;
    renderPiece(SUI, 1);
    docTabs($('view-rules'), 'rules');
  }

  // 駒図鑑: 1つの駒の動きを大きな図で（段ボタンで2段目・3段目）
  const PIECE_ORDER = [SUI, G.TAI, G.CHU, G.SHO, G.SAM, G.YAR, G.KIB, G.SIN, G.TOR, G.HYO, G.YUM, G.TSU, G.HOO, G.BOU];
  function renderPiece(t, k) {
    $('pview').innerHTML = `
      <div class="mini">${diagram(t, k)}</div>
      <div class="info">
        <h4>${NAMES[t]}</h4>
        <span class="hint">${G.PIECE_COUNT[t]}枚${t >= G.YUM ? '・特殊駒' : ''}</span>
        <div class="tierbtns" data-t="${t}" style="max-width:220px">${[1, 2, 3].map(x => `<button type="button" data-k="${x}" aria-pressed="${x === k}">${x}段目</button>`).join('')}</div>
        <p>${MOVE_TEXT[t]}</p>
        <div class="legend"><span style="--c:var(--pc-black)">駒の位置</span><span style="--c:color-mix(in srgb, var(--accent) 55%, var(--surface-2))">動ける</span><span style="--c:color-mix(in srgb, var(--accent) 30%, var(--surface-2))">どこまでも</span><span style="--c:color-mix(in srgb, var(--gold) 70%, var(--surface-2))">飛び越えて着地</span></div>
        <p class="hint">先手から見た図（上が前）。段が上がるほど利きが伸びます。対局中は、盤の駒をタップするとその場で利きを見られます。</p>
      </div>`;
    $('pchips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.t) === t)));
  }

  // 読み物のページ（ルール・AI）は、カードの見出しからタブを作って1枚ずつ見せる（ページを長くスクロールしない）
  function docTabs(view, key) {
    const cards = [...view.querySelectorAll(':scope > .card')];
    if (cards.length < 2) return;
    const bar = document.createElement('div');
    bar.className = 'doctabs'; bar.setAttribute('role', 'tablist');
    bar.innerHTML = cards.map((c, i) => `<button role="tab" data-i="${i}">${esc(c.dataset.tab || (c.querySelector('h3') || {}).textContent || i + 1)}</button>`).join('');
    view.prepend(bar);
    const show = i => {
      cards.forEach((c, j) => { c.hidden = j !== i; });
      bar.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
      store.set('doctab-' + key, i);
      document.querySelector('main').scrollTop = 0;
    };
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); });
    show(Math.min(store.get('doctab-' + key, 0), cards.length - 1));
  }

  function renderAIPage() {
    const h = W.history || [];
    const gen = W.gen || 0, total = W.totalGames || 0;
    const acc = h.filter(e => e.accepted);
    let cum = 0;
    const series = h.map(e => { if (e.accepted) cum += Math.max(0, e.elo); return { gen: e.gen, elo: cum, accepted: e.accepted, games: e.totalGames }; });
    const vs = W.vsInitial;
    const bw = 600, bh = 170, pad = 28;
    let chart = '';
    if (series.length > 1) {
      const maxE = Math.max(50, ...series.map(s => s.elo)), g0 = series[0].gen, g1 = series[series.length - 1].gen;
      const X = g => pad + (g - g0) / Math.max(1, g1 - g0) * (bw - pad - 8), Y = e => bh - 20 - e / maxE * (bh - 34);
      const line = series.map(s => `${X(s.gen).toFixed(1)},${Y(s.elo).toFixed(1)}`).join(' ');
      const ticks = [0, 0.5, 1].map(f => Math.round(maxE * f));
      chart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="世代ごとの強さの伸び（推定Elo）">
        ${ticks.map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${t}</text>`).join('')}
        <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${series.map(s => `<circle cx="${X(s.gen)}" cy="${Y(s.elo)}" r="${s.accepted ? 3 : 2}" fill="${s.accepted ? 'var(--good)' : 'var(--muted)'}"><title>第${s.gen}世代 ${s.accepted ? '採用' : '不採用'}・累計+${s.elo}</title></circle>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第${g0}世代</text><text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${g1}世代</text>
      </svg>`;
    }
    // 初期版との直接対戦（実測）の推移
    // 同じ基準の版との測定だけを並べる（基準は途中で強い版に切り替えることがある）
    const allMs = W.measures && W.measures.length ? W.measures : vs ? [vs] : [];
    const anchorName = allMs.length ? (allMs[allMs.length - 1].anchor || '初期版') : '初期版';
    const ms = allMs.filter(m => (m.anchor || '初期版') === anchorName).slice(-40);
    let mchart = '';
    if (ms.length) {
      const top = Math.max(100, ...ms.map(m => m.elo + (m.eloErr || 0))), gMin = ms[0].gen, gMax = ms[ms.length - 1].gen;
      const X = g => pad + (gMax === gMin ? 0.5 : (g - gMin) / (gMax - gMin)) * (bw - pad - 16), Y = e => bh - 20 - Math.max(0, e) / top * (bh - 34);
      mchart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="初期版との直接対戦で測った強さの推移">
        ${[0, 0.5, 1].map(f => Math.round(top * f)).map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">+${t}</text>`).join('')}
        ${ms.length > 1 ? `<polyline points="${ms.map(m => `${X(m.gen).toFixed(1)},${Y(m.elo).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--gold)" stroke-width="2"/>` : ''}
        ${ms.map(m => `<line x1="${X(m.gen)}" x2="${X(m.gen)}" y1="${Y(m.elo - (m.eloErr || 0))}" y2="${Y(m.elo + (m.eloErr || 0))}" stroke="var(--gold)" stroke-width="1.5"/><circle cx="${X(m.gen)}" cy="${Y(m.elo)}" r="4" fill="var(--gold)"><title>第${m.gen}世代: 初期版に${(m.score * 100).toFixed(1)}%（Elo +${m.elo}±${m.eloErr}、${m.games}局）</title></circle><text x="${X(m.gen)}" y="${Y(m.elo) - 9}" text-anchor="middle" fill="var(--ink)" font-size="10">+${m.elo}</text>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第${gMin}世代</text>${gMax !== gMin ? `<text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${gMax}世代</text>` : ''}
      </svg>`;
    }
    const stats = W.setupStats || {};
    const tplRows = ['chukyu', 'jokyu'].map(lv => {
      const st = stats[lv] || {};
      const cells = G.TEMPLATES.map(t => { const e = st[t.name]; return `<td>${e && e.n ? `${(e.w / e.n * 100).toFixed(0)}%<small style="color:var(--muted)">（${e.n}）</small>` : '—'}</td>`; }).join('');
      return `<tr><td>${G.LEVELS[lv].name}</td>${cells}</tr>`;
    }).join('');
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>このAIの強さ</h3>
        <div class="stat-row">
          <div class="stat"><b>${gen}</b><span>学習世代</span></div>
          <div class="stat"><b>${total.toLocaleString()}</b><span>自己対局（累計局数）</span></div>
          <div class="stat"><b>${acc.length}</b><span>採用された更新</span></div>
          ${vs ? `<div class="stat"><b>${(vs.score * 100).toFixed(1)}%</b><span>${vs.anchor || '初期版'}との直接対戦の勝率（第${vs.gen}世代・${vs.games}局・Elo ${vs.elo >= 0 ? '+' : ''}${vs.elo}±${vs.eloErr}）</span></div>` : ''}
          <div class="stat wide-only"><b>+${cum}</b><span>各世代の上昇幅の合計（目安。実際より大きめに出ます）</span></div>
        </div>
        <div class="charts2">
        ${mchart ? `<div><p class="hint" style="margin:14px 0 6px"><b>実測の強さ</b>：${anchorName === '初期版' ? '初期版（手作りの評価関数・旧来の探索）' : anchorName + 'のAI'}と先後入れ替えで直接対戦したときの Elo 差。縦線は誤差の目安。</p>${mchart}</div>` : ''}
        ${chart ? `<div class="wide-only"><p class="hint" style="margin:14px 0 6px">世代ごとの検定：「学習した新版 vs それまでの版」を対戦し、勝ち越したら採用（緑）。線はその上昇幅の合計（目安）。</p>${chart}</div>` : '<p>まだ学習していません。</p>'}
        </div>
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ</h3>
        <ul>
          <li><b>探索</b>：将棋・チェスのソフトと同じ αβ 探索（反復深化・置換表・静止探索・Null Move・LMR・枝刈り）。ブラウザでも1秒に数十万局面を読みます。</li>
          <li><b>評価関数</b>：駒の価値・手駒・段・動ける範囲・取られそうな駒・帥の守りなど約800項目に加えて、<b>「自分の帥・相手の帥から見た各駒の位置」</b>（約10万項目）の重み付き和。将棋ソフト Bonanza・elmo 系と同じ考え方です。</li>
          <li><b>強化学習</b>：AI同士の自己対局で局面を集め、「この局面から先手が勝つ確率」を当てるように重みを調整します（Texel法・ロジスティック回帰）。調整した版が旧版に勝ち越したときだけ採用します。</li>
          <li><b>評価値</b>：勝率 = 1 / (1 + e<sup>−評価値/600</sup>) になるよう学習しているので、評価値+600で先手の勝率は約73%です。</li>
          <li><b>GPUは不要</b>：この方式はCPUだけで速く学習できます。</li>
        </ul>
        <table class="lv wide-only" style="margin-top:8px"><thead><tr><th>CPUの強さ</th><th>1手の考える時間</th><th>特徴</th></tr></thead><tbody>
          ${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].time / 1000}秒</td><td>${CPU[k].desc}</td></tr>`).join('')}
        </tbody></table>
      </div>
      ${bookHTML()}
      <div class="card" data-tab="最初の型">
        <h3>最初に用意した配置の型（中級・上級）</h3>
        <p class="hint">学習の出発点にした6つの型。数字は自己対局でその型を使った側の勝率（局数）。</p>
        <div class="tbl"><table class="lv"><thead><tr><th>段階</th>${G.TEMPLATES.map(t => `<th>${t.name}</th>`).join('')}</tr></thead><tbody>${tplRows}</tbody></table></div>
      </div>`;
    docTabs($('view-ai'), 'ai');
  }

  // 学習で見つけた自由配置の型（自陣3段を先手から見た図。重なりは段数つき）
  function templateDiagram(cells) {
    const sq = new Map();
    for (const [t, x, r] of cells) { const k = r * 9 + x; (sq.get(k) || sq.set(k, []).get(k)).push(t); }
    let html = '<div class="mini" style="grid-template-rows:repeat(3,1fr);aspect-ratio:3/1;max-width:300px">';
    for (let r = 2; r >= 0; r--) {
      for (let x = 0; x < 9; x++) {
        const st = sq.get(r * 9 + x);
        html += st
          ? `<i style="display:grid;place-items:center;background:var(--pc-black);color:#f3eddf;font:800 12px/1 var(--font-display);position:relative">${KANJI[st[st.length - 1]]}${st.length > 1 ? `<small style="position:absolute;right:1px;bottom:0;font:700 8px/1 var(--font-body);color:var(--gold)">${st.length}</small>` : ''}</i>`
          : '<i></i>';
      }
    }
    return html + '</div>';
  }
  function bookHTML() {
    const book = W.setupBook || {};
    const parts = ['jokyu', 'chukyu'].filter(lv => book[lv] && book[lv].length).map(lv => {
      const top = book[lv][0];
      const placed = top.cells.length;
      return `<div style="display:grid;gap:6px;min-width:0">
        <b>${G.LEVELS[lv].name}の1位「${top.name}」</b>
        ${templateDiagram(top.cells)}
        <span class="hint">盤に置くのは${placed}枚（残り${25 - placed}枚は手駒）</span>
        ${(() => { const ev = (W.setupEval || {})[lv]; return ev && ev.name === top.name ? `<span class="hint"><b>最初の型との総当たり（${ev.games}局）: 勝率${(ev.score * 100).toFixed(1)}%</b> ／ ${ev.vs.map(([n, v]) => `${n} ${(v * 100).toFixed(0)}%`).join('・')}</span>` : ''; })()}
        <span class="hint">2位以下: ${book[lv].slice(1).map(t => t.name).join('・') || 'なし'}</span>
      </div>`;
    });
    if (!parts.length) return '';
    return `<div class="card" data-tab="学習した配置">
      <h3>学習した自由配置</h3>
      <p class="hint">配置の型を自己対局で戦わせ、勝った型を少しずつ変えて残す「進化」で見つけた並べ方です。CPUの自由配置と「おまかせ配置」はこの型を使います。図は自陣の3段（上が前）。</p>
      <div class="stat-row" style="align-items:flex-start">${parts.join('')}</div>
    </div>`;
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      if (b.dataset.tab === 'rules' && !$('view-rules').innerHTML) renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
    }));
    $('view-rules').addEventListener('click', e => {
      const chip = e.target.closest('#pchips button');
      if (chip) { renderPiece(Number(chip.dataset.t), 1); return; }
      const b = e.target.closest('.tierbtns button');
      if (b) renderPiece(Number(b.parentElement.dataset.t), Number(b.dataset.k));
    });
    document.addEventListener('click', e => {
      const hp = e.target.closest('.hp');
      if (hp && !hp.disabled) {
        hideChooser();
        const t = Number(hp.dataset.hand);
        if (S.sel && S.sel.hand === t && S.pos.phase === MAIN) clearSel(); else selectHand(t); // もう一度タップで選択を外す
        return;
      }
      if (!e.target.closest('#chooser')) hideChooser();
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
    });
    // 手駒にマウスを乗せると、打てるマスを薄く表示
    document.addEventListener('mouseover', e => {
      const hp = e.target.closest && e.target.closest('.hp');
      const t = hp && !hp.disabled ? Number(hp.dataset.hand) : 0;
      if (t !== (S.hoverHand || 0)) { S.hoverHand = t; renderMarks(); }
    });
    // 情報の行のボタン（選択の解除・配置の「済」「おまかせ」・見返し中・終局）
    $('sqinfo').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act, c = S.pos.stm;
      if (act === 'desel') { hideChooser(); clearSel(); }
      else if (act === 'done' && humanTurn() && S.legal.includes(DONE)) play(DONE);
      else if (act === 'auto' && humanTurn()) { S.autoSetup[c] = S.agents[c].pickTemplate(S.level, false); S.agents[c].template = S.autoSetup[c]; S.sel = null; S.targets = new Map(); render(); schedule(); }
      else if (act === 'auto-stop') { S.autoSetup[c] = null; clearTimeout(S.timer); afterChange(); }
      else if (act === 'live') viewPly(S.moves.length);
      else if (act === 'branch') branch();
      else if (act === 'review') viewPly(0);
      else if (act === 'rematch') requestRematch();
      else if (act === 'lobby') { leaveOnline(); openOnline(); }
      else if (act === 'claim' && S.online && !S.result) { S.result = { winner: S.online.myColor, reason: '相手の接続切れ' }; afterChange(); }
      else if (act === 'again') startGame(cfg);
    });
    // ナビの行: ⏮ ◀ ▶ ⏭ と棋譜テープ
    $('navrow').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      e.stopPropagation();
      const nav = b.dataset.nav;
      if (nav === 'first') viewPly(0);
      else if (nav === 'prev') viewPly(shownPly() - 1);
      else if (nav === 'next') viewPly(shownPly() + 1);
      else if (nav === 'last') viewPly(S.moves.length);
      else if (nav === 'sheet') { if ($('side').classList.contains('open')) closeSheet(); else openSheet('kifu'); }
      else if (b.dataset.ply != null) viewPly(Number(b.dataset.ply));
    });
    // AI補助: 形勢と矢印をまとめて出し入れ（どちらかが出ていれば両方隠す）
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); });
    // ⋯メニュー
    $('btn-more').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('menu-more'); m.hidden = !m.hidden;
      $('btn-more').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'graph' : 'kifu'));
    window.addEventListener('resize', () => { fitBoardSoon(); if ($('side').classList.contains('open')) placeSheet(); });
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; NET.challenge(b.dataset.ch); renderLobby(); return; }
      const segEl = b.closest('[data-seg]');
      if (segEl) { lobby[segEl.dataset.seg] = b.dataset.v; renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') { lobby.msg = ''; NET.wait(lobby.lv, lobby.su); renderLobby(); renderOnlineBadge(); }
      else if (act === 'unwait') { NET.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); renderLobby(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?room=${NET.me.c}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
      }
    });
    $('dlg-online').addEventListener('change', e => {
      if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; store.set('name', myName); if (NET) NET.setName(myName); }
    });
    $('btn-new').addEventListener('click', () => {
      if (S.online && !S.result && !confirm('オンライン対局の途中です。新しい対局を始めると投了になります。よろしいですか？')) return;
      if (S.online && !S.result) resign();
      openNew();
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-flip').addEventListener('click', () => { S.flip = !S.flip; hideChooser(); saveGame(); render(); });
    document.addEventListener('click', e => { if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); } });
    $('btn-resign').addEventListener('click', resign);
    $('btn-hint').addEventListener('click', () => {
      if (!humanTurn()) return;
      if (S.online && NET) { S.online.myHints++; NET.send({ t: 'hint' }); saveGame(); renderPlayers(); }
      const ply = S.moves.length, c = S.pos.stm;
      AI.start({ level: S.level, setup: S.setup, moves: S.moves.slice(), timeMs: HINT_MS, analyze: true, parallel: true },
        info => onInfo(ply, c, info, 'hint'), info => onInfo(ply, c, info, 'hint'));
    });
    $('btn-settings').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('settings'); p.hidden = !p.hidden;
      $('btn-settings').setAttribute('aria-expanded', String(!p.hidden));
    });
    [['set-eval', 'showEval'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-arrow', 'arrow'], ['set-reach', 'reach'], ['set-analyze', 'analyze']].forEach(([id, k]) => {
      const el = $(id);
      el.checked = settings[k];
      el.addEventListener('change', () => setSetting(k, el.checked));
    });
    // 評価値の行を押すと、振り返りパネルの「形勢」（読み筋・深さ）
    $('evstrip').addEventListener('click', () => openSheet('ev'));
    $('evstrip').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet('ev'); } });
    $('side').addEventListener('click', e => {
      const t = e.target.closest('[data-st]');
      if (t) { openSheet(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) closeSheet();
    });
    document.querySelector('.evoff-card button').addEventListener('click', () => setSetting('showEval', true));
    $('kifu').addEventListener('click', e => { const li = e.target.closest('li'); if (li) viewPly(Number(li.dataset.ply)); });
    $('graph').addEventListener('click', e => {
      const r = $('graph').getBoundingClientRect(), n = Math.max(S.moves.length, 40);
      viewPly(Math.max(0, Math.min(S.moves.length, Math.round((e.clientX - r.left) / r.width * n))));
    });
    $('btn-live').addEventListener('click', () => viewPly(S.moves.length));
    $('btn-branch').addEventListener('click', branch);
    $('btn-copy').addEventListener('click', () => {
      const text = kifuText(), msg = $('copy-msg');
      const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.rows = 6; ta.style.width = '100%'; msg.innerHTML = ''; msg.appendChild(ta); ta.select(); };
      try { navigator.clipboard.writeText(text).then(() => { msg.textContent = 'コピーしました'; setTimeout(() => { msg.textContent = ''; }, 2500); }, fallback); } catch (e) { fallback(); }
    });
    $('btn-import').addEventListener('click', () => { $('im-msg').textContent = ''; $('dlg-import').hidden = false; $('im-text').focus(); });
    $('im-cancel').addEventListener('click', () => { $('dlg-import').hidden = true; });
    $('im-ok').addEventListener('click', () => {
      try { importKifu($('im-text').value); $('dlg-import').hidden = true; } catch (err) { $('im-msg').textContent = err.message; }
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-side') draft.side = v;
        else if (id === 'ng-cpu-b') draft.cpuB = v;
        else if (id === 'ng-cpu-w') draft.cpuW = v;
        else if (id === 'ng-level') { draft.level = v; draft.setup = G.LEVELS[v].fixed ? 'fixed' : 'free'; }
        else if (id === 'ng-setup') draft.setup = v;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) $('dlg-new').hidden = true;
    });
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; });
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; startGame(draft); });
    // 終局
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; if (S.online) requestRematch(); else startGame(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewPly(0); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); hideChooser(); ['dlg-new', 'dlg-result', 'dlg-import', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.sel || S.inspect >= 0) clearSel(); return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.moves.length); }
    });
  }

  // ------------------------------------------------------------------ オンライン対戦
  // 公開版（GitHub Pages）や自分のサーバーでだけ使う。claude.ai のアーティファクトでは外部へつなげないので案内だけ出す
  const ONLINE_OK = /^https?:$/.test(location.protocol) && !/claude|anthropic/i.test(location.hostname) && !!window.GungiOnline;
  const PAGES_URL = 'https://angrh0824.github.io/gungi/';
  let NET = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { lv: cfg.level, su: cfg.setup, msg: '' };
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.arrow ? 2 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢' : '', f & 2 ? '最善手の矢印' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }
  const ruleText = (lv, su) => `${G.LEVELS[lv] ? G.LEVELS[lv].name : '？'}・${su === 'fixed' ? '固定配置' : '自由配置'}`;

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = GungiOnline.create({
      onStatus: st => {
        renderOnlineBadge(); renderLobby();
        if (S.online) { if (st === 'on') { S.online.lostAt = S.online.oppPresent ? 0 : Date.now(); } renderSqInfo(); renderPlayers(); }
      },
      onPresence: () => { renderOnlineBadge(); renderLobby(); tryRoom(); },
      onMatch: g => startOnline(g),
      onRemote: m => onRemote(m),
      onOppPresence: p => { if (S.online) { S.online.oppPresent = p; S.online.lostAt = p ? 0 : Date.now(); renderSqInfo(); renderPlayers(); } },
      onChallenge: r => { lobby.msg = r === 'no' ? 'その人はもう別の対局を始めていました' : '返事がありませんでした（相手の通信が切れているかもしれません）'; renderLobby(); },
    });
    NET.setName(myName);
    NET.setAI(aiFlags());
    NET.connect();
    setInterval(() => { if (S.online && !S.online.oppPresent) renderSqInfo(); }, 10000);
    return NET;
  }

  function startOnline(g) {
    $('dlg-online').hidden = true;
    const lv = G.LEVELS[g.lv] ? g.lv : 'jokyu', su = g.su === 'fixed' ? 'fixed' : 'free';
    const online = { gid: g.gid, myColor: g.myColor ? WHITE : BLACK, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, lostAt: 0, myRe: false, oppRe: false };
    const seats = online.myColor === BLACK ? ['human', 'remote'] : ['remote', 'human'];
    cfg.level = lv; cfg.setup = su;
    loadGame({ level: lv, setup: su, seats, moves: [], online });
    clack('move');
  }
  function leaveOnline() {
    if (NET && NET.game) NET.leaveGame();
    if (S.online) { S.online = null; S.seats = S.seats.map(x => (x === 'remote' ? 'human' : x)); }
  }

  // 相手から届いたもの: あいさつ（名前・AI補助）、指し手、今の状態、投了、AI補助の変更、ヒント、もう一局
  function onRemote(msg) {
    const o = S.online;
    if (!o || !msg) return;
    if (msg.t === 'hi') {
      if (msg.n) o.opp.name = String(msg.n).slice(0, 16);
      o.opp.ai = msg.ai | 0;
      if (!msg.re) NET.send({ t: 'hi', re: 1, n: myName, ai: aiFlags() });
      saveGame(); renderPlayers(); renderSqInfo();
    } else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; saveGame(); renderPlayers(); }
    else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; saveGame(); renderPlayers(); }
    else if (msg.t === 'mv') { if ((msg.n | 0) === S.moves.length + 1) applyRemote([msg.m | 0]); }
    else if (msg.t === 'state' && Array.isArray(msg.moves)) {
      for (let i = 0; i < Math.min(msg.moves.length, S.moves.length); i++) if ((msg.moves[i] | 0) !== S.moves[i]) return; // 食い違うものは使わない
      applyRemote(msg.moves.slice(S.moves.length).map(x => x | 0));
    } else if (msg.t === 'resign') {
      if (!S.result) { S.result = { winner: o.myColor, reason: `${o.opp.name}さんの投了` }; afterChange(); }
    } else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.gid === 'string') {
      NET.start({ gid: msg.gid.slice(0, 20), myColor: msg.oc ? 1 : 0, lv: S.level, su: S.setup, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  // 相手の手を順に指す（相手の番で、合法手のときだけ）
  function applyRemote(list) {
    for (const m of list) {
      if (S.result || !isRemote(S.pos.stm) || !S.legal.includes(m)) break;
      play(m, true);
    }
  }
  // もう一局: 両方が希望したら、ID の小さい方が新しい対局を作る（先後は交代）
  function requestRematch() {
    const o = S.online;
    if (!o || !NET) return;
    o.myRe = true;
    NET.send({ t: 're' });
    maybeRematch();
    renderSqInfo();
  }
  function maybeRematch() {
    const o = S.online;
    if (!o || !o.myRe || !o.oppRe || !NET || !NET.game) return;
    const oppId = NET.game.oppId;
    if (oppId && NET.id > oppId) return; // 相手が作るのを待つ
    const gid = Math.random().toString(36).slice(2, 12);
    NET.send({ t: 'rego', gid, oc: o.myColor });
    NET.start({ gid, myColor: o.myColor ^ 1, lv: S.level, su: S.setup, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
  }

  // 招待リンク（?room=コード）で開いたら、その部屋の人が見えしだい申し込む
  function tryRoom() {
    if (!roomCode || !NET || NET.status !== 'on' || NET.game) return;
    const p = NET.list().find(x => x.s === 'wait' && x.c === roomCode.toUpperCase());
    if (!p) return;
    roomCode = null;
    history.replaceState(null, '', location.pathname);
    lobby.msg = `${p.n}さんに申し込みました…`;
    NET.challenge(p.id);
    renderLobby();
  }

  function openOnline() {
    if (!ONLINE_OK) {
      lobby.msg = '';
      $('dlg-online').hidden = false;
      $('on-body').innerHTML = `<p>オンライン対戦は、公開版（GitHub Pages）で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
      return;
    }
    net();
    $('dlg-online').hidden = false;
    renderLobby();
  }

  function renderOnlineBadge() {
    const b = $('btn-online');
    if (!b) return;
    const st = NET ? NET.status : 'off';
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null;
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${c.wait}</small>` : st === 'connecting' ? '…' : '';
  }

  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', c = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait') : [];
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join('')}</div>`;
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン</span></div>
        <div class="stat"><b>${num(c && c.wait)}</b><span>対戦待ち</span></div>
        <div class="stat"><b>${num(c && c.play)}</b><span>対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・最善手の矢印を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b><span class="hint">${ruleText(p.lv, p.su)}</span>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「この設定で待つ」で相手を待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span><b>${ruleText(me.lv, me.su)}</b>で待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）</span></div>`
          : `${seg('lv', G.LEVEL_KEYS.map(k => [k, G.LEVELS[k].name]), lobby.lv)}${seg('su', [['fixed', '固定配置'], ['free', '自由配置']], lobby.su)}
             <div><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>この設定で待つ</button></div>`}
      </div>
      <p class="hint on-note">公開の中継サーバーを使うため、名前と指し手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
  }

  // 振り返りパネル: 狭い画面だけ。盤のすぐ下から画面の下までを覆い、盤は見えたまま（グラフや棋譜を押すとその局面へ）
  const narrow = () => window.matchMedia('(max-width: 979px)').matches;
  function placeSheet() {
    const fr = document.querySelector('.board-frame').getBoundingClientRect(), h = window.innerHeight;
    $('side').style.setProperty('--sheet-top', Math.round(Math.min(h * 0.68, Math.max(h * 0.3, fr.bottom + 6))) + 'px');
  }
  function openSheet(tab) {
    const side = $('side');
    if (!settings.showEval && (tab === 'ev' || tab === 'graph')) tab = 'kifu';
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (!narrow()) return; // 広い画面では右に常に出ている
    placeSheet();
    side.classList.add('open');
    renderKifu(); renderGraph();
  }
  function closeSheet() { $('side').classList.remove('open'); }

  function setSetting(k, v, quiet) {
    settings[k] = v; store.set('settings', settings);
    const box = { showEval: 'set-eval', arrow: 'set-arrow' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if ((k === 'showEval' || k === 'arrow') && NET) NET.setAI(aiFlags());
    if ((k === 'analyze' || k === 'showEval' || k === 'arrow') && !S.thinking && isHuman(S.pos.stm)) analyze();
    render();
  }

  function branch() {
    if (live()) return;
    AI.cancel();
    const n = S.view;
    S.view = null; S.dpos = null;
    rebuild(n);
    afterChange();
  }

  bind();
  // Webフォントが読み込まれたら文字の位置を測り直して描き直す
  if (document.fonts) {
    const refit = () => { const before = glyphFont; measureGlyphs(); if (glyphFont !== before) { render(); if (!$('view-rules').hidden) renderRules(); } };
    if (document.fonts.ready) document.fonts.ready.then(refit);
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', refit);
  }
  // 前回の対局があれば続きから
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  if (saved && G.LEVELS[saved.level] && Array.isArray(saved.moves)) {
    try {
      // 終わったオンライン対局や、オンラインにつなげない場所では、ふつうの対局（ふたりで対局）として開く
      if (saved.online && (!ONLINE_OK || saved.result)) { saved.online = null; saved.seats = saved.seats.map(x => (x === 'remote' ? 'human' : x)); }
      if (saved.online) saved.online = Object.assign({ myHints: 0 }, saved.online, { oppPresent: true, lostAt: 0, myRe: false, oppRe: false });
      loadGame(saved);
      if (S.online && NET) NET.rejoin({ gid: S.online.gid, myColor: S.online.myColor, opp: { id: '', name: S.online.opp.name, ai: S.online.opp.ai } }); // 対局の途中に戻る
    } catch (e) { startGame(cfg); }
  } else {
    // はじめて開いたときは対局の設定から
    startGame(cfg);
    openNew();
  }
})();
