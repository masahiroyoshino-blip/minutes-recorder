/**
 * 議事録アプリ v1.0.0（Step 1）
 * 画面：GitHub Pages 上の1ページ。裏側：GAS「議事録アプリ_API」（Gemini の窓口）。
 *
 * 守っていること
 *  - Google のドライブ・カレンダーは、ログインした本人の権限で直接扱う（drive.file / calendar.readonly）
 *  - 裏側APIに送るのは「音声・参加人数・話者A／Bのままの全文」だけ。参加者の名前と自分用メモは送らない
 *  - 名前の置き換えはこの画面の中だけで行う
 *  - ?demo=1 で開くと、Google にも裏側APIにもつながない見本モード（画面確認用）
 */
(function () {
  'use strict';

  var CFG = window.MINUTES_CONFIG || {};
  var DEMO = /[?&]demo=1\b/.test(location.search);
  var SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.readonly';
  var SEG_MS = (Number(CFG.segmentMinutes) || 15) * 60000;
  var MAX_MS = (Number(CFG.maxMinutes) || 90) * 60000;
  var MIN_SEG_SEC = 5;                        // これより短い最後の切れ端は書き起こさない（当て推量を防ぐ）
  var SPEAKER_COLORS = ['#2D53A0', '#DA5C59', '#E0A800', '#3E8A6E', '#7A5BA6', '#5A6B7D', '#B5651D', '#2B8C9E'];
  var FOLDER_NAME = CFG.folderName || '議事録アプリ';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var S = { user: null, google: { token: '', exp: 0 }, session: '', folderId: null, folderName: '', screen: 'login', m: null };

  // ============================================================ 小道具
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return ('0' + n).slice(-2); }
  function hms(sec) { sec = Math.max(0, Math.floor(sec)); return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor(sec % 3600 / 60)) + ':' + pad(sec % 60); }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function jDate(d) { return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）'; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var toastTimer = null;
  function toast(msg, ng) {
    var t = $('#toast'); t.textContent = msg; t.className = 'toast' + (ng ? ' ng' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ng ? 7000 : 3500);
  }
  function errText(e) { return (e && (e.message || e)) || String(e); }
  function show(name) {
    $$('[data-screen]').forEach(function (el) { el.hidden = el.dataset.screen !== name; });
    $('#appHeader').hidden = name === 'login';
    var step = { prepare: 1, recording: 2, finish: 3 }[name];
    $('#stepper').hidden = !step; $('#mainNav').hidden = name === 'recording'; $('#navHome').classList.toggle('active', name === 'home');
    $$('#stepper li').forEach(function (li) { li.classList.toggle('on', Number(li.dataset.step) === step); });
    S.screen = name; window.scrollTo(0, 0);
  }
  $$('[data-go="home"]').forEach(function (b) { b.addEventListener('click', function () { goHome(); }); });
  function homeClick(e) { e.preventDefault(); if (S.screen === 'recording') { toast('録音中はホームに戻れません。先に「終了」を押してください', true); return; } if (S.screen === 'finish' && S.m && !S.m.saved && !confirm('まだ保存していません。ホームに戻ると、この議事録は消えます。戻りますか？')) return; if (S.m && S.screen === 'finish') S.m.saved = true; goHome(); }
  $('#navHome').addEventListener('click', homeClick);
  $('#appHeader .logo').addEventListener('click', homeClick); $('#appHeader .logo').style.cursor = 'pointer';

  // ============================================================ ログイン
  function isInAppBrowser() {
    var ua = navigator.userAgent;
    return /FBAN|FBAV|Instagram|Line\/|Slack|MicroMessenger|GSA\//i.test(ua) || /; wv\)/.test(ua);
  }
  $('#domainLabel').textContent = CFG.allowedDomain || 'replayce.co.jp';
  if (isInAppBrowser()) $('#inAppWarn').hidden = false;

  var tokenClient = null, pendingToken = null;
  function getTokenClient() {
    if (tokenClient) return tokenClient;
    if (!window.google || !google.accounts || !google.accounts.oauth2) throw new Error('Googleのログイン部品を読み込めていません。少し待ってからもう一度押してください');
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.clientId, scope: SCOPES, hd: CFG.allowedDomain,
      callback: function (r) {
        var p = pendingToken; pendingToken = null;
        if (r.error) { if (p) p.reject(new Error('ログインできませんでした（' + r.error + '）')); return; }
        S.google.token = r.access_token; S.google.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        if (p) p.resolve(r.access_token);
      },
      error_callback: function (e) { var p = pendingToken; pendingToken = null; if (p) p.reject(new Error(e.type === 'popup_closed' ? 'ログイン画面が閉じられました' : 'ログイン画面を開けませんでした（ポップアップの許可を確認してください）')); }
    });
    return tokenClient;
  }
  /** ボタン操作の中でだけ呼ぶ（Googleのログイン画面はユーザー操作がないと開けない） */
  function requestToken() {
    if (DEMO) { S.google.token = 'demo'; S.google.exp = Date.now() + 3600e3; return Promise.resolve('demo'); }
    return new Promise(function (resolve, reject) { pendingToken = { resolve: resolve, reject: reject }; getTokenClient().requestAccessToken({ prompt: '' }); });
  }
  function tokenValid() { return S.google.token && Date.now() < S.google.exp - 60000; }
  function ensureToken() { return tokenValid() ? Promise.resolve() : requestToken(); }

  $('#btnLogin').addEventListener('click', function () {
    var box = $('#loginError'); box.hidden = true;
    if (!DEMO && (!CFG.clientId || /ここに/.test(CFG.clientId) || !CFG.apiUrl || /ここに/.test(CFG.apiUrl))) {
      box.textContent = '設定（config.js）が未記入です。管理者に連絡してください。'; box.hidden = false; return;
    }
    var btn = this; btn.disabled = true;
    requestToken().then(function (tok) {
      return api('login', { accessToken: tok });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'ログインの確認に失敗しました');
      S.session = r.session; S.user = { email: r.email };
      return gfetch('https://www.googleapis.com/oauth2/v3/userinfo').then(function (u) { S.user.name = (u && (u.name || u.given_name)) || r.email.split('@')[0]; }).catch(function () { S.user.name = r.email.split('@')[0]; });
    }).then(function () {
      $('#userName').textContent = S.user.name; $('#userInitial').textContent = S.user.name.slice(0, 1);
      goHome();
    }).catch(function (e) {
      box.textContent = errText(e); box.hidden = false;
    }).then(function () { btn.disabled = false; });
  });
  $('#btnLogout').addEventListener('click', function () {
    if (S.screen === 'recording') { toast('録音中はログアウトできません', true); return; }
    if (window.google && google.accounts && google.accounts.oauth2 && S.google.token && !DEMO) { try { google.accounts.oauth2.revoke(S.google.token, function () {}); } catch (e) {} }
    S.google = { token: '', exp: 0 }; S.session = ''; S.user = null; S.folderId = null; S.m = null;
    show('login');
  });

  // ============================================================ 裏側API（GAS）
  function api(action, payload) {
    if (DEMO) return demoApi(action, payload);
    var t0 = Date.now();
    return fetch(CFG.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
      body: JSON.stringify(Object.assign({ action: action, session: S.session }, payload || {}))
    }).then(function (res) { return res.text(); }).then(function (t) {
      var j; try { j = JSON.parse(t); } catch (e) { throw new Error('裏側APIの返事を読めませんでした'); }
      j.ms = Date.now() - t0;
      if (j.code === 401 && action !== 'login') throw new Error('ログインの期限が切れました。ログアウトしてもう一度ログインしてください');
      return j;
    });
  }

  // ============================================================ Google API（本人の権限）
  function gfetch(url, opts) {
    if (DEMO) return demoGoogle(url, opts);
    if (!tokenValid()) return Promise.reject(new Error('Googleのログインが切れました'));
    opts = opts || {}; opts.headers = Object.assign({ Authorization: 'Bearer ' + S.google.token }, opts.headers || {});
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) {}
        if (!res.ok) throw new Error('Google HTTP ' + res.status + ' ' + ((j && j.error && (j.error.message || j.error)) || ''));
        return j;
      });
    });
  }

  // ============================================================ 1 ホーム
  function goHome() {
    if (S.screen === 'recording') return;
    $('#todayLabel').textContent = jDate(new Date());
    show('home');
    loadEvents(); loadRecent('');
  }
  $('#btnRecordNow').addEventListener('click', function () { openPrepare(null); });

  function detectFormat(ev) {
    var s = [ev.location, ev.description, ev.hangoutLink, JSON.stringify(ev.conferenceData || '')].join(' ');
    if (/zoom\.us/i.test(s)) return 'Zoom';
    if (/teams\.microsoft|teams\.live/i.test(s)) return 'Teams';
    if (/meet\.google/i.test(s)) return 'Google Meet';
    return '対面';
  }
  function eventPeople(ev) {
    var list = (ev.attendees || []).filter(function (a) { return !a.resource && a.responseStatus !== 'declined'; })
      .map(function (a) { return a.self && S.user ? S.user.name : (a.displayName || String(a.email || '').split('@')[0]); });
    if (!list.length && S.user) list.push(S.user.name);
    return list.filter(function (n, i, a) { return n && a.indexOf(n) === i; });
  }
  function loadEvents() {
    var box = $('#events');
    box.innerHTML = '<div class="empty"><span class="spin"></span> 予定を読み込んでいます…</div>';
    var d0 = new Date(); d0.setHours(0, 0, 0, 0); var d1 = new Date(d0.getTime() + 86400000);
    gfetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=30' +
      '&timeMin=' + encodeURIComponent(d0.toISOString()) + '&timeMax=' + encodeURIComponent(d1.toISOString())).then(function (j) {
      var now = Date.now();
      var list = (j.items || []).filter(function (ev) { return ev.start && ev.start.dateTime && ev.status !== 'cancelled'; });
      if (!list.length) { box.innerHTML = '<div class="empty">今日の時間指定の予定はありません。「今すぐ録音」から始められます。</div>'; return; }
      var nextIdx = -1;
      list.forEach(function (ev, i) { if (nextIdx < 0 && Date.parse(ev.end.dateTime) > now) nextIdx = i; });
      box.innerHTML = '';
      list.forEach(function (ev, i) {
        var s = new Date(ev.start.dateTime), e = new Date(ev.end.dateTime), people = eventPeople(ev), past = Date.parse(ev.end.dateTime) <= now;
        var row = document.createElement('div'); row.className = 'event-row';
        row.innerHTML = '<div class="event-time"><b>' + hm(s) + '</b><span class="note">〜 ' + hm(e) + '</span></div>' +
          '<div class="event-main"><div class="event-title">' + (i === nextIdx ? '<span class="pill pill-blue">次の予定</span>' : '') + (past ? '<span class="pill pill-gray">終了</span>' : '') + '<span>' + esc(ev.summary || '（件名なし）') + '</span></div>' +
          '<div class="event-meta"><span>' + esc(detectFormat(ev)) + '</span><span>参加者 ' + people.length + '人</span><span>' + esc(people.slice(0, 3).join('・') + (people.length > 3 ? ' ほか' + (people.length - 3) + '人' : '')) + '</span></div></div>';
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + (i === nextIdx ? 'btn-primary' : 'btn-outline'); b.textContent = 'この予定で録音';
        b.addEventListener('click', function () { openPrepare({ title: ev.summary || '', start: s, end: e, format: detectFormat(ev), people: people }); });
        row.appendChild(b); box.appendChild(row);
      });
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">予定を読み込めませんでした（' + esc(errText(e)) + '）。「今すぐ録音」から始められます。</div>';
    });
  }

  function loadRecent(q) {
    var box = $('#recent');
    box.innerHTML = '<div class="note">読み込んでいます…</div>';
    var query = "appProperties has { key='minutesApp' and value='1' } and trashed=false";
    if (q) query += " and fullText contains '" + q.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    gfetch('https://www.googleapis.com/drive/v3/files?pageSize=' + (q ? 30 : 6) + '&orderBy=createdTime desc&fields=files(id,name,webViewLink,createdTime,description)&q=' + encodeURIComponent(query)).then(function (j) {
      var files = j.files || [];
      if (!files.length) { box.innerHTML = '<div class="note">' + (q ? '見つかりませんでした。' : 'まだ議事録はありません。最初の会議を録音してみましょう。') + '</div>'; return; }
      box.innerHTML = files.map(function (f) {
        var d = new Date(f.createdTime);
        return '<a class="card doc-card" href="' + esc(f.webViewLink) + '" target="_blank" rel="noopener"><span class="note">' + esc(jDate(d)) + '</span>' +
          '<span class="t">' + esc(f.name.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/_議事録$/, '')) + '</span><span class="s">' + esc(f.description || '') + '</span><span class="open">Googleドキュメントを開く</span></a>';
      }).join('');
    }).catch(function (e) { box.innerHTML = '<div class="note">読み込めませんでした（' + esc(errText(e)) + '）</div>'; });
  }
  $('#searchForm').addEventListener('submit', function (e) { e.preventDefault(); loadRecent($('#searchInput').value.trim()); });

  // ============================================================ 2 録音の準備
  var canMix = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  var prep = { format: '対面', source: 'mic', people: [] };

  function openPrepare(ev) {
    var now = new Date();
    $('#fTitle').value = ev ? ev.title : '';
    $('#fWhen').value = ev ? jDate(ev.start) + ' ' + hm(ev.start) + '〜' + hm(ev.end) : jDate(now) + ' ' + hm(now) + '〜';
    prep.people = ev ? ev.people.slice() : (S.user ? [S.user.name] : []);
    setFormat(ev ? ev.format : '対面');
    setSource(canMix && prep.format !== '対面' ? 'mix' : 'mic');
    $('#prepHint').textContent = ev ? 'カレンダーの予定から自動で入力しました。違うところだけ直してください。' : 'タイトルと参加者を入れてください。';
    $$('.consent').forEach(function (c) { c.checked = false; });
    $('#mixUnavailable').hidden = canMix; $('#srcMix').hidden = !canMix;
    $('#startError').hidden = true;
    renderChips(); updateStart();
    show('prepare');
  }
  function setFormat(v) { prep.format = v; $$('#fFormat button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === v)); }); }
  function setSource(v) { prep.source = canMix ? v : 'mic'; $$('[data-src]').forEach(function (b) { b.setAttribute('aria-checked', String(b.dataset.src === prep.source)); }); }
  $$('#fFormat button').forEach(function (b) { b.addEventListener('click', function () { setFormat(b.dataset.v); if (canMix) setSource(b.dataset.v === '対面' ? 'mic' : 'mix'); }); });
  $$('[data-src]').forEach(function (b) { b.addEventListener('click', function () { setSource(b.dataset.src); }); });

  function renderChips() {
    var box = $('#chips'), input = $('#chipInput');
    $$('.chip', box).forEach(function (c) { c.remove(); });
    prep.people.forEach(function (name, i) {
      var c = document.createElement('span'); c.className = 'chip'; c.textContent = name;
      var x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', name + 'を外す'); x.textContent = '×';
      x.addEventListener('click', function () { prep.people.splice(i, 1); renderChips(); });
      c.appendChild(x); box.insertBefore(c, input);
    });
    $('#peopleCount').textContent = '（' + prep.people.length + '人）';
  }
  function addChipFromInput() {
    var input = $('#chipInput');
    input.value.split(/[,、，]/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (n) { if (prep.people.indexOf(n) < 0) prep.people.push(n); });
    input.value = ''; renderChips();
  }
  $('#chipInput').addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' && !e.isComposing) || e.key === ',' || e.key === '、') { e.preventDefault(); addChipFromInput(); }
    else if (e.key === 'Backspace' && !this.value && prep.people.length) { prep.people.pop(); renderChips(); }
  });
  $('#chipInput').addEventListener('blur', addChipFromInput);
  $('#chips').addEventListener('click', function (e) { if (e.target === this) $('#chipInput').focus(); });

  function updateStart() {
    var ok = $$('.consent').every(function (c) { return c.checked; });
    var b = $('#btnStart'); b.disabled = !ok;
    b.innerHTML = ok ? '<span style="width:12px;height:12px;border-radius:50%;background:#fff"></span>録音を開始' : '確認の3点にチェックすると開始できます';
  }
  $$('.consent').forEach(function (c) { c.addEventListener('change', updateStart); });
  $('#btnStart').addEventListener('click', function () { addChipFromInput(); startRecording(); });

  // ============================================================ 3 録音
  var R = null;            // 録音中の状態
  var cap = null;          // 字幕
  var wakeLock = null;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function pickMime() {
    var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < c.length; i++) { if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i]; }
    return '';
  }
  function stopTracks(list) { list.forEach(function (s) { try { if (s.getTracks) s.getTracks().forEach(function (t) { t.stop(); }); else if (s.close) s.close(); } catch (e) {} }); }

  function getStream(source) {
    var extra = [];
    if (DEMO && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return Promise.resolve(silentStream(extra)).then(function (s) { return { stream: s, extra: extra }; });
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(function (e) {
      if (DEMO) return silentStream(extra);
      throw new Error('マイクを使えませんでした（' + (e.name === 'NotAllowedError' ? 'ブラウザのマイク許可を確認してください' : e.name || e) + '）');
    }).then(function (mic) {
      extra.push(mic);
      if (source !== 'mix') return { stream: mic, extra: extra };
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(function (disp) {
        extra.push(disp);
        if (!disp.getAudioTracks().length) throw new Error('会議の音声が共有されていません。共有画面で「タブの音声も共有する」または「システム音声を共有」をオンにしてください');
        var ctx = new (window.AudioContext || window.webkitAudioContext)(), dest = ctx.createMediaStreamDestination();
        if (ctx.state === 'suspended') ctx.resume();   // 画面共有の後は止まった状態で作られることがある
        ctx.createMediaStreamSource(mic).connect(dest);
        ctx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())).connect(dest);
        extra.push({ close: function () { ctx.close(); } });
        disp.getVideoTracks().forEach(function (t) { t.addEventListener('ended', function () { if (R && !R.stopped) toast('画面共有が止められました。会議の音声が録れていない可能性があります', true); }); });
        return { stream: dest.stream, extra: extra };
      }, function (e) {
        stopTracks(extra);
        throw new Error(e && e.name === 'NotAllowedError' ? '画面共有がキャンセルされました。会議の音声を録るには共有が必要です' : '会議の音声を取り込めませんでした（' + errText(e) + '）');
      });
    });
  }
  function silentStream(extra) {   // 見本モード用：無音の音声
    var ctx = new (window.AudioContext || window.webkitAudioContext)(), dest = ctx.createMediaStreamDestination(), osc = ctx.createOscillator(), g = ctx.createGain();
    g.gain.value = 0.0001; osc.connect(g); g.connect(dest); osc.start();
    extra.push({ close: function () { ctx.close(); } });
    return dest.stream;
  }

  function startRecording() {
    var btn = $('#btnStart'); btn.disabled = true; $('#startError').hidden = true;
    getStream(prep.source).then(function (got) {
      var title = $('#fTitle').value.trim() || '無題の打合せ';
      S.m = {
        title: title, when: $('#fWhen').value.trim(), format: prep.format, people: prep.people.slice(), lang: $('#fLang').value,
        source: prep.source, startedAt: new Date(), segs: [], marks: [], memo: '', speakerNotes: '', summary: null, names: {}, edited: false, saved: null
      };
      R = { stream: got.stream, extra: got.extra, mime: pickMime(), recorder: null, seg: 0, active: 0, lastTick: Date.now(), segStartActive: 0, paused: false, stopped: false };
      $('#memo').value = ''; $('#capLines').innerHTML = ''; renderMarks(); renderSegList();
      $('#recTitle').textContent = title;
      $('#recMeta').textContent = (prep.source === 'mix' ? 'マイク＋会議の音声' : 'マイクのみ') + ' ・ 参加者' + prep.people.length + '人 ・ ' + (S.m.lang === 'en' ? '英語' : '日本語');
      attachMeter(got.stream);
      startSegment();
      R.timer = setInterval(tick, 500);
      requestWakeLock();
      startCaption();
      setPaused(false);
      show('recording');
    }).catch(function (e) {
      $('#startError').textContent = errText(e); $('#startError').hidden = false;
    }).then(function () { updateStart(); });
  }

  function tick() {
    if (!R || R.stopped) return;
    var now = Date.now();
    if (!R.paused) R.active += now - R.lastTick;
    R.lastTick = now;
    $('#timer').textContent = hms(R.active / 1000);
    if (!R.paused && R.active - R.segStartActive >= SEG_MS) rotateSegment();
    if (R.active >= MAX_MS) { toast('録音が' + (MAX_MS / 60000) + '分に達したため終了しました'); stopRecording(); }
  }
  function startSegment() {
    var idx = R.seg, offsetSec = Math.round(R.active / 1000), chunks = [];
    var r = R.mime ? new MediaRecorder(R.stream, { mimeType: R.mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(R.stream);
    r.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    r.onstop = function () {
      var lenSec = Math.round((R ? (r._endActive || R.active) : 0) / 1000) - offsetSec;
      handleSegment(new Blob(chunks, { type: r.mimeType || R.mime || 'audio/webm' }), idx, offsetSec, lenSec);
    };
    r.start(5000);
    R.recorder = r; R.segStartActive = R.active;
    S.m.segs[idx] = { idx: idx, offsetSec: offsetSec, status: '録音中' };
    renderSegList();
  }
  function rotateSegment() {
    R.recorder._endActive = R.active;
    R.recorder.stop(); R.seg++; startSegment();
  }
  function setPaused(p) {
    R.paused = p;
    try { if (p) R.recorder.pause(); else if (R.recorder.state === 'paused') R.recorder.resume(); } catch (e) {}
    $('#recDot').classList.toggle('live', !p); $('#recDot').style.background = p ? 'var(--faint)' : 'var(--rec)';
    $('#recLabel').textContent = p ? '一時停止中' : '録音中'; $('#recLabel').classList.toggle('paused', p);
    $('#btnPause').textContent = p ? '再開' : '一時停止';
    if (p) stopCaption(); else if (R.started) startCaption();
    R.started = true;
  }
  $('#btnPause').addEventListener('click', function () { if (R && !R.stopped) setPaused(!R.paused); });
  $('#btnMark').addEventListener('click', function () {
    if (!R || R.stopped) return;
    var t = hms(R.active / 1000); S.m.marks.push(t); renderMarks(); toast('「ここ重要」を ' + t + ' に付けました');
  });
  function renderMarks() {
    var marks = S.m ? S.m.marks : [];
    $('#markCount').textContent = '（' + marks.length + '件）';
    $('#markList').innerHTML = marks.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
  }
  $('#memo').addEventListener('input', function () { if (S.m) S.m.memo = this.value; });
  $('#btnStop').addEventListener('click', function () {
    if (!R || R.stopped) return;
    if (R.active < 3000) { toast('録音が短すぎます。もう少し録音してから終了してください', true); return; }
    if (confirm('録音を終了して仕上げに進みますか？')) stopRecording();
  });

  function stopRecording() {
    if (!R || R.stopped) return;
    R.stopped = true; clearInterval(R.timer);
    R.recorder._endActive = R.active;
    try { R.recorder.stop(); } catch (e) {}
    stopCaption(); releaseWakeLock(); if (R.meterStop) R.meterStop();
    stopTracks(R.extra);
    S.m.durationSec = Math.round(R.active / 1000);
    openFinish();
  }

  function attachMeter(stream) {
    var lv = $('#level'); lv.innerHTML = new Array(13).join('<i></i>');
    var bars = $$('i', lv);
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
      an.fftSize = 256; src.connect(an);
      var data = new Uint8Array(an.frequencyBinCount), alive = true;
      (function loop() {
        if (!alive) return;
        an.getByteFrequencyData(data);
        bars.forEach(function (b, i) { var v = data[2 + i * 3] || 0; b.style.height = (R && R.paused ? 4 : Math.max(4, Math.round(v / 255 * 28))) + 'px'; });
        requestAnimationFrame(loop);
      })();
      R.meterStop = function () { alive = false; try { ctx.close(); } catch (e) {} };
    } catch (e) {}
  }

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && R && !R.stopped) requestWakeLock(); });

  // 字幕（録音している音＝マイク＋会議の音声を速報で。保存しない）
  // 新しいChromeは start(音声トラック) で、マイク以外の音も字幕にできる。古いChromeは引数を無視してマイクだけになる
  function startCaption() {
    if (!SR || !S.m) { $('#capNote').textContent = 'このブラウザは字幕に対応していません。録音と書き起こしは続いています。'; return; }
    stopCaption();
    cap = { sr: new SR(), on: true, interim: null };
    var sr = cap.sr, box = $('#capLines');
    sr.lang = S.m.lang === 'en' ? 'en-US' : 'ja-JP'; sr.continuous = true; sr.interimResults = true;
    sr.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { var p = document.createElement('p'); p.textContent = t; box.insertBefore(p, cap.interim); } else interim += t;
      }
      if (!cap.interim) { cap.interim = document.createElement('p'); cap.interim.className = 'interim'; box.appendChild(cap.interim); }
      cap.interim.textContent = interim;
      while (box.children.length > 14) box.removeChild(box.firstChild);
    };
    sr.onerror = function (e) { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { cap.on = false; $('#capNote').textContent = '字幕は使えませんでした（ブラウザの許可）。録音と書き起こしは続いています。'; } };
    var me = cap, src = R && R.stream && R.stream.getAudioTracks()[0];
    function go() {
      if (src && src.readyState === 'live' && me.useTrack !== false) {
        try { me.track = me.track && me.track.readyState === 'live' ? me.track : src.clone(); sr.start(me.track); me.useTrack = true; return; } catch (e) { me.useTrack = false; }
      }
      try { sr.start(); } catch (x) {}
    }
    sr.onend = function () { if (me.on && cap === me) setTimeout(function () { if (me.on && cap === me) go(); }, 300); };
    var baseErr = sr.onerror;
    sr.onerror = function (e) { if (me.useTrack && (e.error === 'audio-capture' || e.error === 'not-allowed')) { me.useTrack = false; return; } baseErr(e); };
    go();
    $('#capNote').textContent = S.m.source === 'mix' ? '字幕は速報です。相手の声が出ない場合は、お使いのChromeが未対応です（議事録には入ります）。' : '字幕は速報です。正式な書き起こしは終了後にAIが作ります。';
  }
  function stopCaption() { if (cap) { cap.on = false; try { cap.sr.stop(); } catch (e) {} if (cap.track) { try { cap.track.stop(); } catch (e) {} } cap = null; } }

  // ============================================================ 区間の書き起こし（順番に、失敗しても音声は手元に残す）
  var queue = Promise.resolve();
  function handleSegment(blob, idx, offsetSec, lenSec) {
    var seg = S.m.segs[idx] || (S.m.segs[idx] = { idx: idx, offsetSec: offsetSec });
    seg.blob = blob; seg.lenSec = lenSec;
    if (lenSec < MIN_SEG_SEC && idx > 0) { seg.status = '省略'; seg.note = '数秒だけの区間のため省略'; delete seg.blob; renderSegList(); checkAllSettled(); return; }
    seg.status = '待機'; renderSegList();
    queue = queue.then(function () { return transcribeSeg(seg); });
  }
  function transcribeSeg(seg) {
    seg.status = '処理中'; seg.error = ''; renderSegList();
    var kb = Math.round(seg.blob.size / 1024);
    return blobToBase64(seg.blob).then(function (b64) {
      var req = { audio: b64, mimeType: seg.blob.type, lang: S.m.lang, offsetSec: seg.offsetSec, prevNotes: S.m.speakerNotes, speakerCount: S.m.people.length };
      // 通信の失敗（Failed to fetch）は1回だけ自動でやり直す
      return api('transcribe', req).catch(function (e) {
        if (!/fetch|network|load failed/i.test(errText(e))) throw e;
        return sleep(8000).then(function () { return api('transcribe', req); });
      }).catch(function (e) { throw new Error(errText(e) + '（音声 ' + kb + 'KB）'); });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.error || ('HTTP ' + r.code));
      var utter = (r.result && r.result.utterances) || [];
      seg.diag = '音声 ' + Math.round(seg.blob.size / 1024) + 'KB ・ ' + (r.model || '') + (r.finishReason ? ' ・ ' + r.finishReason : '') + ' ・ 返答キー ' + Object.keys(r.result || {}).join('/');
      if (!utter.length) throw new Error('AIが発言を1件も返しませんでした（' + seg.diag + '）');
      seg.utter = utter; seg.model = r.model; seg.status = '完了';
      if (r.result.speakerNotes) S.m.speakerNotes = r.result.speakerNotes;
      delete seg.blob;
    }).catch(function (e) {
      seg.status = '失敗'; seg.error = errText(e);
    }).then(function () { renderSegList(); checkAllSettled(); });
  }
  function blobToBase64(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1] || ''); }; r.onerror = rej; r.readAsDataURL(blob); });
  }
  function segLabel(s) { var a = s.offsetSec, b = s.lenSec != null ? a + s.lenSec : null; return hms(a).slice(0, 5 + (a >= 3600 ? 3 : 0)).replace(/^00:/, '') + '〜' + (b != null ? hms(b).replace(/^00:/, '') : ''); }
  function segCounts() {
    var segs = S.m ? S.m.segs.filter(Boolean) : [];
    var done = segs.filter(function (s) { return s.status === '完了' || s.status === '省略'; }).length;
    return { all: segs.length, done: done, failed: segs.filter(function (s) { return s.status === '失敗'; }), busy: segs.some(function (s) { return s.status === '待機' || s.status === '処理中' || s.status === '録音中'; }) };
  }
  function renderSegList() {
    if (!S.m) return;
    var segs = S.m.segs.filter(Boolean), c = segCounts();
    var cls = { '完了': 'st-ok', '失敗': 'st-ng' };
    $('#segList').innerHTML = segs.map(function (s) {
      var st = s.status === '録音中' ? '録音中' : s.status === '処理中' ? '書き起こし中' : s.status;
      return '<li><span>' + esc(segLabel(s)) + '</span><span class="' + (cls[s.status] || 'st-wait') + '">' + esc(st) + '</span></li>';
    }).join('');
    $('#progBar').style.width = (c.all ? Math.round(c.done / c.all * 100) : 0) + '%';
    if (S.screen === 'finish') renderProcessing();
  }

  // ============================================================ 4 仕上げ
  function openFinish() {
    var m = S.m;
    $('#finTitle').textContent = m.title;
    $('#finMeta').textContent = (m.when || jDate(m.startedAt)) + ' ・ ' + m.format + ' ・ 参加者' + m.people.length + '人 ・ 録音 ' + hms(m.durationSec);
    $('#btnSave').disabled = true; $('#speakerBox').hidden = true; $('#reviewBox').hidden = true; $('#procBox').hidden = false;
    show('finish');
    renderProcessing();
  }
  function renderProcessing() {
    var c = segCounts();
    $('#procBar').style.width = (c.all ? Math.round(c.done / c.all * 100) : 0) + '%';
    var fl = $('#failList'); fl.innerHTML = '';
    c.failed.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<span class="st-ng">' + esc(segLabel(s)) + ' の書き起こしに失敗</span><span class="small">' + esc((s.error || '').slice(0, 200)) + '</span>';
      if (s.blob) {   // 録れた音をその場で聞いて確かめられるように（どこにも送らない）
        if (!s.audioUrl) s.audioUrl = URL.createObjectURL(s.blob);
        var au = document.createElement('audio'); au.controls = true; au.src = s.audioUrl; au.style.height = '32px'; row.appendChild(au);
      }
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'やり直す';
      b.addEventListener('click', function () { b.disabled = true; queue = queue.then(function () { return transcribeSeg(s); }); });
      row.appendChild(b); fl.appendChild(row);
    });
    var acts = $('#procActions'); acts.innerHTML = '';
    if (S.m.summary) { $('#procBox').hidden = !c.failed.length && !c.busy; }
    if (c.busy) {
      $('#procTitle').innerHTML = '<span class="spin"></span> 書き起こしを仕上げています…';
      $('#procNote').textContent = c.all + '区間中 ' + c.done + '区間 完了。このまま少しお待ちください（画面は閉じないでください）。';
    } else if (c.failed.length) {
      $('#procTitle').textContent = '一部の区間で書き起こしに失敗しました';
      $('#procNote').textContent = '▶で録れた音を聞けます。音が入っていれば、少し待って「やり直す」を押してください（AIの混雑や取りこぼしのことがあります）。音声はこの画面にだけ残っています。';
      if (!S.m.summary && c.done) {
        var go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-outline'; go.textContent = '失敗した区間を除いて要約する';
        go.addEventListener('click', function () { summarize(); }); acts.appendChild(go);
      }
    } else if (!S.m.summary) {
      $('#procTitle').innerHTML = '<span class="spin"></span> 要約を作っています…';
      $('#procNote').textContent = '書き起こしはすべて終わりました。';
    }
  }
  var summarizing = false;
  function checkAllSettled() {
    if (!S.m || !R || !R.stopped) return;
    var c = segCounts();
    if (S.screen === 'finish') renderProcessing();
    if (!c.busy && !c.failed.length && !S.m.summary && !summarizing) summarize();
  }
  function allUtter() {
    var out = [];
    S.m.segs.filter(Boolean).sort(function (a, b) { return a.idx - b.idx; }).forEach(function (s) { (s.utter || []).forEach(function (u) { out.push(u); }); });
    return out;
  }
  function summarize() {
    var u = allUtter();
    if (!u.length) {
      $('#procTitle').textContent = '書き起こせる発言がありませんでした'; $('#procNote').textContent = 'マイクに音が入っていたか確認してください。';
      var h = document.createElement('button'); h.type = 'button'; h.className = 'btn btn-outline'; h.textContent = 'ホームに戻る';
      h.addEventListener('click', function () { S.m.saved = true; goHome(); }); $('#procActions').innerHTML = ''; $('#procActions').appendChild(h);
      return;
    }
    summarizing = true;
    $('#procBox').hidden = false; $('#procTitle').innerHTML = '<span class="spin"></span> 要約を作っています…'; $('#procActions').innerHTML = '';
    var text = u.map(function (x) { return '[' + x.start + '] ' + x.speaker + '：' + x.text; }).join('\n');
    return api('summarize', { text: text, lang: S.m.lang }).then(function (r) {
      if (!r.ok) throw new Error(r.error || ('HTTP ' + r.code));
      S.m.summary = r.result; S.m.edited = false;
      buildSpeakerSelects(); renderMinutes(); renderTranscript();
      $('#speakerBox').hidden = false; $('#reviewBox').hidden = false; $('#btnSave').disabled = false;
      renderProcessing();
    }).catch(function (e) {
      $('#procTitle').textContent = '要約に失敗しました';
      $('#procNote').textContent = errText(e);
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary'; b.textContent = 'もう一度要約する';
      b.addEventListener('click', function () { summarize(); }); $('#procActions').innerHTML = ''; $('#procActions').appendChild(b);
    }).then(function () { summarizing = false; });
  }
  $('#btnResummary').addEventListener('click', function () {
    if (S.m.edited && !confirm('手直しした内容は元に戻ります。要約を作り直しますか？')) return;
    S.m.summary = null; $('#btnSave').disabled = true; summarize();
  });

  function speakers() { var s = {}; allUtter().forEach(function (u) { s[u.speaker] = true; }); return Object.keys(s).sort(); }
  function colorOf(sp) { var i = speakers().indexOf(sp); return SPEAKER_COLORS[(i < 0 ? 0 : i) % SPEAKER_COLORS.length]; }
  function buildSpeakerSelects() {
    var box = $('#speakerSelects'); box.innerHTML = '';
    var used = {};
    speakers().forEach(function (sp, i) {
      // 初期値：参加者の並び順を仮に当てず「そのまま」。本人が選ぶ
      var first = allUtter().filter(function (u) { return u.speaker === sp; })[0];
      var label = document.createElement('label');
      label.innerHTML = '<span class="sdot" style="background:' + colorOf(sp) + '"></span><span>' + esc(sp) + '</span>';
      label.title = first ? '最初の発言：' + first.text.slice(0, 60) : '';
      var sel = document.createElement('select'); sel.dataset.speaker = sp;
      sel.innerHTML = '<option value="">（' + esc(sp) + ' のまま）</option>' + S.m.people.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
      sel.value = S.m.names[sp] || '';
      sel.addEventListener('change', function () {
        if (S.m.edited && !confirm('名前を変えると、議事録の手直しは元に戻ります。よろしいですか？')) { sel.value = S.m.names[sp] || ''; return; }
        if (sel.value) S.m.names[sp] = sel.value; else delete S.m.names[sp];
        renderMinutes(); renderTranscript();
      });
      label.appendChild(sel); box.appendChild(label);
      used[sp] = true;
    });
  }
  /** 「話者A」→ 名前。画面の中だけで行う */
  function nm(text) {
    var map = S.m.names;
    Object.keys(map).sort(function (a, b) { return b.length - a.length; }).forEach(function (sp) { text = String(text).split(sp).join(map[sp]); });
    return text;
  }
  function minutesInnerHtml() {
    var s = S.m.summary;
    var h = [];
    h.push('<section><h2>概要</h2><p>' + esc(nm(s.overview)) + '</p></section>');
    h.push('<section><h2>確認・決定事項</h2>' + (s.agenda.length ? s.agenda.map(function (a, i) {
      return '<div><h3>' + (i + 1) + '. ' + esc(nm(a.title)) + ' <span class="pill ' + (a.decided ? 'pill-blue' : 'pill-gray') + '">' + (a.decided ? '決定' : '共有') + '</span></h3><ul>' + a.points.map(function (p) { return '<li>' + esc(nm(p)) + '</li>'; }).join('') + '</ul></div>';
    }).join('') : '<p>なし</p>') + '</section>');
    h.push('<section><h2>課題・検討事項</h2>' + (s.issues.length ? '<ul>' + s.issues.map(function (x) { return '<li>' + esc(nm(x)) + '</li>'; }).join('') + '</ul>' : '<p>なし</p>') + '</section>');
    h.push('<section><h2>アクション（TODO）</h2>' + (s.todos.length ? '<table><thead><tr><th>タスク</th><th style="width:120px">担当</th><th style="width:110px">期限</th></tr></thead><tbody>' + s.todos.map(function (t) {
      var tbdO = /要確認|TBD/.test(t.owner), tbdD = /要確認|TBD/.test(t.due);
      return '<tr><td>' + esc(nm(t.task)) + (t.note ? '<br><span class="small">' + esc(nm(t.note)) + '</span>' : '') + '</td><td' + (tbdO ? ' class="tbd"' : '') + '>' + esc(nm(t.owner)) + '</td><td' + (tbdD ? ' class="tbd"' : '') + '>' + esc(t.due) + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p>なし</p>') + '</section>');
    h.push('<section><h2>次回</h2><p>' + esc(nm(s.nextMeeting)) + '</p></section>');
    if (S.m.marks.length) h.push('<section><h2>重要な場面</h2><p>' + S.m.marks.map(esc).join('　・　') + '</p></section>');
    if (S.m.memo.trim()) h.push('<section><h2>自分用メモ</h2><p style="white-space:pre-wrap">' + esc(S.m.memo.trim()) + '</p></section>');
    return h.join('');
  }
  function renderMinutes() { $('#minutesBody').innerHTML = minutesInnerHtml(); S.m.edited = false; }
  $('#minutesBody').addEventListener('input', function () { if (S.m) S.m.edited = true; });
  function nearMark(start) {
    var t = toSec(start);
    return S.m.marks.some(function (m) { return Math.abs(toSec(m) - t) <= 15; });
  }
  function toSec(t) { return String(t || '0').split(':').reduce(function (a, x) { return a * 60 + (Number(x) || 0); }, 0); }
  function renderTranscript() {
    var q = $('#tSearch').value.trim();
    var lines = allUtter().filter(function (u) { return !q || (nm(u.text) + nm(u.speaker)).indexOf(q) >= 0; });
    $('#tLines').innerHTML = lines.length ? lines.map(function (u) {
      return '<div class="tline"><span class="ts">' + esc(u.start) + '</span><div style="min-width:0"><div class="who"><span class="sdot" style="background:' + colorOf(u.speaker) + '"></span>' + esc(nm(u.speaker)) +
        (nearMark(u.start) ? ' <span class="pill pill-mark" style="font-weight:400">ここ重要</span>' : '') + '</div><p>' + esc(nm(u.text)) + '</p></div></div>';
    }).join('') : '<p class="note">' + (q ? '見つかりませんでした' : '発言がありません') + '</p>';
  }
  $('#tSearch').addEventListener('input', renderTranscript);

  // ============================================================ 保存（本人のドライブへ）
  function ensureFolder() {
    if (S.folderId) return Promise.resolve(S.folderId);
    var q = "appProperties has { key='minutesAppFolder' and value='1' } and mimeType='application/vnd.google-apps.folder' and trashed=false";
    return gfetch('https://www.googleapis.com/drive/v3/files?fields=files(id,name)&q=' + encodeURIComponent(q)).then(function (j) {
      if (j.files && j.files.length) { S.folderName = j.files[0].name; return (S.folderId = j.files[0].id); }
      return gfetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { minutesAppFolder: '1' } })
      }).then(function (f) { S.folderName = f.name; return (S.folderId = f.id); });
    });
  }
  function multipartUpload(meta, blob) {
    var boundary = 'b' + Math.random().toString(16).slice(2);
    var body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + boundary + '\r\nContent-Type: ' + (blob.type || 'application/octet-stream') + '\r\n\r\n', blob, '\r\n--' + boundary + '--']);
    return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body
    });
  }
  function docHtml() {
    var m = S.m;
    // 画面で手直しした議事録をそのまま使う。見た目の印（pill）はドキュメント向けの文字に置き換える
    var tmp = document.createElement('div'); tmp.innerHTML = $('#minutesBody').innerHTML;
    $$('.pill', tmp).forEach(function (p) { p.outerHTML = '【' + esc(p.textContent) + '】'; });
    $$('th', tmp).forEach(function (th) { th.setAttribute('style', 'background:#2D53A0;color:#ffffff;text-align:left;padding:6px'); });
    $$('td', tmp).forEach(function (td) { td.setAttribute('style', 'border:1px solid #C8C4C5;padding:6px;vertical-align:top'); });
    $$('table', tmp).forEach(function (t) { t.setAttribute('style', 'border-collapse:collapse;width:100%'); t.setAttribute('border', '1'); });
    var meta = '<table border="1" style="border-collapse:collapse;width:100%">' + [
      ['日時', m.when || jDate(m.startedAt)], ['形式', m.format], ['出席', m.people.join('、') || '—'], ['録音時間', hms(m.durationSec)], ['配布区分', '社内限り'], ['記録', S.user ? S.user.name : '']
    ].map(function (r) { return '<tr><td style="border:1px solid #C8C4C5;padding:6px;width:110px;background:#F5F5F5"><b>' + esc(r[0]) + '</b></td><td style="border:1px solid #C8C4C5;padding:6px">' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    var full = allUtter().map(function (u) { return '<p><span style="color:#5A5A5A">[' + esc(u.start) + ']</span> <b>' + esc(nm(u.speaker)) + '</b>：' + esc(nm(u.text)) + (nearMark(u.start) ? ' <span style="color:#8A6A00">【ここ重要】</span>' : '') + '</p>'; }).join('');
    return '<html><head><meta charset="utf-8"></head><body>' +
      '<h1>' + esc(m.title) + '</h1>' + meta + tmp.innerHTML +
      '<hr><h2>全文書き起こし</h2>' + full +
      '<p style="color:#5A5A5A"><i>AI（Gemini）による自動作成です。固有名詞・数字は確認し、社外に出す前に人が内容を確認して書き直してください。</i></p>' +
      '</body></html>';
  }
  $('#btnSave').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    var m = S.m;
    var name = isoDate(m.startedAt) + '_' + m.title.replace(/[\\/:*?"<>|]/g, '_') + '_議事録';
    var desc = String(m.summary.overview || '').slice(0, 140);
    ensureToken().then(ensureFolder).then(function (fid) {
      return multipartUpload({ name: name, mimeType: 'application/vnd.google-apps.document', parents: [fid], description: desc, appProperties: { minutesApp: '1' } }, new Blob([docHtml()], { type: 'text/html' }));
    }).then(function (f) {
      m.saved = f;
      $('#savedName').textContent = f.name; $('#savedOpen').href = f.webViewLink;
      $('#savedFolder').textContent = 'マイドライブ ／ ' + (S.folderName || FOLDER_NAME);
      show('saved');
    }).catch(function (e) { toast('保存できませんでした：' + errText(e), true); btn.disabled = false; });
  });
  $('#btnCopyLink').addEventListener('click', function () {
    var link = S.m && S.m.saved && S.m.saved.webViewLink; if (!link) return;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast('リンクをコピーしました'); }, function () { prompt('このリンクをコピーしてください', link); });
  });

  // ============================================================ 閉じる前の確認
  window.addEventListener('beforeunload', function (e) {
    var unsaved = S.m && !S.m.saved && (S.screen === 'recording' || S.screen === 'finish');
    if (unsaved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ============================================================ 見本モード（?demo=1）：Google・裏側APIにつながない
  function demoApi(action, p) {
    var wait = action === 'login' ? 300 : 1500;
    return sleep(wait).then(function () {
      if (action === 'login') return { ok: true, email: 'demo@' + (CFG.allowedDomain || 'example.com'), session: 'demo' };
      if (action === 'transcribe') {
        var base = p.offsetSec, n = Math.max(2, Math.min(3, p.speakerCount || 3)), L = ['話者A', '話者B', '話者C'].slice(0, n);
        var texts = ['では今月の重点施策から確認していきます。', '新規の提案は今週中に初稿をまとめて、来週水曜に共有します。', '担当をお願いしてもいいですか。', 'はい、先週の資料をベースに作ります。', '顧客リストの更新はどうしましょうか。', '次回までに担当を決めましょう。'];
        var utt = texts.map(function (t, i) { var s = base + i * 9; return { start: hms(s), speaker: L[i % n], text: t }; });
        return { ok: true, model: 'demo', result: { utterances: utt, speakerNotes: '話者A＝司会' } };
      }
      if (action === 'summarize') return { ok: true, model: 'demo', result: {
        overview: '今月の重点施策と新規提案の進め方を確認した。提案書の初稿を来週水曜までに共有することで合意。顧客リストの更新は次回に担当を決める。',
        agenda: [{ title: '新規提案の進め方', points: ['先週の資料をベースに初稿を作る', '来週水曜に共有する'], decided: true }, { title: '今月の重点施策', points: ['既存顧客へのフォローを優先する方針を共有'], decided: false }],
        issues: ['顧客リストの更新担当が未定'], todos: [{ category: '提案', task: '提案書の初稿を作成', owner: '話者B', due: '来週水曜' }, { category: '営業', task: '顧客リストの更新', owner: '要確認', due: '要確認' }],
        nextMeeting: '未定' } };
      return { ok: false, error: 'demo' };
    });
  }
  function demoGoogle(url, opts) {
    return sleep(300).then(function () {
      if (/userinfo/.test(url)) return { name: '見本ユーザー' };
      if (/calendar/.test(url)) {
        var d = new Date(); d.setMinutes(0, 0, 0);
        var mk = function (h, len, title, loc, names) { var s = new Date(d); s.setHours(h); var e = new Date(s.getTime() + len * 60000); return { summary: title, location: loc, start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() }, attendees: names.map(function (n, i) { return { displayName: n, self: i === 0 }; }) }; };
        return { items: [mk(10, 60, '営業部 定例ミーティング', 'https://teams.microsoft.com/l/meetup', ['見本ユーザー', 'まっつん', 'おの']), mk(14, 60, '新規提案 社内レビュー', 'https://zoom.us/j/1', ['見本ユーザー', 'めぐ']), mk(17, 30, 'AIブートキャンプ 振り返り', '会議室A', ['見本ユーザー', 'やっすー', 'もっつ'])] };
      }
      if (/drive\/v3\/files\?pageSize/.test(url)) return { files: [{ id: 'd1', name: isoDate(new Date()) + '_営業部 定例ミーティング_議事録', webViewLink: '#', createdTime: new Date().toISOString(), description: '10月の重点施策を確認。提案書の初稿を来週水曜までに共有することで合意。' }] };
      if (/drive\/v3\/files\?fields=files/.test(url)) return { files: [{ id: 'f1', name: FOLDER_NAME }] };
      if (/upload/.test(url)) return { id: 'x', name: '（見本）保存したドキュメント', webViewLink: '#' };
      return {};
    });
  }
  if (DEMO) { var dl = $('#loginError'); dl.textContent = '見本モードです。Googleにも裏側APIにもつながず、AIの結果は作り物です。'; dl.hidden = false; dl.style.background = '#EEF2FA'; dl.style.color = '#1F3C78'; }

  show('login');
})();
