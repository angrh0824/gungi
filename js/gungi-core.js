/*
 * 軍儀 (GUNGI) ルールエンジン — 盤面・合法手生成・指し手の実行/取り消し
 *
 * ルールの出典
 *  - 公式Q&A（ユニバーサル ミュージック「HUNTER×HUNTER 軍儀 Q＆A」）: ツケ・取り・新・帥・謀(寝返り)の扱い
 *  - 駒の動き: 軍儀Web (kyproduce.com/gungi/rules/pieces/) の駒データ。
 *    源川さとし氏 note「軍儀・ルール解説①〜⑤」(帥/兵/大/中/小/砦/侍/槍/忍/馬) と照合済み。
 *  - 入門・初級の固定配置は公式のものが見つからなかったため、本アプリ独自の配置。
 *
 * 盤面座標: sq = y*9 + x。x=0 が先手から見て左端（９筋）、y=0 が上端（一段目＝後手の陣）。
 * 先手(BLACK=0) は y が小さくなる方向が「前」、後手(WHITE=1) は逆。
 *
 * ブラウザ / Web Worker / Node.js 共通。GungiCore(G) を呼ぶと G に API が入る。
 * Web Worker には GungiCore.toString() をそのまま埋め込むので、この関数の外側を参照しないこと。
 */
