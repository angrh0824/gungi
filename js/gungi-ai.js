/*
 * 軍儀 AI — 評価関数（線形・自己対局で学習）と αβ 探索
 *
 *  - 評価関数は「特徴量 × 重み」の線形モデル。重みは train/ の自己対局＋Texel 法（ロジスティック回帰）で調整する。
 *  - 探索: 反復深化 / PVS / 置換表 / Null Move / LMR / 静止探索（取る手のみ）/ キラー・ヒストリー
 *  - 評価値は将棋ソフトと同じく「勝率 = 1 / (1 + exp(-評価値 / 600))」になるよう学習する。
 *
 * GungiCore(G) を先に呼んだ G に対して GungiAI(G) を呼ぶ。Web Worker に toString() で埋め込むため外部参照禁止。
 */
function GungiAI(G) {
  'use strict';
  const { SUI, TAI, CHU, SHO, SAM, YAR, KIB, SIN, TOR, HYO, YUM, TSU, HOO, BOU, NT, BLACK, WHITE,
    RAY, RSTART, REND, ACT_CAP, BETRAY, DONE, DROP, MAIN, SETUP } = G;

  // ------------------------------------------------------------------ 特徴量の配置
  const F = {
    MAT: 0,        // 盤上の駒（種類別）
    HAND: 15,      // 手駒（種類別）
    T2: 30,        // 2段目の一番上にいる駒（種類別）
    T3: 45,        // 3段目の一番上にいる駒（種類別）
    BUR_E: 60,     // 相手駒の下敷きになっている自駒（種類別）
    BUR_O: 75,     // 自駒の下にいる自駒（種類別）
    MOB: 90,       // 動ける先の数（種類別）
    HANG: 105,     // 相手に取られる状態で守りがない駒（種類別）
    ATT: 120,      // 相手に狙われているが守りのある駒（種類別）
    K_T2: 135, K_T3: 136,  // 帥の段
    K_RING: 137,   // 帥の周囲8マスのうち相手の利きがあるマス数
    K_GUARD: 138,  // 帥の周囲にいる自駒の数
    K_NEAR: 139,   // 帥から2マス以内にいる相手駒の数
    K_ESC: 140,    // 帥の逃げ道（空きかつ相手の利きがない周囲マス）
    ZONE: 141,     // 新を打てる段の数（前線の高さ）
    TEMPO: 142,    // 手番
    CHECK: 143,    // 帥手（王手）を受けている
    PST: 150,      // 駒の位置（種類 × 段 × 筋(左右対称で5)）
    KP: 150 + NT * 45, // 帥から見た駒の配置: 帥の位置(45, 左右対称) × 駒(味方/相手 × 14種) × 駒の位置(81)
    // ---- v3: 戦術の情報 ----
    THREAT: 150 + NT * 45 + 45 * 28 * 81,  // 自分より安い相手の駒に狙われている駒（種類別）
    OVERLOAD: 150 + NT * 45 + 45 * 28 * 81 + 15, // 狙う相手の数が守る味方の数より多い駒（種類別）
    K_DANGER: 150 + NT * 45 + 45 * 28 * 81 + 30, // 帥の周りへの相手の利きの合計（0〜15の段階ごと）
    K_ZONE: 150 + NT * 45 + 45 * 28 * 81 + 46,   // 帥が相手の「新」の届く範囲にいる
    K_ZONE_HAND: 150 + NT * 45 + 45 * 28 * 81 + 47, // そのときの相手の手駒の数
  };
  const KP_SIZE = 45 * 28 * 81;
  const NFEAT_V2 = F.KP + KP_SIZE;
  const NFEAT = NFEAT_V2 + 48;
  const NFEAT_V1 = F.KP;
  const FEATURE_VERSION = 3;
  const SCALE = 600; // 勝率 = sigmoid(評価値 / SCALE)

  // 初期値（手作りの目安。学習で上書きされる）
  const VAL = [0, 0, 1100, 950, 560, 430, 500, 480, 500, 430, 150, 450, 420, 520, 450];
  function defaultWeights() {
    const w = new Float64Array(NFEAT);
    for (let t = 1; t < NT; t++) {
      if (t === SUI) continue;
      const v = VAL[t];
      w[F.MAT + t] = v;
      w[F.HAND + t] = v * 1.05;
      w[F.T2 + t] = v * 0.08 + 20;
      w[F.T3 + t] = v * 0.15 + 40;
      w[F.BUR_E + t] = -v * 0.5;
      w[F.BUR_O + t] = -v * 0.05;
      w[F.MOB + t] = (t === TAI || t === CHU) ? 2 : 4;
      w[F.HANG + t] = -v * 0.35;
      w[F.ATT + t] = -v * 0.08;
    }
    w[F.MOB + SUI] = 1;
    w[F.K_T2] = 30; w[F.K_T3] = 50; w[F.K_RING] = -25; w[F.K_GUARD] = 12; w[F.K_NEAR] = -20;
    w[F.K_ESC] = 8; w[F.ZONE] = 6; w[F.TEMPO] = 25; w[F.CHECK] = -40;
    return { version: FEATURE_VERSION, nfeat: NFEAT, scale: SCALE, gen: 0, w: Array.from(w) };
  }

  // 古い形式（v1: 帥との位置関係なし）の重みを読み込めるようにする
  function upgradeWeights(weights) {
    if (weights.version === FEATURE_VERSION && weights.w.length === NFEAT) return weights;
    // 古い形式は、足りない項目を 0 で埋める（評価値は変わらない）
    if ((weights.version === 1 && weights.w.length === NFEAT_V1) || (weights.version === 2 && weights.w.length === NFEAT_V2)) {
      const w = weights.w.concat(new Array(NFEAT - weights.w.length).fill(0));
      return Object.assign({}, weights, { version: FEATURE_VERSION, nfeat: NFEAT, w });
    }
    throw new Error('重みファイルの形式が違います');
  }

  // マスごとの前計算
  const SX = new Uint8Array(81), SY = new Uint8Array(81);
  const NEIGH = [], NEAR2 = [];
  for (let s = 0; s < 81; s++) {
    const x = s % 9, y = (s / 9) | 0;
    SX[s] = x; SY[s] = y;
    const n1 = [], n2 = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 8 || ny < 0 || ny > 8) continue;
      n2.push(ny * 9 + nx);
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) n1.push(ny * 9 + nx);
    }
    NEIGH.push(Int16Array.from(n1)); NEAR2.push(Int16Array.from(n2));
  }
  const SQ_MIR = new Uint8Array(81), SQ_ROTMIR = new Uint8Array(81);
  for (let s = 0; s < 81; s++) { SQ_MIR[s] = SY[s] * 9 + (8 - SX[s]); SQ_ROTMIR[s] = (8 - SY[s]) * 9 + SX[s]; }

  function makeWorkspace() { return { att: [new Uint8Array(81), new Uint8Array(81)], mob: new Int32Array(32), minv: [new Uint16Array(81), new Uint16Array(81)] }; }
  // 学習用の特徴量の受け皿（同じ番号が複数回出ることがあるので、使う側で足し合わせる）
  function makeSink() { return { idx: new Int32Array(1024), val: new Float64Array(1024), n: 0 }; }

  // ------------------------------------------------------------------ 評価関数
  // 先手から見た評価値を返す。out (makeSink()) を渡すと特徴量（先手 − 後手）を (番号, 値) で書き出す（学習用）。
  function evaluate(pos, w, out, ws) {
    const stk = pos.stk, hgt = pos.hgt;
    const a0 = ws.att[0], a1 = ws.att[1], mob = ws.mob, mv0 = ws.minv[0], mv1 = ws.minv[1];
    a0.fill(0); a1.fill(0); mob.fill(0); mv0.fill(65535); mv1.fill(65535);

    // パス1: 利きと可動域
    for (let s = 0; s < 81; s++) {
      const h = hgt[s];
      if (!h) continue;
      const p = stk[s * 3 + h - 1], c = p >> 4, t = p & 15;
      const att = c ? a1 : a0, mv = c ? mv1 : mv0, myv = t === SUI ? 60000 : VAL[t];
      const idx = ((c * NT + t) * 4 + h) * 81 + s;
      let r = RSTART[idx], m = 0;
      const e = REND[idx];
      while (r < e) {
        if (RAY[r] === 0) {
          const end = r + 2 + RAY[r + 1];
          for (r += 2; r < end; r++) {
            const d = RAY[r], hd = hgt[d];
            if (!hd) { m++; att[d]++; continue; }
            if (hd <= h) { att[d]++; if (myv < mv[d]) mv[d] = myv; if ((stk[d * 3 + hd - 1] >> 4) !== c) m++; }
            break;
          }
          r = end;
        } else {
          const d = RAY[r + 1], ni = RAY[r + 2];
          let ok = true;
          for (let i = 0; i < ni; i++) if (hgt[RAY[r + 3 + i]] > h) { ok = false; break; }
          r += 3 + ni;
          if (!ok) continue;
          const hd = hgt[d];
          if (!hd) { m++; att[d]++; } else if (hd <= h) { att[d]++; if (myv < mv[d]) mv[d] = myv; if ((stk[d * 3 + hd - 1] >> 4) !== c) m++; }
        }
      }
      mob[c * 16 + t] += m;
    }

    // 帥から見た座標系（先手の帥はそのまま、後手の帥は盤を180度回す。帥が右半分なら左右反転）
    let kb0 = -1, kb1 = -1, km0 = 0, km1 = 0;
    if (pos.king[0] >= 0) {
      const k = pos.king[0];
      let kx = SX[k];
      km0 = kx > 4 ? 1 : 0; if (km0) kx = 8 - kx;
      kb0 = F.KP + (SY[k] * 5 + kx) * 2268;
    }
    if (pos.king[1] >= 0) {
      const k = pos.king[1];
      let kx = 8 - SX[k];
      km1 = kx > 4 ? 1 : 0; if (km1) kx = 8 - kx;
      kb1 = F.KP + ((8 - SY[k]) * 5 + kx) * 2268;
    }

    // パス2: 駒ごとの特徴
    let sc = 0, i0;
    const o = out;
    for (let s = 0; s < 81; s++) {
      const h = hgt[s];
      if (!h) continue;
      const top = stk[s * 3 + h - 1], tc = top >> 4;
      {
        // 一番上の駒について「帥から見た位置」の特徴（先手の帥: +1、後手の帥: −1）
        const tt = (top & 15) - 1;
        if (kb0 >= 0) { i0 = kb0 + (tc * 14 + tt) * 81 + (km0 ? SQ_MIR[s] : s); sc += w[i0]; if (o) { o.idx[o.n] = i0; o.val[o.n++] = 1; } }
        if (kb1 >= 0) { i0 = kb1 + ((tc ^ 1) * 14 + tt) * 81 + (km1 ? SQ_ROTMIR[s] : 80 - s); sc -= w[i0]; if (o) { o.idx[o.n] = i0; o.val[o.n++] = -(1); } }
      }
      for (let i = 0; i < h; i++) {
        const q = stk[s * 3 + i], qc = q >> 4, qt = q & 15, sg = qc ? -1 : 1;
        i0 = F.MAT + qt; sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; }
        if (i === h - 1) {
          if (h === 2) { i0 = F.T2 + qt; sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; } }
          else if (h === 3) { i0 = F.T3 + qt; sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; } }
          const x = SX[s], rr = qc ? SY[s] : 8 - SY[s];
          i0 = F.PST + qt * 45 + rr * 5 + (x < 4 ? x : 8 - x); sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; }
          if (qt !== SUI) {
            const ea = qc ? a0[s] : a1[s];
            if (ea) {
              const oa = qc ? a1[s] : a0[s];
              i0 = (oa ? F.ATT : F.HANG) + qt;
              sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; }
              // 自分より安い駒に狙われている／狙う数が守る数より多い
              if ((qc ? mv0[s] : mv1[s]) < VAL[qt]) { i0 = F.THREAT + qt; sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; } }
              if (ea > oa) { i0 = F.OVERLOAD + qt; sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; } }
            }
          }
        } else {
          i0 = (tc !== qc ? F.BUR_E : F.BUR_O) + qt; sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; }
        }
      }
    }
    // 手駒と可動域
    for (let t = 1; t < NT; t++) {
      const hn = pos.hand[t] - pos.hand[16 + t];
      if (hn) { i0 = F.HAND + t; sc += w[i0] * hn; if (o) { o.idx[o.n] = i0; o.val[o.n++] = hn; } }
      const mn = mob[t] - mob[16 + t];
      if (mn) { i0 = F.MOB + t; sc += w[i0] * mn; if (o) { o.idx[o.n] = i0; o.val[o.n++] = mn; } }
    }
    // 新を打てる範囲（前線）: 先手は [bFront, 8] 段、後手は [0, wFront] 段
    const main = pos.phase === MAIN;
    const bFront = main ? pos.dropRows(BLACK)[0] : 9, wFront = main ? pos.dropRows(WHITE)[1] : -1;
    // 帥の安全度
    for (let c = 0; c < 2; c++) {
      const k = pos.king[c];
      if (k < 0) continue;
      const sg = c ? -1 : 1, ea = c ? a0 : a1;
      const kh = hgt[k];
      if (kh === 2) { sc += w[F.K_T2] * sg; if (o) { o.idx[o.n] = F.K_T2; o.val[o.n++] = sg; } }
      else if (kh === 3) { sc += w[F.K_T3] * sg; if (o) { o.idx[o.n] = F.K_T3; o.val[o.n++] = sg; } }
      let ring = 0, guard = 0, esc = 0, near = 0;
      const nb = NEIGH[k];
      for (let j = 0; j < nb.length; j++) {
        const n = nb[j];
        if (ea[n]) ring++;
        const hn = hgt[n];
        if (hn) { if ((stk[n * 3 + hn - 1] >> 4) === c) guard++; } else if (!ea[n]) esc++;
      }
      const n2 = NEAR2[k];
      for (let j = 0; j < n2.length; j++) {
        const n = n2[j], hn = hgt[n];
        if (hn && (stk[n * 3 + hn - 1] >> 4) !== c) near++;
      }
      sc += sg * (w[F.K_RING] * ring + w[F.K_GUARD] * guard + w[F.K_ESC] * esc + w[F.K_NEAR] * near);
      if (o) { o.idx[o.n] = F.K_RING; o.val[o.n++] = sg * ring; o.idx[o.n] = F.K_GUARD; o.val[o.n++] = sg * guard; o.idx[o.n] = F.K_ESC; o.val[o.n++] = sg * esc; o.idx[o.n] = F.K_NEAR; o.val[o.n++] = sg * near; }
      if (ea[k]) { sc += w[F.CHECK] * sg; if (o) { o.idx[o.n] = F.CHECK; o.val[o.n++] = sg; } }
      // 帥の危険度: 周りのマスへの相手の利きの合計（王手は2倍）を段階に分ける（集まると急に危なくなるのを表せる）
      let units = ea[k] * 2;
      for (let j = 0; j < nb.length; j++) units += ea[nb[j]];
      i0 = F.K_DANGER + (units > 15 ? 15 : units); sc += w[i0] * sg; if (o) { o.idx[o.n] = i0; o.val[o.n++] = sg; }
      // 帥が相手の「新」の届く範囲にいる（相手の手駒が多いほど危ない）
      const ky = SY[k];
      if (main && (c === BLACK ? ky <= wFront : ky >= bFront)) {
        let hn = 0;
        for (let t = 2; t < NT; t++) hn += pos.hand[(c ^ 1) * 16 + t];
        if (hn > 12) hn = 12;
        sc += sg * (w[F.K_ZONE] + w[F.K_ZONE_HAND] * hn);
        if (o) { o.idx[o.n] = F.K_ZONE; o.val[o.n++] = sg; o.idx[o.n] = F.K_ZONE_HAND; o.val[o.n++] = sg * hn; }
      }
    }
    // 前線（新を打てる範囲）
    if (main) {
      const z = (9 - bFront) - (wFront + 1);
      sc += w[F.ZONE] * z; if (o) { o.idx[o.n] = F.ZONE; o.val[o.n++] = z; }
    }
    const tg = pos.stm ? -1 : 1;
    sc += w[F.TEMPO] * tg; if (o) { o.idx[o.n] = F.TEMPO; o.val[o.n++] = tg; }
    return sc;
  }

  // ------------------------------------------------------------------ ニューラルネット（NNUE 型）の評価
  // 入力: 手番側(us)と相手側(them)それぞれの視点から見た「駒の配置」と「手駒」の特徴（13720種類のうち百個以下が 1）
  //   盤上の駒: (自分/相手 2) × 駒14種 × 位置81（視点側が下になるよう回転）× 段3 × 一番上か2
  //   手駒    : (自分/相手 2) × 駒14種 × 「k枚以上持っている」(k=1..4)
  // 構造: 特徴 → 隠れ層H（us/them で重み共有）→ [us, them] を結合 → 32 → 32 → 1（勝率のロジット）
  // 評価値 = 線形の評価関数 + ネットの出力 × 600（ネットは線形評価の「補正」を学習する）
  const NN_BOARD = 2 * 14 * 81 * 6;
  const NN_NF = NN_BOARD + 2 * 14 * 4;
  const NN_MAXF = 112;
  function nnFeatures(pos, p, out) {
    let n = 0;
    const stk = pos.stk, hgt = pos.hgt;
    for (let s = 0; s < 81; s++) {
      const h = hgt[s];
      if (!h) continue;
      const so = p ? 80 - s : s;
      for (let i = 0; i < h; i++) {
        const q = stk[s * 3 + i], rel = (q >> 4) === p ? 0 : 1;
        out[n++] = (((rel * 14 + (q & 15) - 1) * 81 + so) * 3 + i) * 2 + (i === h - 1 ? 1 : 0);
      }
    }
    for (let c = 0; c < 2; c++) {
      const rel = c === p ? 0 : 1;
      for (let t = 1; t < NT; t++) {
        const k = Math.min(4, pos.hand[c * 16 + t]);
        for (let j = 0; j < k; j++) out[n++] = NN_BOARD + (rel * 14 + t - 1) * 4 + j;
      }
    }
    return n;
  }

  // 重み: { H, ft: Float32Array(NF*H), b1, w2: (32×2H), b2, w3: (32×32), b3, w4: (32), b4 }
  // 探索中は「手数(ply)ごとのアキュムレータ」を持ち、1手ごとに変わった特徴だけを足し引きする（NNUE の差分更新）
  const NN_PLIES = 80;
  class NNEval {
    constructor(net) {
      this.net = net;
      this.H = net.H;
      this.f = new Int32Array(NN_MAXF);
      this.accs = new Float32Array((NN_PLIES + 1) * 2 * net.H); // [ply][先手視点 / 後手視点][H]
      this.x = new Float32Array(2 * net.H);
      this.h2 = new Float32Array(32);
      this.h3 = new Float32Array(32);
    }
    // ply のアキュムレータを一から計算
    refresh(pos, ply) {
      const { ft, b1 } = this.net, H = this.H, acc = this.accs, f = this.f;
      for (let p = 0; p < 2; p++) {
        const base = (ply * 2 + p) * H;
        for (let j = 0; j < H; j++) acc[base + j] = b1[j];
        const n = nnFeatures(pos, p, f);
        for (let k = 0; k < n; k++) {
          const o = f[k] * H;
          for (let j = 0; j < H; j++) acc[base + j] += ft[o + j];
        }
      }
    }
    _piece(ply, sign, sq, i, top, q) {
      const ft = this.net.ft, H = this.H, acc = this.accs;
      for (let p = 0; p < 2; p++) {
        const rel = (q >> 4) === p ? 0 : 1, so = p ? 80 - sq : sq;
        const o = ((((rel * 14 + (q & 15) - 1) * 81 + so) * 3 + i) * 2 + top) * H, base = (ply * 2 + p) * H;
        if (sign > 0) for (let j = 0; j < H; j++) acc[base + j] += ft[o + j];
        else for (let j = 0; j < H; j++) acc[base + j] -= ft[o + j];
      }
    }
    _square(ply, sq, oh, o0, o1, o2, nh, stk) {
      const old = [o0, o1, o2];
      for (let i = 0, m = Math.max(oh, nh); i < m; i++) {
        const oq = i < oh ? old[i] : 0, otop = i === oh - 1 ? 1 : 0;
        const nq = i < nh ? stk[sq * 3 + i] : 0, ntop = i === nh - 1 ? 1 : 0;
        if (oq === nq && otop === ntop) continue;
        if (oq) this._piece(ply, -1, sq, i, otop, oq);
        if (nq) this._piece(ply, 1, sq, i, ntop, nq);
      }
    }
    // 直前の1手（pos の取り消し記録）から、ply-1 → ply のアキュムレータを作る
    update(pos, ply) {
      const H2 = 2 * this.H, acc = this.accs;
      acc.copyWithin(ply * H2, (ply - 1) * H2, ply * H2);
      const U = pos.u, u = (pos.nu - 1) * 36;
      const from = U[u + 10], to = U[u + 15];
      if (from >= 0) this._square(ply, from, U[u + 11], U[u + 12], U[u + 13], U[u + 14], pos.hgt[from], pos.stk);
      if (to >= 0) {
        this._square(ply, to, U[u + 16], U[u + 17], U[u + 18], U[u + 19], pos.hgt[to], pos.stk);
        // 指した側の手駒の変化（新・寝返りで減る）
        const c = U[u + 5], ft = this.net.ft, H = this.H;
        for (let t = 1; t < NT; t++) {
          const o = Math.min(4, U[u + 19 + t]), n = Math.min(4, pos.hand[c * 16 + t]);
          for (let j = n; j < o; j++) {
            for (let p = 0; p < 2; p++) {
              const rel = c === p ? 0 : 1, row = (NN_BOARD + (rel * 14 + t - 1) * 4 + j) * H, base = (ply * 2 + p) * H;
              for (let k = 0; k < H; k++) acc[base + k] -= ft[row + k];
            }
          }
        }
      }
    }
    // ply のアキュムレータから、手番側の勝率ロジットを計算
    evalAt(pos, ply) {
      const H = this.H, acc = this.accs, x = this.x;
      const us = (ply * 2 + pos.stm) * H, them = (ply * 2 + (pos.stm ^ 1)) * H;
      for (let j = 0; j < H; j++) {
        const a = acc[us + j], b = acc[them + j];
        x[j] = a < 0 ? 0 : a > 1 ? 1 : a;
        x[H + j] = b < 0 ? 0 : b > 1 ? 1 : b;
      }
      return this._layers();
    }
    // 探索の外から呼ぶとき（一から計算）
    logit(pos) {
      this.refresh(pos, NN_PLIES);
      return this.evalAt(pos, NN_PLIES);
    }
    _layers() {
      const { w2, b2, w3, b3, w4, b4 } = this.net, H2 = 2 * this.H, acc = this.x, h2 = this.h2, h3 = this.h3;
      for (let i = 0; i < 32; i++) {
        let s = b2[i];
        const o = i * H2;
        for (let j = 0; j < H2; j++) s += w2[o + j] * acc[j];
        h2[i] = s < 0 ? 0 : s > 1 ? 1 : s;
      }
      for (let i = 0; i < 32; i++) {
        let s = b3[i];
        const o = i * 32;
        for (let j = 0; j < 32; j++) s += w3[o + j] * h2[j];
        h3[i] = s < 0 ? 0 : s > 1 ? 1 : s;
      }
      let out = b4;
      for (let j = 0; j < 32; j++) out += w4[j] * h3[j];
      return out;
    }
  }

  // 保存形式（base64 の float32 / int8 量子化）→ 実行用の重み
  function decodeNet(obj) {
    const b64 = s => {
      if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
      return new Uint8Array(Buffer.from(s, 'base64'));
    };
    const f32 = s => { const u = b64(s); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4).slice(); };
    const i8 = (s, scale) => { const u = b64(s); const r = new Float32Array(u.length); for (let i = 0; i < u.length; i++) r[i] = ((u[i] << 24) >> 24) * scale; return r; };
    return {
      H: obj.H,
      ft: obj.ftScale ? i8(obj.ft, obj.ftScale) : f32(obj.ft),
      b1: f32(obj.b1), w2: f32(obj.w2), b2: f32(obj.b2), w3: f32(obj.w3), b3: f32(obj.b3), w4: f32(obj.w4), b4: obj.b4,
      meta: obj.meta || {},
    };
  }

  // ------------------------------------------------------------------ 探索
  const MATE = 100000, INF = 1000000, MAXPLY = 64, PVW = MAXPLY + 8;
  const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
  const QMAX = 8;
  const LMP = [0, 8, 16, 30]; // 深さ1〜3で読む静かな手の上限
  const S_TT = 1 << 30, S_CAP = 1 << 26, S_BET = (1 << 26) - (1 << 20), S_K1 = 1 << 25, S_K2 = (1 << 25) - 1;
  const isMate = s => Math.abs(s) >= MATE - 1000;

  // 置換表のメモリ（共有するときは SharedArrayBuffer で作る）
  function makeTT(bits, shared) {
    const size = 1 << bits;
    return { size, buf: shared ? new SharedArrayBuffer(size * 16) : new ArrayBuffer(size * 16) };
  }

  class Searcher {
    constructor(weights, opts = {}) {
      this.setWeights(weights || defaultWeights());
      // 置換表: 検証用キー・手・点数・(深さ|種別<<8) の4つ。opts.sharedTT（SharedArrayBuffer）を渡すと複数スレッドで共有する。
      // 共有中に別スレッドが書きかけの項目を読んでも、キー = 局面 ^ 手 ^ 点数 ^ 深さ種別 の検算で弾く（ロックなし）
      const tt = opts.sharedTT || makeTT(opts.ttBits || 20);
      this.ttMask = tt.size - 1;
      this.ttKey = new Int32Array(tt.buf, 0, tt.size);
      this.ttMove = new Int32Array(tt.buf, tt.size * 4, tt.size);
      this.ttScore = new Int32Array(tt.buf, tt.size * 8, tt.size);
      this.ttDF = new Int32Array(tt.buf, tt.size * 12, tt.size);
      this.stopFlag = opts.stopFlag ? new Int32Array(opts.stopFlag) : null; // 共有の停止フラグ（Lazy SMP 用。値が今の仕事の番号でなくなったら止まる）
      this.helper = opts.helper || 0;
      this.mbuf = []; this.sbuf = [];
      for (let i = 0; i < PVW; i++) { this.mbuf.push(new Int32Array(4096)); this.sbuf.push(new Int32Array(4096)); }
      this.killer = new Int32Array(PVW * 2);
      this.hist = new Int32Array(2 * 96 * 81);
      this.pvt = new Int32Array(PVW * PVW);
      this.pvl = new Int32Array(PVW);
      this.ws = makeWorkspace();
      this.noise = 0; this.salt = 0;
      this.nodes = 0; this.stop = false;
      // 枝刈り（v2）。prune: false で旧来の探索
      this.prune = opts.prune !== false;
      this.nn = opts.net ? new NNEval(opts.net) : null; // ニューラルネットの補正（なければ線形の評価だけ）
      this.qTsuke = !!opts.qTsuke; // 静止探索の浅いところで「相手駒へのツケ」も読む
      this.lmp = opts.lmp || LMP;         // 深さ1〜3で読む静かな手の上限
      this.rfpMargin = opts.rfpMargin || 110;
      this.futMargin = opts.futMargin || 160;
      // 以下も SPSA（train/spsa.js）で調整する数値
      this.nullBase = opts.nullBase ?? 2;   // Null Move の削る深さ = nullBase + 深さ/nullDiv
      this.nullDiv = opts.nullDiv || 7;
      this.aspDelta = Math.round(opts.aspDelta || 60); // アスピレーション・ウィンドウの幅
      this.dropPen = Math.round(opts.dropPen ?? 64);   // 手の並べ順で「打つ手」を後回しにする量
      const lmrBase = opts.lmrBase ?? 0.5, lmrDiv = opts.lmrDiv || 2.1;
      this.lmrTable = new Uint8Array(64 * 256);
      for (let d = 1; d < 64; d++) for (let m = 1; m < 256; m++) this.lmrTable[d * 256 + m] = Math.max(0, Math.floor(lmrBase + Math.log(d) * Math.log(m) / lmrDiv));
    }

    setWeights(weights) {
      weights = upgradeWeights(weights);
      this.weights = weights;
      this.w = Float64Array.from(weights.w);
    }

    clearTT() { this.ttKey.fill(0); this.ttMove.fill(0); this.ttScore.fill(0); this.ttDF.fill(0); }

    // 手番側から見た静的評価値
    evalStm(pos, ply) {
      let v = evaluate(pos, this.w, null, this.ws);
      if (pos.stm) v = -v;
      if (this.nn) v += (ply === undefined ? this.nn.logit(pos) : this.nn.evalAt(pos, ply)) * SCALE;
      if (this.noise) v += ((Math.imul(pos.hlo ^ this.salt, 0x9E3779B1) >>> 8) % (2 * this.noise + 1)) - this.noise;
      return Math.round(v);
    }

    checkStop() {
      if (this.nodes >= this.maxNodes || Date.now() >= this.deadline || (this.stopFlag && Atomics.load(this.stopFlag, 0) !== this.jobId)) this.stop = true;
    }

    // 思考: { move, score(手番側), depth, pv, nodes, time }
    think(pos, opts = {}) {
      const timeMs = opts.timeMs || 0, maxDepth = Math.min(opts.maxDepth || 40, MAXPLY - 8);
      this.pos = pos; this.nodes = 0; this.stop = false;
      this.t0 = Date.now();
      this.deadline = timeMs > 0 ? this.t0 + timeMs : Infinity;
      this.maxNodes = opts.maxNodes || Infinity;
      this.jobId = opts.jobId || 0; // 共有の停止フラグの値がこれと違ったら止まる
      for (let i = 0; i < this.hist.length; i++) this.hist[i] >>= 2;
      this.killer.fill(0);

      const legal = pos.legalMoves();
      if (!legal.length) return { move: 0, score: -MATE, depth: 0, pv: [], nodes: 0, time: 0 };
      if (this.nn) this.nn.refresh(pos, 0);
      let best = { move: legal[0], score: this.evalStm(pos), depth: 0, pv: [legal[0]], nodes: 0, time: 0 };
      if (legal.length === 1 && !opts.analyze) { best.score = this.quickScore(pos, legal[0]); return best; }

      let prev = 0;
      // Lazy SMP の補助スレッドは、奇数番が1手深い所から読み始める（主スレッドと読みがずれて置換表を補い合う）
      for (let d = 1 + (this.helper & 1); d <= maxDepth; d++) {
        this.rootDepth = d;
        this.rootBestMove = 0;
        let sc;
        // アスピレーション・ウィンドウ
        if (d >= 4 && !isMate(prev)) {
          let delta = this.aspDelta, a = prev - delta, b = prev + delta;
          for (;;) {
            sc = this.search(d, a, b, 0, true);
            if (this.stop) break;
            if (sc <= a) { a = Math.max(-INF, a - delta * 3); delta *= 3; }
            else if (sc >= b) { b = Math.min(INF, b + delta * 3); delta *= 3; }
            else break;
            if (delta > 3000) { a = -INF; b = INF; }
          }
        } else sc = this.search(d, -INF, INF, 0, true);

        if (this.stop) {
          // 途中で止まった: この反復で完全に読み切った手が前回より良ければ採用
          if (this.rootBestMove && this.rootBestMove !== best.move && this.rootBestScore > best.score) {
            best = { move: this.rootBestMove, score: this.rootBestScore, depth: d - 1, pv: [this.rootBestMove], nodes: this.nodes, time: Date.now() - this.t0 };
          }
          break;
        }
        prev = sc;
        const pv = Array.from(this.pvt.subarray(0, this.pvl[0]));
        best = { move: pv[0] || this.rootBestMove || best.move, score: sc, depth: d, pv: pv.length ? pv : [best.move], nodes: this.nodes, time: Date.now() - this.t0 };
        if (opts.onInfo) opts.onInfo(best);
        if (isMate(sc) && !opts.analyze && !this.helper && d >= 3) break;
        if (timeMs > 0 && !opts.analyze && !this.helper && Date.now() - this.t0 > timeMs * 0.5) break;
        if (this.nodes >= this.maxNodes) break;
      }
      best.nodes = this.nodes; best.time = Date.now() - this.t0;
      return best;
    }

    quickScore(pos, m) {
      pos.make(m);
      const s = -this.evalStm(pos);
      pos.unmake();
      return s;
    }

    scoreMoves(pos, moves, scores, n, ttMove, ply) {
      const stk = pos.stk, hgt = pos.hgt, c = pos.stm;
      const k1 = this.killer[ply * 2], k2 = this.killer[ply * 2 + 1];
      const hb = c * 96 * 81;
      for (let i = 0; i < n; i++) {
        const m = moves[i];
        if (m === ttMove) { scores[i] = S_TT; continue; }
        const to = m & 127, from = (m >> 7) & 127, act = (m >> 18) & 3;
        if (act === ACT_CAP || (m & BETRAY)) {
          let v = 0;
          const ht = hgt[to];
          for (let j = 0; j < ht; j++) { const q = stk[to * 3 + j]; if ((q >> 4) !== c) v += (q & 15) === SUI ? 20000 : VAL[q & 15]; }
          const att = from === DROP ? VAL[BOU] : VAL[stk[from * 3 + hgt[from] - 1] & 15];
          scores[i] = (act === ACT_CAP ? S_CAP : S_BET) + v * 16 - (att >> 2);
          continue;
        }
        if (m === k1) { scores[i] = S_K1; continue; }
        if (m === k2) { scores[i] = S_K2; continue; }
        const hi = hb + (from === DROP ? 81 + ((m >> 14) & 15) : from) * 81 + to;
        scores[i] = this.hist[hi] - (from === DROP ? this.dropPen : 0);
      }
    }

    search(depth, alpha, beta, ply, canNull) {
      const pos = this.pos;
      this.pvl[ply] = ply;
      if ((++this.nodes & 1023) === 0) this.checkStop();
      if (this.stop) return 0;
      const c = pos.stm;
      if (pos.king[c] < 0) return -MATE + ply; // 帥を取られている
      if (ply > 0) {
        if (pos.isRepetition()) return 0;
        const ma = -MATE + ply, mb = MATE - ply - 1;
        if (alpha < ma) alpha = ma;
        if (beta > mb) beta = mb;
        if (alpha >= beta) return alpha;
      }
      if (ply >= MAXPLY - 1) return this.evalStm(pos, ply);
      const inCheck = pos.inCheck(c);
      if (inCheck && ply < this.rootDepth * 2) depth++;
      if (depth <= 0) return this.qsearch(alpha, beta, ply, 0);

      // 置換表
      const ti = pos.hlo & this.ttMask;
      let ttMove = 0;
      const tMove = this.ttMove[ti], tScore = this.ttScore[ti], tDF = this.ttDF[ti];
      const ttHit = (this.ttKey[ti] ^ tMove ^ tScore ^ tDF) === pos.hhi;
      if (ttHit) {
        ttMove = tMove;
        if (ply > 0 && (tDF & 255) >= depth) {
          let s = tScore;
          if (s >= MATE - 1000) s -= ply; else if (s <= -MATE + 1000) s += ply;
          const f = tDF >> 8;
          if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
        }
      }
      const pvNode = beta - alpha > 1;

      // 浅い深さでの枝刈り（静的評価が大きく上回るならそのまま返す）
      const pr = this.prune && !inCheck && !pvNode && ply > 0;
      let staticEval = 0;
      if (pr && depth <= 3 && !isMate(beta) && !isMate(alpha)) {
        staticEval = this.evalStm(pos, ply);
        if (staticEval - this.rfpMargin * depth >= beta) return staticEval;
      }

      // Null Move Pruning
      if (canNull && !inCheck && !pvNode && depth >= 3 && ply > 0 && !isMate(beta)) {
        const se = this.evalStm(pos, ply);
        if (se >= beta) {
          const R = Math.max(1, Math.floor(this.nullBase + depth / this.nullDiv)); // 既定値では 深さ7未満 2、7以上 3
          pos.makeNull();
          if (this.nn) this.nn.update(pos, ply + 1);
          const s = -this.search(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
          pos.unmake();
          if (this.stop) return 0;
          if (s >= beta) return s;
        }
      }

      const moves = this.mbuf[ply], scores = this.sbuf[ply];
      const n = pos.genMoves(moves, false);
      this.scoreMoves(pos, moves, scores, n, ttMove, ply);
      let best = -INF, bestMove = 0, legal = 0, quietTried = 0;
      const a0 = alpha;
      const lmpLimit = pr && depth <= 3 ? this.lmp[depth] : 1 << 30;
      const futile = pr && depth <= 2 && !isMate(alpha) && staticEval + this.futMargin * depth <= alpha;
      for (let i = 0; i < n; i++) {
        let bi = i;
        for (let j = i + 1; j < n; j++) if (scores[j] > scores[bi]) bi = j;
        const m = moves[bi], ms = scores[bi];
        moves[bi] = moves[i]; moves[i] = m; scores[bi] = scores[i]; scores[i] = ms;

        pos.make(m);
        if (pos.inCheck(c)) { pos.unmake(); continue; }
        legal++;
        const quiet = ms < S_K2 && ms !== S_TT;
        if (quiet) {
          quietTried++;
          // 後半の静かな手・見込みのない静かな手は読まない（帥手になる手は除く）
          if (legal > 1 && (quietTried > lmpLimit || futile) && !pos.inCheck(c ^ 1)) { pos.unmake(); continue; }
        }
        if (this.nn) this.nn.update(pos, ply + 1);
        let s;
        if (legal === 1) s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
        else {
          let R = 0;
          if (depth >= 3 && quiet && !inCheck && legal > 3) {
            if (this.prune) R = this.lmrTable[Math.min(depth, 63) * 256 + Math.min(legal, 255)] - (pvNode ? 1 : 0);
            else R = 1 + (legal > 10 ? 1 : 0) + (legal > 30 && depth >= 6 ? 1 : 0);
            if (R > depth - 2) R = depth - 2;
            if (R < 0) R = 0;
          }
          s = -this.search(depth - 1 - R, -alpha - 1, -alpha, ply + 1, true);
          if (s > alpha && R > 0) s = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
          if (s > alpha && s < beta) s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
        }
        pos.unmake();
        if (this.stop) return 0;
        if (s > best) {
          best = s; bestMove = m;
          if (s > alpha) {
            alpha = s;
            const row = ply * PVW, nrow = (ply + 1) * PVW;
            this.pvt[row + ply] = m;
            for (let k = ply + 1; k < this.pvl[ply + 1]; k++) this.pvt[row + k] = this.pvt[nrow + k];
            this.pvl[ply] = Math.max(ply + 1, this.pvl[ply + 1]);
            if (ply === 0) { this.rootBestMove = m; this.rootBestScore = s; }
            if (s >= beta) {
              if (ms < S_K2) {
                if (this.killer[ply * 2] !== m) { this.killer[ply * 2 + 1] = this.killer[ply * 2]; this.killer[ply * 2] = m; }
                const from = (m >> 7) & 127;
                const hi = c * 96 * 81 + (from === DROP ? 81 + ((m >> 14) & 15) : from) * 81 + (m & 127);
                this.hist[hi] += depth * depth;
                if (this.hist[hi] > 1000000) for (let k = 0; k < this.hist.length; k++) this.hist[k] >>= 1;
              }
              break;
            }
          }
        }
      }
      if (legal === 0) return -MATE + ply; // 詰み（どう指しても帥を取られる）

      const flag = best >= beta ? TT_LOWER : best > a0 ? TT_EXACT : TT_UPPER;
      if (!ttHit || depth >= (tDF & 255) || flag === TT_EXACT) {
        let s = best;
        if (s >= MATE - 1000) s += ply; else if (s <= -MATE + 1000) s -= ply;
        const df = (depth & 255) | (flag << 8);
        this.ttMove[ti] = bestMove; this.ttScore[ti] = s; this.ttDF[ti] = df;
        this.ttKey[ti] = pos.hhi ^ bestMove ^ s ^ df;
      }
      return best;
    }

    qsearch(alpha, beta, ply, qd) {
      const pos = this.pos;
      this.pvl[ply] = ply;
      if ((++this.nodes & 1023) === 0) this.checkStop();
      if (this.stop) return 0;
      const c = pos.stm;
      if (pos.king[c] < 0) return -MATE + ply;
      const inCheck = pos.inCheck(c);
      let best = -INF;
      if (!inCheck) {
        const se = this.evalStm(pos, ply);
        if (se >= beta || qd >= QMAX || ply >= MAXPLY - 1) return se;
        if (se > alpha) alpha = se;
        best = se;
      } else if (qd >= QMAX || ply >= MAXPLY - 1) return this.evalStm(pos, ply);

      const moves = this.mbuf[ply], scores = this.sbuf[ply];
      const n = pos.genMoves(moves, inCheck ? false : (this.qTsuke && qd < 2 ? 2 : true));
      this.scoreMoves(pos, moves, scores, n, 0, ply);
      let legal = 0;
      for (let i = 0; i < n; i++) {
        let bi = i;
        for (let j = i + 1; j < n; j++) if (scores[j] > scores[bi]) bi = j;
        const m = moves[bi], ms = scores[bi];
        moves[bi] = moves[i]; moves[i] = m; scores[bi] = scores[i]; scores[i] = ms;
        pos.make(m);
        if (pos.inCheck(c)) { pos.unmake(); continue; }
        legal++;
        if (this.nn) this.nn.update(pos, ply + 1);
        const s = -this.qsearch(-beta, -alpha, ply + 1, qd + 1);
        pos.unmake();
        if (this.stop) return 0;
        if (s > best) {
          best = s;
          if (s > alpha) {
            alpha = s;
            const row = ply * PVW, nrow = (ply + 1) * PVW;
            this.pvt[row + ply] = m;
            for (let k = ply + 1; k < this.pvl[ply + 1]; k++) this.pvt[row + k] = this.pvt[nrow + k];
            this.pvl[ply] = Math.max(ply + 1, this.pvl[ply + 1]);
            if (s >= beta) break;
          }
        }
      }
      if (inCheck && legal === 0) return -MATE + ply;
      return best;
    }
  }

  // ------------------------------------------------------------------ 配置（中級・上級の自由配置）
  // 先手視点の相対座標 [駒, x(0=左端), r(0=最後列)]。並び順に置いていき、最後に「済」。
  const TEMPLATES = [
    { name: '本陣', cells: [
      [SUI, 4, 0], [TOR, 3, 0], [TOR, 5, 0], [SAM, 1, 0], [SAM, 7, 0],
      [CHU, 2, 1], [SIN, 3, 1], [SHO, 4, 1], [SIN, 5, 1], [TAI, 6, 1], [YUM, 1, 1], [YUM, 7, 1],
      [HYO, 0, 2], [YAR, 1, 2], [KIB, 2, 2], [HYO, 3, 2], [YAR, 4, 2], [HYO, 5, 2], [KIB, 6, 2], [YAR, 7, 2], [HYO, 8, 2]] },
    { name: '砲台', cells: [
      [SUI, 4, 0], [SHO, 3, 0], [SHO, 5, 0], [HOO, 2, 0], [TSU, 6, 0], [YUM, 1, 1], [YUM, 7, 1],
      [TAI, 6, 1], [CHU, 2, 1], [HYO, 0, 2], [HYO, 2, 2], [HYO, 4, 2], [HYO, 6, 2], [HYO, 8, 2], [YAR, 3, 2], [YAR, 5, 2]] },
    { name: '少数精鋭', cells: [
      [SUI, 4, 0], [TOR, 4, 1], [SHO, 3, 0], [SHO, 5, 0], [HYO, 3, 2], [HYO, 5, 2], [TAI, 6, 1], [CHU, 2, 1]] },
    { name: '二段陣', cells: [
      [SUI, 4, 0], [TOR, 3, 0], [TOR, 5, 0], [HYO, 2, 2], [HYO, 4, 2], [HYO, 6, 2], [YAR, 2, 2], [YAR, 6, 2], [SAM, 4, 2],
      [TAI, 7, 1], [CHU, 1, 1], [SHO, 3, 1], [SHO, 5, 1], [KIB, 0, 2], [KIB, 8, 2], [SIN, 2, 1], [SIN, 6, 1]] },
    { name: '片翼', cells: [
      [SUI, 6, 0], [TOR, 5, 0], [TOR, 7, 0], [SHO, 6, 1], [SAM, 5, 1], [SAM, 7, 1], [TAI, 1, 1],
      [YAR, 0, 2], [YAR, 1, 2], [YAR, 2, 2], [KIB, 3, 2], [HYO, 4, 2], [HYO, 5, 2], [HYO, 6, 2], [HYO, 7, 2],
      [SIN, 2, 1], [CHU, 3, 1], [YUM, 8, 1]] },
    { name: '全軍', cells: [
      [SUI, 4, 0], [TOR, 3, 0], [TOR, 5, 0], [SAM, 1, 0], [SAM, 7, 0], [TSU, 0, 0], [HOO, 8, 0], [SHO, 2, 0], [SHO, 6, 0],
      [CHU, 2, 1], [SIN, 3, 1], [BOU, 4, 1], [SIN, 5, 1], [TAI, 6, 1], [YUM, 1, 1], [YUM, 7, 1],
      [HYO, 0, 2], [YAR, 1, 2], [KIB, 2, 2], [HYO, 3, 2], [YAR, 4, 2], [HYO, 5, 2], [KIB, 6, 2], [YAR, 7, 2], [HYO, 8, 2]] },
  ];

  // テンプレートの i 番目の駒を置く手（置けない場合は 0）
  function templateMove(pos, tpl, i) {
    const [t, x, r] = tpl.cells[i];
    const c = pos.stm, sq = G.relSq(c, x, r);
    if (!pos.hand[c * 16 + t]) return 0;
    const h = pos.hgt[sq];
    if (h >= pos.maxTier) return 0;
    if (h) {
      const top = pos.stk[sq * 3 + h - 1];
      if ((top >> 4) !== c || (top & 15) === SUI) return 0;
      return sq | (DROP << 7) | (t << 14) | (G.ACT_TSUKE << 18);
    }
    return sq | (DROP << 7) | (t << 14);
  }

  // 配置フェーズの次の一手（盤上の自駒の数 = テンプレートの何番目まで置いたか）
  function setupMove(pos, tpl) {
    const c = pos.stm;
    let placed = 0;
    for (let s = 0; s < 81; s++) for (let i = 0; i < pos.hgt[s]; i++) if ((pos.stk[s * 3 + i] >> 4) === c) placed++;
    const legal = pos.legalMoves();
    for (let i = placed; i < tpl.cells.length; i++) {
      const m = templateMove(pos, tpl, i);
      if (m && legal.includes(m)) return m;
    }
    return legal.includes(DONE) ? DONE : legal[0];
  }

  // ------------------------------------------------------------------ エージェント
  class Agent {
    constructor(weights, opts = {}) {
      this.searcher = new Searcher(weights, opts);
      this.template = null;
      this.rand = opts.rand || Math.random;
    }
    // 学習済みの配置成績から選ぶ（explore=true なら一様ランダム）
    pickTemplate(levelKey, explore) {
      // 自由配置の学習で見つけた型（setupBook）があれば、その中から勝率の高いものを選ぶ
      const book = (this.searcher.weights.setupBook || {})[levelKey];
      if (book && book.length) {
        // 学習用（explore）は、学習した型と最初の6つの型を混ぜて局面を多様にする
        if (explore) return this.rand() < 0.6 ? book[Math.floor(this.rand() * book.length)] : TEMPLATES[Math.floor(this.rand() * TEMPLATES.length)];
        let bb = book[0], bv = -1;
        for (const tp of book) {
          const v = (tp.w + 1) / (tp.n + 2) + this.rand() * 0.01;
          if (v > bv) { bv = v; bb = tp; }
        }
        return bb;
      }
      const stats = (this.searcher.weights.setupStats || {})[levelKey];
      if (explore || !stats) return TEMPLATES[Math.floor(this.rand() * TEMPLATES.length)];
      // 勝率の高いものから、少しだけばらつきを持たせて選ぶ
      let best = 0, bv = -1;
      TEMPLATES.forEach((tp, i) => {
        const st = stats[tp.name] || { w: 0, n: 0 };
        const v = (st.w + 1) / (st.n + 2) + this.rand() * 0.02;
        if (v > bv) { bv = v; best = i; }
      });
      return TEMPLATES[best];
    }
    chooseSetup(pos, explore) {
      if (!this.template) this.template = this.pickTemplate(pos.levelKey, explore);
      return setupMove(pos, this.template);
    }
    think(pos, opts) { return this.searcher.think(pos, opts); }
  }

  // 評価値 → 勝率
  const winRate = score => 1 / (1 + Math.exp(-score / SCALE));

  Object.assign(G, {
    F, NFEAT, NFEAT_V1, NFEAT_V2, KP_SIZE, FEATURE_VERSION, SCALE, VAL, MATE, INF, isMate,
    NN_NF, NN_MAXF, nnFeatures, NNEval, decodeNet,
    defaultWeights, upgradeWeights, evaluate, makeWorkspace, makeSink, Searcher, makeTT, Agent, TEMPLATES, setupMove, winRate,
  });
  return G;
}
if (typeof module !== 'undefined' && module.exports) module.exports = GungiAI;
