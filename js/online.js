/* 軍儀 オンライン対戦（公開の MQTT 中継サーバー経由。自前のサーバーはいらない）
 *
 * しくみ（トピックはすべて NS の下）:
 *   p/<id>   在席（保持メッセージ）: {id, n:名前, s:'idle'|'wait'|'play', ai:AI補助(1=形勢 2=矢印), lv, su, c:部屋コード, g:対局ID, t:時刻}
 *            切断したら中継サーバーが空の保持メッセージ（遺言）を出して消える。30秒ごとに更新し、古いものは数えない
 *   i/<id>   その人あての連絡: 申し込み {t:'ch'}・受け付け {t:'ok'}・お断り {t:'no'}
 *   g/<gid>  対局の連絡: 指し手 {t:'mv', n:何手目, m}・投了・AI補助の状態・ヒントを使った・もう一局 など
 *   g/<gid>/s 対局の今の状態（保持メッセージ）: 指し手の全部。再読み込みしたときや取りこぼしたときに追いつく
 * 中継サーバーは公開のもの（だれでも読み書きできる）なので、名前と指し手は他の人からも見える可能性がある。
 */
(function () {
  'use strict';
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.10.1/mqtt.min.js';
  const NS = 'gungi-angrh0824/v1';
  const STALE = 100 * 1000;   // これより古い在席は数えない
  const BEAT = 30 * 1000;     // 在席の更新間隔
  const rid = n => { let s = ''; const a = 'abcdefghijkmnpqrstuvwxyz23456789'; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
  const code4 = () => rid(4).toUpperCase();

  function loadLib() {
    if (window.mqtt) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = LIB; s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error('通信の部品を読み込めませんでした'));
      document.head.appendChild(s);
    });
  }

  function create(h) {
    const me = { id: 'u' + rid(9), name: '', s: 'idle', ai: 0, lv: '', su: '', c: '', g: '' };
    const peers = new Map();       // id → 在席情報（自分は含めない）
    let client = null, status = 'off', brokerIdx = 0, beatTimer = 0, pruneTimer = 0, game = null, pending = null;
    const T = sub => `${NS}/${sub}`;
    const emitPresence = () => { if (h.onPresence) h.onPresence(list()); };
    const setStatus = s => { status = s; if (h.onStatus) h.onStatus(s); };

    function list() {
      const now = Date.now(), out = [];
      peers.forEach(p => { if (now - p.t < STALE || now - p.seen < STALE) out.push(p); });
      return out;
    }
    function counts() {
      const ps = list(), all = ps.concat(status === 'on' ? [Object.assign({ self: true }, me)] : []);
      return { online: all.length, wait: all.filter(p => p.s === 'wait').length, play: all.filter(p => p.s === 'play').length };
    }
    function publishMe() {
      if (!client || !client.connected) return;
      const body = { id: me.id, n: me.name || 'ゲスト', s: me.s, ai: me.ai, t: Date.now(), v: 1 };
      if (me.s === 'wait') { body.lv = me.lv; body.su = me.su; body.c = me.c; }
      if (me.s === 'play') body.g = me.g;
      client.publish(T(`p/${me.id}`), JSON.stringify(body), { retain: true, qos: 1 });
    }

    async function connect() {
      if (client) return;
      setStatus('connecting');
      try { await loadLib(); } catch (e) { setStatus('error'); return; }
      const url = BROKERS[brokerIdx];
      client = window.mqtt.connect(url, {
        clientId: me.id, clean: true, keepalive: 30, reconnectPeriod: 4000, connectTimeout: 8000,
        will: { topic: T(`p/${me.id}`), payload: '', retain: true, qos: 1 },
      });
      let everConnected = false;
      const failTimer = setTimeout(() => {
        // 最初の中継サーバーにつながらなければ、もう一方を試す
        if (!everConnected && brokerIdx + 1 < BROKERS.length) { try { client.end(true); } catch (e) { /* 無視 */ } client = null; brokerIdx++; connect(); }
      }, 9000);
      client.on('connect', () => {
        everConnected = true; clearTimeout(failTimer);
        client.subscribe([T('p/+'), T(`i/${me.id}`)].concat(game ? [T(`g/${game.gid}`), T(`g/${game.gid}/s`)] : []), { qos: 1 });
        publishMe();
        if (game) gameSend({ t: 'hi', n: me.name, ai: me.ai, back: 1 }); // つなぎ直したら相手にあいさつ（名前と AI補助を知らせ直す）
        setStatus('on');
      });
      client.on('reconnect', () => setStatus('connecting'));
      client.on('offline', () => setStatus('connecting'));
      client.on('close', () => { if (status === 'on') setStatus('connecting'); });
      client.on('error', () => { /* 再接続に任せる */ });
      client.on('message', onMessage);
      clearInterval(beatTimer); beatTimer = setInterval(publishMe, BEAT);
      clearInterval(pruneTimer); pruneTimer = setInterval(() => { emitPresence(); checkOpp(); }, 10000);
      window.addEventListener('pagehide', () => { try { client.publish(T(`p/${me.id}`), '', { retain: true, qos: 0 }); client.end(true); } catch (e) { /* 無視 */ } });
    }

    function onMessage(topic, buf) {
      const sub = topic.slice(NS.length + 1);
      let msg = null;
      if (buf && buf.length) { try { msg = JSON.parse(buf.toString()); } catch (e) { return; } }
      if (sub.startsWith('p/')) {
        const id = sub.slice(2);
        if (id === me.id) return;
        if (!msg) peers.delete(id); else peers.set(id, Object.assign(msg, { id, seen: Date.now() }));
        emitPresence(); checkOpp();
      } else if (sub === `i/${me.id}` && msg) onInbox(msg);
      else if (game && sub === `g/${game.gid}` && msg && msg.from !== me.id) { if (h.onRemote) h.onRemote(msg); }
      else if (game && sub === `g/${game.gid}/s` && msg && msg.from !== me.id) { if (h.onRemote) h.onRemote(Object.assign({ t: 'state' }, msg)); }
    }

    // 相手の在席（対局IDが同じ人）。再読み込みで ID が変わっても見つけられる
    let oppPresent = null;
    function checkOpp() {
      if (!game || status !== 'on') return; // 自分がつながっていないときは、相手の在席はわからない
      const p = list().find(x => x.g === game.gid);
      const now = !!p;
      if (p) game.oppId = p.id;
      if (now !== oppPresent) { oppPresent = now; if (h.onOppPresence) h.onOppPresence(now); }
    }

    function onInbox(msg) {
      if (msg.t === 'ch') {
        // 対戦の申し込み: 待っていれば受ける（先後はランダム）
        if (me.s !== 'wait' || game) { send(`i/${msg.from}`, { t: 'no', from: me.id }); return; }
        const gid = rid(10), myColor = Math.random() < 0.5 ? 0 : 1;
        send(`i/${msg.from}`, { t: 'ok', from: me.id, n: me.name, ai: me.ai, gid, lv: me.lv, su: me.su, oc: myColor ^ 1 });
        startGame({ gid, myColor, lv: me.lv, su: me.su, opp: { id: msg.from, name: msg.n || 'ゲスト', ai: msg.ai || 0 } });
      } else if (msg.t === 'ok' && pending && pending.id === msg.from) {
        clearTimeout(pending.timer); pending = null;
        startGame({ gid: msg.gid, myColor: msg.oc, lv: msg.lv, su: msg.su, opp: { id: msg.from, name: msg.n || 'ゲスト', ai: msg.ai || 0 } });
      } else if (msg.t === 'no' && pending && pending.id === msg.from) {
        clearTimeout(pending.timer); pending = null;
        if (h.onChallenge) h.onChallenge('no');
      }
    }

    function send(sub, body) { if (client && client.connected) client.publish(T(sub), JSON.stringify(body), { qos: 1 }); }

    function startGame(g) {
      if (game) leaveGame(true);
      game = Object.assign({ oppId: g.opp.id }, g);
      oppPresent = null;
      me.s = 'play'; me.g = g.gid; me.c = '';
      client.subscribe([T(`g/${g.gid}`), T(`g/${g.gid}/s`)], { qos: 1 });
      publishMe();
      if (h.onMatch) h.onMatch(game);
      gameSend({ t: 'hi', n: me.name, ai: me.ai });
    }
    function gameSend(body) { if (game) send(`g/${game.gid}`, Object.assign({ from: me.id }, body)); }
    function leaveGame(quiet) {
      if (!game) return;
      if (client) client.unsubscribe([T(`g/${game.gid}`), T(`g/${game.gid}/s`)]);
      game = null; oppPresent = null;
      me.s = 'idle'; me.g = '';
      if (!quiet) publishMe();
    }

    return {
      get id() { return me.id; },
      get status() { return status; },
      get game() { return game; },
      get me() { return me; },
      connect, list, counts,
      setName(n) { me.name = String(n || '').slice(0, 16); publishMe(); },
      setAI(flags) { me.ai = flags; publishMe(); gameSend({ t: 'ai', ai: flags }); },
      wait(lv, su) { me.s = 'wait'; me.lv = lv; me.su = su; me.c = me.c || code4(); publishMe(); return me.c; },
      unwait() { if (me.s === 'wait') { me.s = 'idle'; me.c = ''; publishMe(); } },
      challenge(id) {
        if (pending) clearTimeout(pending.timer);
        pending = { id, timer: setTimeout(() => { pending = null; if (h.onChallenge) h.onChallenge('timeout'); }, 12000) };
        send(`i/${id}`, { t: 'ch', from: me.id, n: me.name, ai: me.ai });
      },
      send: gameSend,
      saveState(state) { if (game && client && client.connected) client.publish(T(`g/${game.gid}/s`), JSON.stringify(Object.assign({ from: me.id, t: Date.now() }, state)), { retain: true, qos: 1 }); },
      leaveGame,
      start: startGame,
      // 再読み込みしたあと、保存していた対局に戻る
      rejoin(g) {
        game = Object.assign({}, g); oppPresent = null;
        me.s = 'play'; me.g = g.gid;
        if (client && client.connected) { client.subscribe([T(`g/${g.gid}`), T(`g/${g.gid}/s`)], { qos: 1 }); publishMe(); }
        gameSend({ t: 'hi', n: me.name, ai: me.ai, back: 1 });
      },
    };
  }

  window.GungiOnline = { create, NS };
})();