function GungiCore(G) {
  'use strict';

  // ------------------------------------------------------------------ 駒
  const SUI = 1, TAI = 2, CHU = 3, SHO = 4, SAM = 5, YAR = 6, KIB = 7, SIN = 8, TOR = 9, HYO = 10,
    YUM = 11, TSU = 12, HOO = 13, BOU = 14;
  const NT = 15;
  const BLACK = 0, WHITE = 1;
  const KANJI = ['', '帥', '大', '中', '小', '侍', '槍', '馬', '忍', '砦', '兵', '弓', '筒', '砲', '謀'];
  const NAMES = ['', '帥（スイ）', '大将（タイショウ）', '中将（チュウジョウ）', '小将（ショウショウ）', '侍（サムライ）',
    '槍（ヤリ）', '騎馬（キバ）', '忍（シノビ）', '砦（トリデ）', '兵（ヒョウ）', '弓（ユミ）', '筒（ツツ）',
    '砲（オオヅツ）', '謀（ボウショウ）'];
  const LETTERS = '.KTCSMYBNFPAUHO';
  const PIECE_COUNT = [0, 1, 1, 1, 2, 2, 3, 2, 2, 2, 4, 2, 1, 1, 1]; // 計25枚

  // ------------------------------------------------------------------ 駒の動き
  // dx: 右が正 / dy: 前が負（先手視点）。d = 最大距離（途中に駒があれば止まる）。
  // jump = 飛び越え移動（弓・筒・砲）。自分の段より高い駒は飛び越えられない。
  // 2段目・3段目にツケると、基本的に各方向の距離が1マスずつ伸びる。
  const ORTH = [[0, -1], [0, 1], [1, 0], [-1, 0]];
  const DIAG = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
  const ALL8 = ORTH.concat(DIAG);
  const step = (dirs, d) => dirs.map(([dx, dy]) => ({ dx, dy, d }));
  const jump = (dx, dy) => ({ dx, dy, jump: true });

  function moveSpec(t, k) {
    switch (t) {
      case SUI: return step(ALL8, k);
      case TAI: return step(ORTH, 8).concat(step(DIAG, k));
      case CHU: return step(DIAG, 8).concat(step(ORTH, k));
      case SHO: return step([[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1]], k);
      case SAM: return step([[0, -1], [1, -1], [-1, -1], [0, 1]], k);
      case YAR: return step([[0, -1]], k + 1).concat(step([[1, -1], [-1, -1], [0, 1]], k));
      case KIB: return step([[0, -1], [0, 1]], k + 1).concat(step([[1, 0], [-1, 0]], k));
      case SIN: return step(DIAG, k + 1);
      case TOR: return step([[0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1]], k);
      case HYO: return step([[0, -1], [0, 1]], k);
      case YUM: {
        const r = [];
        for (let j = 1; j <= k; j++) r.push(jump(0, -(j + 1)), jump(j, -(j + 1)), jump(-j, -(j + 1)));
        return r.concat(step([[0, 1]], k));
      }
      case TSU: {
        const r = [];
        for (let j = 1; j <= k; j++) r.push(jump(0, -(j + 1)));
        return r.concat(step([[1, 1], [-1, 1]], k));
      }
      case HOO: {
        const r = [];
        for (let j = 1; j <= k; j++) r.push(jump(0, -(j + 2)));
        return r.concat(step([[1, 0], [-1, 0], [0, 1]], k));
      }
      case BOU: return step([[1, -1], [-1, -1], [0, 1]], k);
    }
    return [];
  }

  // ------------------------------------------------------------------ レベル（ルールセット）
  const BASIC_TYPES = [SUI, TAI, CHU, SHO, SAM, YAR, KIB, SIN, TOR, HYO];
  const ALL_TYPES = BASIC_TYPES.concat([YUM, TSU, HOO, BOU]);
  // 固定配置（先手視点）: [駒, x(0=左端), r(0=最後列,2=最前列)]
  const FIXED_NYUMON = [
    [SUI, 4, 0], [TOR, 3, 0], [TOR, 5, 0], [SAM, 1, 0], [SAM, 7, 0],
    [CHU, 2, 1], [SIN, 3, 1], [SHO, 4, 1], [SIN, 5, 1], [TAI, 6, 1],
    [HYO, 0, 2], [YAR, 1, 2], [KIB, 2, 2], [HYO, 3, 2], [YAR, 4, 2], [HYO, 5, 2], [KIB, 6, 2], [YAR, 7, 2], [HYO, 8, 2],
  ];
  const FIXED_SHOKYU = FIXED_NYUMON.concat([[YUM, 1, 1], [YUM, 7, 1]]);
  // 中級・上級を固定配置で遊ぶとき用（特殊駒入り。小1・謀1は手駒）
  const FIXED_FULL = [
    [SUI, 4, 0], [TOR, 3, 0], [TOR, 5, 0], [SAM, 1, 0], [SAM, 7, 0], [TSU, 0, 0], [HOO, 8, 0],
    [YUM, 1, 1], [CHU, 2, 1], [SIN, 3, 1], [SHO, 4, 1], [SIN, 5, 1], [TAI, 6, 1], [YUM, 7, 1],
    [HYO, 0, 2], [YAR, 1, 2], [KIB, 2, 2], [HYO, 3, 2], [YAR, 4, 2], [HYO, 5, 2], [KIB, 6, 2], [YAR, 7, 2], [HYO, 8, 2],
  ];
  // fixed = 公式の既定（入門・初級は固定配置、中級・上級は自由配置）。setup = 固定配置で遊ぶときの並び
  const LEVELS = {
    nyumon: { key: 'nyumon', name: '入門', maxTier: 2, kingTsuke: false, fixed: true, setup: FIXED_NYUMON, types: BASIC_TYPES },
    shokyu: { key: 'shokyu', name: '初級', maxTier: 2, kingTsuke: false, fixed: true, setup: FIXED_SHOKYU, types: BASIC_TYPES.concat([YUM]) },
    chukyu: { key: 'chukyu', name: '中級', maxTier: 2, kingTsuke: true, fixed: false, setup: FIXED_FULL, types: ALL_TYPES },
    jokyu: { key: 'jokyu', name: '上級', maxTier: 3, kingTsuke: true, fixed: false, setup: FIXED_FULL, types: ALL_TYPES },
  };
  const LEVEL_KEYS = ['nyumon', 'shokyu', 'chukyu', 'jokyu'];

  // 手番側から見た相対座標 → 盤面のマス
  function relSq(c, x, r) { return c === BLACK ? (8 - r) * 9 + x : r * 9 + (8 - x); }

  // ------------------------------------------------------------------ 利きテーブルの前計算
  // RAY[RSTART[idx] .. REND[idx]) に (色, 駒, 段, マス) ごとの移動レイを並べる。
  //   スライド: [0, n, s1..sn]（手前から順。途中に駒があれば止まる）
  //   飛び越え: [1, 着地マス, 中間マス数, 中間マス...]
  const NIDX = 2 * NT * 4 * 81;
  const RSTART = new Int32Array(NIDX), REND = new Int32Array(NIDX), REACH = new Int32Array(NIDX * 3);
  const rayList = [];
  const rIdx = (c, t, k, sq) => ((c * NT + t) * 4 + k) * 81 + sq;
  for (let c = 0; c < 2; c++) {
    for (let t = 1; t < NT; t++) {
      for (let k = 1; k <= 3; k++) {
        const spec = moveSpec(t, k);
        for (let sq = 0; sq < 81; sq++) {
          const x = sq % 9, y = (sq / 9) | 0, idx = rIdx(c, t, k, sq);
          const reach = s => { REACH[idx * 3 + (s >> 5)] |= 1 << (s & 31); };
          RSTART[idx] = rayList.length;
          for (const m of spec) {
            const dx = c ? -m.dx : m.dx, dy = c ? -m.dy : m.dy;
            if (m.jump) {
              const tx = x + dx, ty = y + dy;
              if (tx < 0 || tx > 8 || ty < 0 || ty > 8) continue;
              const n = Math.abs(dy), inter = [];
              for (let i = 1; i < n; i++) inter.push((y + Math.sign(dy) * i) * 9 + x + Math.trunc(dx * i / n));
              rayList.push(1, ty * 9 + tx, inter.length, ...inter);
              reach(ty * 9 + tx);
            } else {
              const sqs = [];
              for (let i = 1; i <= m.d; i++) {
                const nx = x + dx * i, ny = y + dy * i;
                if (nx < 0 || nx > 8 || ny < 0 || ny > 8) break;
                sqs.push(ny * 9 + nx);
              }
              if (sqs.length) { rayList.push(0, sqs.length, ...sqs); sqs.forEach(reach); }
            }
          }
          REND[idx] = rayList.length;
        }
      }
    }
  }
  const RAY = Int16Array.from(rayList);

  // ------------------------------------------------------------------ Zobrist ハッシュ
  let seed = 0x2545F491;
  function rnd32() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  }
  const ZPL = new Int32Array(243 * 32), ZPH = new Int32Array(243 * 32);
  const ZHL = new Int32Array(32 * 8), ZHH = new Int32Array(32 * 8);
  for (let i = 0; i < ZPL.length; i++) { ZPL[i] = rnd32(); ZPH[i] = rnd32(); }
  for (let i = 0; i < ZHL.length; i++) { ZHL[i] = rnd32(); ZHH[i] = rnd32(); }
  const ZSTM_L = rnd32(), ZSTM_H = rnd32(), ZMAIN_L = rnd32(), ZMAIN_H = rnd32();
  const ZDONE_L = [rnd32(), rnd32()], ZDONE_H = [rnd32(), rnd32()];

  // ------------------------------------------------------------------ 指し手のエンコード
  // move = to | from<<7 | 新の駒種<<14 | 動作<<18 | 寝返り<<20
  //   from = 127 なら「新」(手駒を打つ。配置フェーズの配置も同じ)
  //   動作: 0=空きマスへ移動 / 1=取る / 2=ツケ
  const SETUP = 0, MAIN = 1;
  const DROP = 127;
  const ACT_MOVE = 0, ACT_CAP = 1, ACT_TSUKE = 2;
  const BETRAY = 1 << 20;
  const DONE = 1 << 21;      // 配置フェーズの「済」
  const NULLMOVE = 1 << 22;  // 探索用のパス
  const mvTo = m => m & 127;
  const mvFrom = m => (m >> 7) & 127;
  const mvDrop = m => (m >> 14) & 15;
  const mvAct = m => (m >> 18) & 3;

  const UREC = 36; // 取り消し用レコード長
  const FW = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const sqName = sq => FW[9 - (sq % 9)] + KN[((sq / 9) | 0) + 1];
  const sqNum = sq => `${9 - (sq % 9)}${((sq / 9) | 0) + 1}`;

  class Position {
    // opts: { empty: 盤も手駒も空, setup: 'fixed' | 'free'（省略時はレベルの既定） }。true を渡すと empty 扱い
    constructor(levelKey = 'jokyu', opts = {}) {
      if (opts === true) opts = { empty: true };
      const L = LEVELS[levelKey];
      if (!L) throw new Error('unknown level: ' + levelKey);
      const empty = !!opts.empty;
      const fixed = opts.setup ? opts.setup === 'fixed' : L.fixed;
      this.levelKey = levelKey;
      this.setupMode = fixed ? 'fixed' : 'free';
      this.level = L;
      this.maxTier = L.maxTier;
      this.kingTsuke = L.kingTsuke;
      this.stk = new Uint8Array(243);   // stk[sq*3 + i] (i=0 が一番下)。駒 = 種類 | 色<<4
      this.hgt = new Uint8Array(81);
      this.hand = new Uint8Array(32);   // hand[色*16 + 種類]
      this.stm = BLACK;
      this.phase = SETUP;
      this.done = new Uint8Array(2);
      this.king = new Int8Array([-1, -1]);
      this.hlo = 0; this.hhi = 0;
      this.irr = 0;                     // 最後の不可逆手（取り・新など）の直後の履歴位置
      this.histLo = []; this.histHi = [];
      this.u = new Int32Array(UREC * 512); this.nu = 0;
      this._need = new Uint8Array(16);
      if (!empty) {
        for (const t of L.types) { this.hand[t] = PIECE_COUNT[t]; this.hand[16 + t] = PIECE_COUNT[t]; }
        if (fixed) {
          for (const c of [BLACK, WHITE]) {
            for (const [t, x, r] of L.setup) {
              const sq = relSq(c, x, r);
              this._put(sq, t | (c << 4));
              this.hand[c * 16 + t]--;
            }
          }
          this.phase = MAIN; this.done[0] = this.done[1] = 1;
        }
      }
      this.rehash();
      this.histLo.push(this.hlo); this.histHi.push(this.hhi);
    }

    _put(sq, p) {
      this.stk[sq * 3 + this.hgt[sq]] = p;
      this.hgt[sq]++;
      if ((p & 15) === SUI) this.king[p >> 4] = sq;
    }

    rehash() {
      let lo = 0, hi = 0;
      for (let s = 0; s < 81; s++) {
        for (let i = 0; i < this.hgt[s]; i++) {
          const k = (s * 3 + i) * 32 + this.stk[s * 3 + i];
          lo ^= ZPL[k]; hi ^= ZPH[k];
        }
      }
      for (let c = 0; c < 2; c++) for (let t = 1; t < NT; t++) {
        const k = (c * 16 + t) * 8 + this.hand[c * 16 + t];
        lo ^= ZHL[k]; hi ^= ZHH[k];
      }
      if (this.stm) { lo ^= ZSTM_L; hi ^= ZSTM_H; }
      for (let c = 0; c < 2; c++) if (this.done[c]) { lo ^= ZDONE_L[c]; hi ^= ZDONE_H[c]; }
      if (this.phase === MAIN) { lo ^= ZMAIN_L; hi ^= ZMAIN_H; }
      this.hlo = lo; this.hhi = hi;
    }

    _xorStack(s) {
      const h = this.hgt[s];
      for (let i = 0; i < h; i++) {
        const k = (s * 3 + i) * 32 + this.stk[s * 3 + i];
        this.hlo ^= ZPL[k]; this.hhi ^= ZPH[k];
      }
    }

    _handAdd(c, t, d) {
      const i = c * 16 + t;
      let k = i * 8 + this.hand[i];
      this.hlo ^= ZHL[k]; this.hhi ^= ZHH[k];
      this.hand[i] += d;
      k = i * 8 + this.hand[i];
      this.hlo ^= ZHL[k]; this.hhi ^= ZHH[k];
    }

    _flip() { this.stm ^= 1; this.hlo ^= ZSTM_L; this.hhi ^= ZSTM_H; }

    _push() { this.histLo.push(this.hlo); this.histHi.push(this.hhi); }

    // ---------------------------------------------------------------- 指し手の実行
    make(m) {
      let u = this.nu * UREC;
      if (u + UREC > this.u.length) { const nu = new Int32Array(this.u.length * 2); nu.set(this.u); this.u = nu; }
      const U = this.u, c = this.stm, stk = this.stk, hgt = this.hgt;
      U[u] = m; U[u + 1] = this.hlo; U[u + 2] = this.hhi; U[u + 3] = this.king[0]; U[u + 4] = this.king[1];
      U[u + 5] = c; U[u + 6] = this.phase; U[u + 7] = this.done[0]; U[u + 8] = this.done[1]; U[u + 9] = this.irr;
      const hb = c * 16;
      for (let t = 1; t < NT; t++) U[u + 19 + t] = this.hand[hb + t];
      U[u + 10] = -1; U[u + 15] = -1;
      this.nu++;

      if (m === NULLMOVE) { this._flip(); this._push(); return; }
      if (m === DONE) {
        this.done[c] = 1; this.hlo ^= ZDONE_L[c]; this.hhi ^= ZDONE_H[c];
        if (c === WHITE) this._enterMain(); // 後手の「済」で配置終了 → 先手から対局開始
        this._flip();
        this.irr = this.histLo.length;
        this._push();
        return;
      }

      const to = m & 127, from = (m >> 7) & 127, act = (m >> 18) & 3;
      U[u + 15] = to; const ht0 = hgt[to]; U[u + 16] = ht0;
      U[u + 17] = stk[to * 3]; U[u + 18] = stk[to * 3 + 1]; U[u + 19] = stk[to * 3 + 2];
      this._xorStack(to);
      let piece;
      if (from === DROP) {
        const t = (m >> 14) & 15;
        piece = t | (c << 4);
        this._handAdd(c, t, -1);
        this.irr = this.histLo.length;
      } else {
        U[u + 10] = from; const hf = hgt[from]; U[u + 11] = hf;
        U[u + 12] = stk[from * 3]; U[u + 13] = stk[from * 3 + 1]; U[u + 14] = stk[from * 3 + 2];
        this._xorStack(from);
        piece = stk[from * 3 + hf - 1];
        stk[from * 3 + hf - 1] = 0; hgt[from] = hf - 1;
        this._xorStack(from);
      }
      const b = to * 3;
      let ht = ht0;
      if (act === ACT_CAP) {
        // 取り: マス内の相手駒をすべて取る（ゲームから除外）。自駒はその場に残る
        let w = 0;
        for (let i = 0; i < ht; i++) {
          const q = stk[b + i];
          if ((q >> 4) === c) stk[b + w++] = q;
          else if ((q & 15) === SUI) this.king[c ^ 1] = -1;
        }
        for (let i = w; i < ht; i++) stk[b + i] = 0;
        ht = w;
        this.irr = this.histLo.length;
      } else if (m & BETRAY) {
        // 寝返り: ツケた相手駒を、自分の手駒の同種駒と入れ替える（相手駒は除外）
        for (let i = 0; i < ht; i++) {
          const q = stk[b + i];
          if ((q >> 4) !== c) { stk[b + i] = (q & 15) | (c << 4); this._handAdd(c, q & 15, -1); }
        }
        this.irr = this.histLo.length;
      }
      stk[b + ht] = piece; hgt[to] = ht + 1;
      if ((piece & 15) === SUI) this.king[c] = to;
      this._xorStack(to);
      if (this.phase === SETUP) { if (!this.done[c ^ 1]) this._flip(); } else this._flip();
      this._push();
    }

    _enterMain() {
      this.phase = MAIN; this.hlo ^= ZMAIN_L; this.hhi ^= ZMAIN_H;
      if (!this.done[BLACK]) { this.done[BLACK] = 1; this.hlo ^= ZDONE_L[BLACK]; this.hhi ^= ZDONE_H[BLACK]; }
    }

    makeNull() { this.make(NULLMOVE); }

    unmake() {
      const u = (--this.nu) * UREC, U = this.u;
      const c = U[u + 5];
      this.histLo.pop(); this.histHi.pop();
      this.hlo = U[u + 1]; this.hhi = U[u + 2]; this.king[0] = U[u + 3]; this.king[1] = U[u + 4];
      this.stm = c; this.phase = U[u + 6]; this.done[0] = U[u + 7]; this.done[1] = U[u + 8]; this.irr = U[u + 9];
      const hb = c * 16;
      for (let t = 1; t < NT; t++) this.hand[hb + t] = U[u + 19 + t];
      const from = U[u + 10], to = U[u + 15];
      if (from >= 0) {
        this.hgt[from] = U[u + 11];
        this.stk[from * 3] = U[u + 12]; this.stk[from * 3 + 1] = U[u + 13]; this.stk[from * 3 + 2] = U[u + 14];
      }
      if (to >= 0) {
        this.hgt[to] = U[u + 16];
        this.stk[to * 3] = U[u + 17]; this.stk[to * 3 + 1] = U[u + 18]; this.stk[to * 3 + 2] = U[u + 19];
      }
      return U[u];
    }

    lastMove() { return this.nu ? this.u[(this.nu - 1) * UREC] : 0; }

    // ---------------------------------------------------------------- 合法手生成（自玉の安全は未チェック）
    genMoves(buf, capOnly) {
      if (this.phase === SETUP) return this.genSetup(buf);
      const c = this.stm, stk = this.stk, hgt = this.hgt;
      let n = 0;
      for (let s = 0; s < 81; s++) {
        const h = hgt[s];
        if (!h) continue;
        const p = stk[s * 3 + h - 1];
        if ((p >> 4) !== c) continue;
        const t = p & 15, idx = ((c * NT + t) * 4 + h) * 81 + s;
        const canT = t !== SUI || this.kingTsuke;
        let r = RSTART[idx];
        const e = REND[idx];
        while (r < e) {
          if (RAY[r] === 0) {
            const end = r + 2 + RAY[r + 1];
            r += 2;
            let d = 0, hd = 0;
            for (; r < end; r++) {
              d = RAY[r]; hd = hgt[d];
              if (hd) break;
              if (!capOnly) buf[n++] = d | (s << 7);
            }
            if (r < end) n = this._occ(buf, n, s, d, hd, h, t, c, canT, capOnly);
            r = end;
          } else {
            const d = RAY[r + 1], ni = RAY[r + 2];
            let ok = true;
            for (let i = 0; i < ni; i++) if (hgt[RAY[r + 3 + i]] > h) { ok = false; break; }
            r += 3 + ni;
            if (!ok) continue;
            const hd = hgt[d];
            if (!hd) { if (!capOnly) buf[n++] = d | (s << 7); } else n = this._occ(buf, n, s, d, hd, h, t, c, canT, capOnly);
          }
        }
      }
      if (capOnly) return n;

      // 新（手駒を打つ）: 最前線の自駒と同じ段か、それより自陣側。空きマス or 自駒の上
      // 謀だけは相手駒の上にも新を打てる（寝返り）
      const hb = c * 16;
      let any = false;
      for (let t = 1; t < NT; t++) if (this.hand[hb + t]) { any = true; break; }
      if (!any) return n;
      const [y0, y1] = this.dropRows(c);
      const mt = this.maxTier;
      for (let t = 1; t < NT; t++) {
        if (!this.hand[hb + t]) continue;
        const base = (DROP << 7) | (t << 14);
        for (let d = y0 * 9, dEnd = (y1 + 1) * 9; d < dEnd; d++) {
          const hd = hgt[d];
          if (!hd) { buf[n++] = d | base; continue; }
          if (hd >= mt) continue;
          const top = stk[d * 3 + hd - 1];
          if ((top & 15) === SUI) continue;
          if ((top >> 4) === c) buf[n++] = d | base | (ACT_TSUKE << 18);
          else if (t === BOU) {
            buf[n++] = d | base | (ACT_TSUKE << 18);
            if (this._canBetray(d, hd, c, true)) buf[n++] = d | base | (ACT_TSUKE << 18) | BETRAY;
          }
        }
      }
      return n;
    }

    // 新を打てる段の範囲 [y0, y1]
    dropRows(c) {
      const stk = this.stk, hgt = this.hgt;
      if (c === BLACK) {
        for (let s = 0; s < 81; s++) { const h = hgt[s]; if (h && (stk[s * 3 + h - 1] >> 4) === c) return [(s / 9) | 0, 8]; }
        return [8, 8];
      }
      for (let s = 80; s >= 0; s--) { const h = hgt[s]; if (h && (stk[s * 3 + h - 1] >> 4) === c) return [0, (s / 9) | 0]; }
      return [0, 0];
    }

    // 移動先に駒があるときの処理（取る / ツケ / 寝返り）
    _occ(buf, n, s, d, hd, h, t, c, canT, capOnly) {
      if (hd > h) return n; // 自分より高い段の駒には手を出せない
      const top = this.stk[d * 3 + hd - 1], base = d | (s << 7);
      const tsukeOK = canT && hd < this.maxTier && (top & 15) !== SUI; // 帥の上にはツケられない
      if ((top >> 4) !== c) {
        buf[n++] = base | (ACT_CAP << 18);
        if (tsukeOK) {
          // capOnly === 2: 取る手に加えて「相手駒へのツケ」も生成（静止探索用）
          if (!capOnly || capOnly === 2) buf[n++] = base | (ACT_TSUKE << 18);
          if (t === BOU && this._canBetray(d, hd, c, false)) buf[n++] = base | (ACT_TSUKE << 18) | BETRAY;
        }
      } else if (tsukeOK && !capOnly) buf[n++] = base | (ACT_TSUKE << 18);
      return n;
    }

    // 寝返り可能か: マス内の相手駒すべてについて、同種の手駒が足りること
    _canBetray(d, hd, c, dropping) {
      const need = this._need;
      need.fill(0);
      for (let i = 0; i < hd; i++) { const q = this.stk[d * 3 + i]; if ((q >> 4) !== c) need[q & 15]++; }
      if (dropping) need[BOU]++;
      const hb = c * 16;
      for (let t = 1; t < NT; t++) if (need[t] && this.hand[hb + t] < need[t]) return false;
      return true;
    }

    // 配置フェーズ: 自陣3段に配置（最初は必ず帥）、または「済」
    genSetup(buf) {
      const c = this.stm, hb = c * 16, stk = this.stk, hgt = this.hgt;
      let n = 0;
      const y0 = c === BLACK ? 6 : 0;
      if (this.king[c] < 0) {
        for (let d = y0 * 9; d < (y0 + 3) * 9; d++) if (!hgt[d]) buf[n++] = d | (DROP << 7) | (SUI << 14);
        return n;
      }
      for (let t = 1; t < NT; t++) {
        if (!this.hand[hb + t]) continue;
        const base = (DROP << 7) | (t << 14);
        for (let d = y0 * 9; d < (y0 + 3) * 9; d++) {
          const hd = hgt[d];
          if (!hd) { buf[n++] = d | base; continue; }
          if (hd >= this.maxTier) continue;
          const top = stk[d * 3 + hd - 1];
          if ((top & 15) === SUI || (top >> 4) !== c) continue;
          buf[n++] = d | base | (ACT_TSUKE << 18);
        }
      }
      buf[n++] = DONE;
      return n;
    }

    // ---------------------------------------------------------------- 利き判定
    // 色 by の駒が sq の駒を取れるか（段の条件・飛び越え条件込み）
    attacked(sq, by) {
      const stk = this.stk, hgt = this.hgt, h = hgt[sq];
      const wi = sq >> 5, bit = 1 << (sq & 31);
      for (let s = 0; s < 81; s++) {
        const hs = hgt[s];
        if (!hs || hs < h) continue;
        const p = stk[s * 3 + hs - 1];
        if ((p >> 4) !== by) continue;
        const idx = ((by * NT + (p & 15)) * 4 + hs) * 81 + s;
        if (!(REACH[idx * 3 + wi] & bit)) continue;
        let r = RSTART[idx];
        const e = REND[idx];
        while (r < e) {
          if (RAY[r] === 0) {
            const end = r + 2 + RAY[r + 1];
            for (r += 2; r < end; r++) { const d = RAY[r]; if (d === sq) return true; if (hgt[d]) break; }
            r = end;
          } else {
            const ni = RAY[r + 2];
            if (RAY[r + 1] === sq) {
              let ok = true;
              for (let i = 0; i < ni; i++) if (hgt[RAY[r + 3 + i]] > hs) { ok = false; break; }
              if (ok) return true;
            }
            r += 3 + ni;
          }
        }
      }
      return false;
    }

    inCheck(c) { const k = this.king[c]; return k >= 0 && this.attacked(k, c ^ 1); }

    // 自玉を取られる手を除いた合法手
    legalMoves() {
      const buf = new Int32Array(4096);
      const n = this.genMoves(buf, false), out = [];
      if (this.phase === SETUP) { for (let i = 0; i < n; i++) out.push(buf[i]); return out; }
      const c = this.stm;
      for (let i = 0; i < n; i++) {
        this.make(buf[i]);
        if (!this.inCheck(c)) out.push(buf[i]);
        this.unmake();
      }
      return out;
    }

    isRepetition() {
      const lo = this.hlo, hi = this.hhi, hl = this.histLo, hh = this.histHi;
      for (let i = hl.length - 2; i >= this.irr; i--) if (hl[i] === lo && hh[i] === hi) return true;
      return false;
    }

    repetitionCount() {
      const lo = this.hlo, hi = this.hhi, hl = this.histLo, hh = this.histHi;
      let n = 0;
      for (let i = hl.length - 1; i >= this.irr; i--) if (hl[i] === lo && hh[i] === hi) n++;
      return n;
    }

    // 終局判定: null または { winner: 0/1 (-1=引き分け), reason }
    result() {
      if (this.phase !== MAIN) return null;
      for (let c = 0; c < 2; c++) if (this.king[c] < 0) return { winner: c ^ 1, reason: '帥を取った' };
      if (this.repetitionCount() >= 4) return { winner: -1, reason: '千日手' };
      if (this.legalMoves().length === 0) return { winner: this.stm ^ 1, reason: '詰み' };
      return null;
    }

    // ---------------------------------------------------------------- 表示用
    topAt(sq) { const h = this.hgt[sq]; return h ? this.stk[sq * 3 + h - 1] : 0; }
    stackAt(sq) { const r = []; for (let i = 0; i < this.hgt[sq]; i++) { const p = this.stk[sq * 3 + i]; r.push({ color: p >> 4, type: p & 15 }); } return r; }
    handCount(c, t) { return this.hand[c * 16 + t]; }

    // 指し手 → 棋譜表記（指す前の局面で呼ぶ）
    moveText(m) {
      const mark = this.stm === BLACK ? '▲' : '△';
      if (m === DONE) return mark + '済';
      if (m === NULLMOVE) return mark + 'パス';
      const to = m & 127, from = (m >> 7) & 127, act = (m >> 18) & 3;
      let t;
      if (from === DROP) t = (m >> 14) & 15;
      else t = this.stk[from * 3 + this.hgt[from] - 1] & 15;
      let ht = this.hgt[to];
      if (act === ACT_CAP) {
        let w = 0;
        for (let i = 0; i < ht; i++) if ((this.stk[to * 3 + i] >> 4) === this.stm) w++;
        ht = w;
      }
      let s = mark + sqName(to) + KANJI[t];
      if (from === DROP) s += this.phase === SETUP ? '' : '新';
      if (act === ACT_CAP) s += '取';
      else if (act === ACT_TSUKE) s += 'ツケ';
      if (m & BETRAY) s += '寝返り';
      if (ht + 1 > 1) s += `${ht + 1}段`;
      if (from !== DROP) s += `(${sqNum(from)})`;
      return s;
    }

    // 移動後の段（指す前に呼ぶ）
    landingTier(m) {
      if (m === DONE || m === NULLMOVE) return 0;
      const to = m & 127, act = (m >> 18) & 3;
      let ht = this.hgt[to];
      if (act === ACT_CAP) {
        let w = 0;
        for (let i = 0; i < ht; i++) if ((this.stk[to * 3 + i] >> 4) === this.stm) w++;
        ht = w;
      }
      return ht + 1;
    }

    // ---------------------------------------------------------------- シリアライズ
    toBytes() {
      let n = 0;
      for (let s = 0; s < 81; s++) n += this.hgt[s];
      const b = new Uint8Array(1 + 28 + 81 + n);
      b[0] = this.stm | (this.phase << 1) | (this.done[0] << 2) | (this.done[1] << 3) | (LEVEL_KEYS.indexOf(this.levelKey) << 4);
      for (let c = 0; c < 2; c++) for (let t = 1; t < NT; t++) b[1 + c * 14 + t - 1] = this.hand[c * 16 + t];
      let o = 29 + 81;
      for (let s = 0; s < 81; s++) {
        b[29 + s] = this.hgt[s];
        for (let i = 0; i < this.hgt[s]; i++) b[o++] = this.stk[s * 3 + i];
      }
      return b;
    }

    static fromBytes(b) {
      const pos = new Position(LEVEL_KEYS[(b[0] >> 4) & 3], true);
      pos.stm = b[0] & 1; pos.phase = (b[0] >> 1) & 1; pos.done[0] = (b[0] >> 2) & 1; pos.done[1] = (b[0] >> 3) & 1;
      for (let c = 0; c < 2; c++) for (let t = 1; t < NT; t++) pos.hand[c * 16 + t] = b[1 + c * 14 + t - 1];
      let o = 29 + 81;
      for (let s = 0; s < 81; s++) for (let i = 0; i < b[29 + s]; i++) pos._put(s, b[o++]);
      pos.rehash();
      pos.histLo = [pos.hlo]; pos.histHi = [pos.hhi];
      return pos;
    }

    static fromMoves(levelKey, moves, setup) {
      const pos = new Position(levelKey, { setup });
      for (const m of moves) pos.make(m);
      return pos;
    }

    // デバッグ用の盤面テキスト（先手=大文字, 後手=小文字, 重なりは括弧）
    toText() {
      const rows = [];
      for (let y = 0; y < 9; y++) {
        let row = '';
        for (let x = 0; x < 9; x++) {
          const s = y * 9 + x, h = this.hgt[s];
          if (!h) { row += ' . '; continue; }
          let cell = '';
          for (let i = 0; i < h; i++) { const p = this.stk[s * 3 + i]; const ch = LETTERS[p & 15]; cell += (p >> 4) ? ch.toLowerCase() : ch; }
          row += h === 1 ? ` ${cell} ` : h === 2 ? `(${cell})` : cell;
        }
        rows.push(row);
      }
      const hs = c => { let s = ''; for (let t = 1; t < NT; t++) if (this.hand[c * 16 + t]) s += KANJI[t] + this.hand[c * 16 + t]; return s || 'なし'; };
      return rows.join('\n') + `\n先手手駒: ${hs(0)} / 後手手駒: ${hs(1)} / 手番: ${this.stm ? '後手' : '先手'}${this.phase === SETUP ? ' (配置中)' : ''}`;
    }
  }

  Object.assign(G, {
    SUI, TAI, CHU, SHO, SAM, YAR, KIB, SIN, TOR, HYO, YUM, TSU, HOO, BOU, NT, BLACK, WHITE,
    KANJI, NAMES, LETTERS, PIECE_COUNT, LEVELS, LEVEL_KEYS, BASIC_TYPES, ALL_TYPES,
    SETUP, MAIN, DROP, ACT_MOVE, ACT_CAP, ACT_TSUKE, BETRAY, DONE, NULLMOVE,
    mvTo, mvFrom, mvDrop, mvAct, moveSpec, relSq, sqName, sqNum,
    RAY, RSTART, REND, REACH, rIdx, Position,
  });
  return G;
}
if (typeof module !== 'undefined' && module.exports) module.exports = GungiCore;
