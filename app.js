/**
 * 議事録アプリ v1.4.0（保存完了画面に試行の感想欄。v1.3：スマホのメニュー・最近の議事録の整理。Step 4：スマホ調整・使い方の画面。Step 3：マイページ・管理者への連絡・再表示・音声保存・途中再開）
 * 画面：GitHub Pages 上の1ページ。裏側：GAS「議事録アプリ_API」（Gemini の窓口）。
 *
 * 守っていること
 *  - Google のドライブ・カレンダーは、ログインした本人の権限で直接扱う（drive.file / drive.appdata / calendar.readonly）
 *    drive.appdata＝ドライブの中の「このアプリ専用の見えない場所」。設定と仕上げ画面の中身（再表示用）を置く
 *  - 裏側APIに送るのは「音声・参加人数・話者A／Bのままの全文」だけ。参加者の名前と自分用メモは送らない
 *  - 名前の置き換えはこの画面の中だけで行う
 *  - ?demo=1 で開くと、Google にも裏側APIにもつながない見本モード（画面確認用）
 */
(function () {
  'use strict';

  var CFG = window.MINUTES_CONFIG || {};
  var DEMO = /[?&]demo=1\b/.test(location.search);
  var VERSION = '1.4.0';
  var IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  var BUSY_RE = /high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|→429|→503|HTTP 429|HTTP 503/i;   // AIの混雑
  var AUTO_RETRY_SEC = [60, 120];   // 混雑のときは画面側でも自動でやり直す（1分後、2分後）
  var SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.readonly';
  var DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var SEG_MS = (Number(CFG.segmentMinutes) || 15) * 60000;
  var MAX_MS = (Number(CFG.maxMinutes) || 90) * 60000;
  var MIN_SEG_SEC = 5;                        // これより短い最後の切れ端は書き起こさない（当て推量を防ぐ）
  var SPEAKER_COLORS = ['#2D53A0', '#DA5C59', '#E0A800', '#3E8A6E', '#7A5BA6', '#5A6B7D', '#B5651D', '#2B8C9E'];
  var FOLDER_NAME = CFG.folderName || '議事録アプリ';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var DEFAULTS = { folder: null, source: 'auto', lang: 'ja', captions: true, calendar: true, audioButton: true, resume: true, recentCount: 3 };
  var S = { user: null, google: { token: '', exp: 0 }, session: '', folderId: null, folderName: '', screen: 'login', m: null, settings: Object.assign({}, DEFAULTS), settingsFileId: null, pendingResume: null };

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
  function toast(msg, ng, reportMsg) {
    var t = $('#toast'); t.textContent = msg; t.className = 'toast' + (ng ? ' ng' : ''); t.hidden = false;
    if (reportMsg) { t.appendChild(document.createTextNode(' ')); var l = reportLink(reportMsg); l.style.color = 'inherit'; t.appendChild(l); }
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, reportMsg ? 15000 : ng ? 7000 : 3500);
  }
  function errText(e) { return (e && (e.message || e)) || String(e); }
  function show(name) {
    $$('[data-screen]').forEach(function (el) { el.hidden = el.dataset.screen !== name; });
    $('#appHeader').hidden = name === 'login';
    var step = { prepare: 1, recording: 2, finish: 3 }[name];
    $('#stepper').hidden = !step; $('#mainNav').hidden = name === 'recording'; $('#navHome').classList.toggle('active', name === 'home'); $('#navMy').classList.toggle('active', name === 'mypage'); $('#navHelp').classList.toggle('active', name === 'help');
    $$('#stepper li').forEach(function (li) { li.classList.toggle('on', Number(li.dataset.step) === step); });
    S.screen = name; window.scrollTo(0, 0);
    closeMenu(); $('#btnMenu').hidden = name === 'recording';
    $$('#menuPanel [data-nav]').forEach(function (b) { b.toggleAttribute('aria-current', { home: 'home', mypage: 'my', help: 'help' }[name] === b.dataset.nav); if (b.hasAttribute('aria-current')) b.setAttribute('aria-current', 'page'); });
  }
  // スマホのメニュー（ハンバーガー）
  function closeMenu() { var p = $('#menuPanel'); if (p) { p.hidden = true; $('#btnMenu').setAttribute('aria-expanded', 'false'); } }
  $('#btnMenu').addEventListener('click', function (e) {
    e.stopPropagation();
    var open = $('#menuPanel').hidden;
    $('#menuPanel').hidden = !open; this.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('#menuPanel') && !e.target.closest('#btnMenu')) closeMenu(); });
  $$('#menuPanel [data-nav]').forEach(function (b) {
    b.addEventListener('click', function () {
      var to = b.dataset.nav; closeMenu();
      if (to === 'logout') { $('#btnLogout').click(); return; }
      if (!canLeave()) return;
      if (to === 'home') goHome(); else if (to === 'my') openMy(); else show('help');
    });
  });
  $$('[data-go="home"]').forEach(function (b) { b.addEventListener('click', function () { goHome(); }); });
  /** 仕上げ画面などから離れてよいか。録音中は不可、未保存なら確認する */
  function canLeave() {
    if (S.screen === 'recording') { toast('録音中は移動できません。先に「終了」を押してください', true); return false; }
    if (S.screen === 'finish' && S.m && !S.m.viewing && !S.m.saved) {
      if (!confirm('まだ保存していません。移動すると、この議事録は消えます。移動しますか？')) return false;
      S.m.saved = true; clearBackup();
    }
    if (S.screen === 'finish' && S.m && S.m.viewing && S.m.edited && !confirm('手直しした内容はドキュメントに反映されていません。移動しますか？')) return false;
    return true;
  }
  function homeClick(e) { e.preventDefault(); if (canLeave()) goHome(); }
  $('#navHome').addEventListener('click', homeClick);
  $('#navMy').addEventListener('click', function (e) { e.preventDefault(); if (canLeave()) openMy(); });
  $('#navHelp').addEventListener('click', function (e) { e.preventDefault(); if (canLeave()) show('help'); });
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
    }).then(loadSettings).then(function () {
      $('#userName').textContent = S.user.name; $('#userInitial').textContent = S.user.name.slice(0, 1);
      $('#menuName').textContent = S.user.name; $('#menuInitial').textContent = S.user.name.slice(0, 1); $('#menuEmail').textContent = S.user.email;
      goHome();
    }).catch(function (e) {
      box.textContent = errText(e); box.hidden = false;
    }).then(function () { btn.disabled = false; });
  });
  $('#btnLogout2').addEventListener('click', function () { $('#btnLogout').click(); });
  $('#btnLogout').addEventListener('click', function () {
    if (S.screen === 'recording') { toast('録音中はログアウトできません', true); return; }
    if (window.google && google.accounts && google.accounts.oauth2 && S.google.token && !DEMO) { try { google.accounts.oauth2.revoke(S.google.token, function () {}); } catch (e) {} }
    S.google = { token: '', exp: 0 }; S.session = ''; S.user = null; S.folderId = null; S.m = null;
    S.settings = Object.assign({}, DEFAULTS); S.settingsFileId = null; S.pendingResume = null;
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
    $('#eventsCard').hidden = !S.settings.calendar;
    if (S.settings.calendar) loadEvents();
    loadRecent(''); checkResume();
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
      noteError('カレンダー', e);
      box.innerHTML = '<div class="empty">予定を読み込めませんでした（' + esc(errText(e)) + '）。「今すぐ録音」から始められます。</div>';
    });
  }

  var recentState = { q: '', token: '', rmap: null };
  function loadRecent(q, more) {
    var box = $('#recent'), count = Number(S.settings.recentCount);
    if (isNaN(count)) count = 3;
    $('#recentSection').hidden = false;
    $('#recent').hidden = !q && count === 0;
    $('#btnMoreRecent').hidden = true;
    if (!q && count === 0) return;   // 表示しない設定（検索窓だけ残す）
    if (!more) { recentState = { q: q, token: '', rmap: null }; box.innerHTML = '<div class="note">読み込んでいます…</div>'; }
    var query = "appProperties has { key='minutesApp' and value='1' } and trashed=false";
    if (q) query += " and fullText contains '" + q.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    var docs = gfetch(DRIVE + '/files?pageSize=' + (q ? 30 : count) + (more && recentState.token ? '&pageToken=' + encodeURIComponent(recentState.token) : '') +
      '&orderBy=createdTime desc&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=nextPageToken,files(id,name,webViewLink,createdTime,description)&q=' + encodeURIComponent(query));
    // 仕上げ画面の中身（再表示用）が残っている議事録を調べる
    var results = recentState.rmap ? Promise.resolve(recentState.rmap) : gfetch(DRIVE + '/files?spaces=appDataFolder&pageSize=1000&fields=files(id,appProperties)&q=' + encodeURIComponent("appProperties has { key='kind' and value='result' }"))
      .then(function (j) { var map = {}; (j.files || []).forEach(function (f) { if (f.appProperties && f.appProperties.docId) map[f.appProperties.docId] = f.id; }); return (recentState.rmap = map); })
      .catch(function () { return {}; });
    Promise.all([docs, results]).then(function (all) {
      var files = all[0].files || [], rmap = all[1];
      recentState.token = all[0].nextPageToken || '';
      if (!more) box.innerHTML = '';
      if (!files.length && !more) { box.innerHTML = '<div class="note">' + (q ? '見つかりませんでした。' : 'まだ議事録はありません。最初の会議を録音してみましょう。') + '</div>'; return; }
      files.forEach(function (f) {
        var d = new Date(f.createdTime), rid = rmap[f.id];
        var card = document.createElement('div'); card.className = 'card doc-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
        card.innerHTML = '<span class="note">' + esc(jDate(d)) + '</span><span class="t">' + esc(f.name.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/_議事録$/, '')) + '</span><span class="s">' + esc(f.description || '') + '</span>' +
          (rid ? '<span class="acts"><span class="open">仕上げ画面で開く</span><a href="' + esc(f.webViewLink) + '" target="_blank" rel="noopener">ドキュメント</a></span>' : '<span class="open">Googleドキュメントを開く</span>') +
          '<button type="button" class="card-more" aria-label="この議事録のメニュー">…</button>';
        var go = function (e) {
          if (e.target.closest('a') || e.target.closest('.card-more')) return;
          if (rid) openResult(rid, f); else window.open(f.webViewLink, '_blank', 'noopener');
        };
        card.addEventListener('click', go);
        card.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === card) go(e); });
        $('.card-more', card).addEventListener('click', function (e) { e.stopPropagation(); openCardMenu(this, f, rid); });
        box.appendChild(card);
      });
      $('#btnMoreRecent').hidden = q || !recentState.token;
    }).catch(function (e) { noteError('最近の議事録', e); box.innerHTML = '<div class="note">読み込めませんでした（' + esc(errText(e)) + '）</div>'; });
  }
  $('#searchForm').addEventListener('submit', function (e) { e.preventDefault(); loadRecent($('#searchInput').value.trim()); });
  $('#btnMoreRecent').addEventListener('click', function () { loadRecent(recentState.q, true); });

  // カードの「…」メニュー：一覧から外す（ドキュメントは残す）／ゴミ箱に移す（30日以内は戻せる）
  var cardTarget = null;
  function openCardMenu(btn, f, rid) {
    var m = $('#cardMenu'), r = btn.getBoundingClientRect();
    cardTarget = { f: f, rid: rid };
    m.hidden = false;
    m.style.top = (window.scrollY + r.bottom + 4) + 'px';
    m.style.left = Math.max(8, Math.min(window.scrollX + r.right - m.offsetWidth, window.scrollX + document.documentElement.clientWidth - m.offsetWidth - 8)) + 'px';
  }
  function closeCardMenu() { $('#cardMenu').hidden = true; }
  document.addEventListener('click', function (e) { if (!e.target.closest('#cardMenu') && !e.target.closest('.card-more')) closeCardMenu(); });
  window.addEventListener('resize', closeCardMenu);
  $$('#cardMenu [data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = cardTarget, act = b.dataset.act; closeCardMenu(); if (!t) return;
      var title = t.f.name.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/_議事録$/, '');
      if (act === 'trash' && !confirm('「' + title + '」をゴミ箱に移します。30日以内ならGoogleドライブのゴミ箱から戻せます。よろしいですか？')) return;
      if (act === 'hide' && !confirm('「' + title + '」を一覧から外します。ドキュメントはドライブに残ります。よろしいですか？')) return;
      var body = act === 'trash' ? { trashed: true } : { appProperties: { minutesApp: null } };
      ensureToken().then(function () {
        return gfetch(DRIVE + '/files/' + t.f.id + '?supportsAllDrives=true&fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }).then(function () {
        // 仕上げ画面の中身（再表示用）も片付ける
        if (t.rid) return gfetch(DRIVE + '/files/' + t.rid, { method: 'DELETE' }).catch(function () {});
      }).then(function () {
        toast(act === 'trash' ? 'ゴミ箱に移しました' : '一覧から外しました');
        loadRecent(recentState.q);
      }).catch(function (e) { noteError('最近の議事録の整理', e); toast('できませんでした：' + errText(e), true); });
    });
  });

  // ============================================================ 2 録音の準備
  var canMix = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  var prep = { format: '対面', source: 'mic', people: [] };

  function openPrepare(ev) {
    var now = new Date();
    $('#fTitle').value = ev ? ev.title : '';
    $('#fWhen').value = ev ? jDate(ev.start) + ' ' + hm(ev.start) + '〜' + hm(ev.end) : jDate(now) + ' ' + hm(now) + '〜';
    prep.people = ev ? ev.people.slice() : (S.user ? [S.user.name] : []);
    setFormat(ev ? ev.format : '対面');
    setSource(defaultSource(prep.format));
    $('#fLang').value = S.settings.lang || 'ja';
    $('#prepHint').textContent = ev ? 'カレンダーの予定から自動で入力しました。違うところだけ直してください。' : 'タイトルと参加者を入れてください。';
    $$('.consent').forEach(function (c) { c.checked = false; });
    $('#mixUnavailable').hidden = canMix; $('#srcMix').hidden = !canMix;
    $('#startError').hidden = true;
    renderChips(); updateStart();
    show('prepare');
  }
  function defaultSource(format) {
    var st = S.settings.source;
    if (!canMix) return 'mic';
    if (st === 'mix' || st === 'mic') return st;
    return format !== '対面' ? 'mix' : 'mic';
  }
  function setFormat(v) { prep.format = v; $$('#fFormat button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === v)); }); }
  function setSource(v) { prep.source = canMix ? v : 'mic'; $$('[data-src]').forEach(function (b) { b.setAttribute('aria-checked', String(b.dataset.src === prep.source)); }); }
  $$('#fFormat button').forEach(function (b) { b.addEventListener('click', function () { setFormat(b.dataset.v); setSource(defaultSource(b.dataset.v)); }); });
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
    b.innerHTML = ok ? '<span style="width:12px;height:12px;border-radius:50%;background:#fff"></span>録音を開始' : '利用規約に同意すると開始できます';
  }
  $$('.consent').forEach(function (c) { c.addEventListener('change', updateStart); });
  // 利用規約（サブウィンドウ）
  function closeTerms() { var d = $('#termsDlg'); if (d.close) d.close(); else d.removeAttribute('open'); }
  $('#btnTerms').addEventListener('click', function () { var d = $('#termsDlg'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); });
  $('#termsClose').addEventListener('click', closeTerms);
  $('#termsAgree').addEventListener('click', function () { $('#consentTerms').checked = true; updateStart(); closeTerms(); });
  $('#termsDlg').addEventListener('click', function (e) { if (e.target === this) closeTerms(); });   // 外側を押したら閉じる
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
      watchMic(mic);
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
        return { stream: dest.stream, extra: extra, meeting: new MediaStream(disp.getAudioTracks()) };
      }, function (e) {
        stopTracks(extra);
        throw new Error(e && e.name === 'NotAllowedError' ? '画面共有がキャンセルされました。会議の音声を録るには共有が必要です' : '会議の音声を取り込めませんでした（' + errText(e) + '）');
      });
    });
  }
  /** マイクが止まった・一時的に途切れた（スマホで画面を離れた等）ことを知らせる */
  function watchMic(mic) {
    var t = mic.getAudioTracks()[0]; if (!t) return;
    t.addEventListener('mute', function () { if (R && !R.stopped) R.mutedAt = Date.now(); });
    t.addEventListener('unmute', function () {
      if (!R || R.stopped || !R.mutedAt) return;
      var sec = Math.round((Date.now() - R.mutedAt) / 1000); R.mutedAt = 0;
      if (sec >= 2) { noteError('録音の途切れ', sec + '秒'); toast('約' + sec + '秒、マイクの音が途切れていました（画面を離れていた等）。その間は録音されていません', true); }
    });
    t.addEventListener('ended', function () {
      if (!R || R.stopped) return;
      noteError('録音', 'マイクが止まりました');
      toast('マイクが止まったため録音を終了しました。ここまでの分で議事録を作ります', true);
      stopRecording();
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (!R || R.stopped || !IS_TOUCH) return;
    if (document.visibilityState === 'hidden') R.hiddenAt = Date.now();
    else if (R.hiddenAt) {
      var sec = Math.round((Date.now() - R.hiddenAt) / 1000); R.hiddenAt = 0;
      if (sec >= 3) toast('約' + sec + '秒、画面を離れていました。スマホではその間の録音が止まっていることがあります', true);
    }
  });
  var IS_TOUCH = IS_IOS || /Android/i.test(navigator.userAgent);
  function silentStream(extra) {   // 見本モード用：無音の音声
    var ctx = new (window.AudioContext || window.webkitAudioContext)(), dest = ctx.createMediaStreamDestination(), osc = ctx.createOscillator(), g = ctx.createGain();
    g.gain.value = 0.0001; osc.connect(g); g.connect(dest); osc.start();
    extra.push({ close: function () { ctx.close(); } });
    return dest.stream;
  }

  function startRecording() {
    if (S.pendingResume && !confirm('途中で閉じた録音（' + S.pendingResume.title + '）がまだ残っています。新しく録音すると、そちらは消えます。続けますか？')) return;
    var btn = $('#btnStart'); btn.disabled = true; $('#startError').hidden = true;
    getStream(prep.source).then(function (got) {
      var title = $('#fTitle').value.trim() || '無題の打合せ';
      S.m = {
        title: title, when: $('#fWhen').value.trim(), format: prep.format, people: prep.people.slice(), lang: $('#fLang').value,
        source: prep.source, startedAt: new Date(), segs: [], marks: [], memo: '', speakerNotes: '', summary: null, names: {}, edited: false, saved: null,
        id: Date.now().toString(36)
      };
      R = { stream: got.stream, extra: got.extra, mime: pickMime(), recorder: null, seg: 0, active: 0, lastTick: Date.now(), segStartActive: 0, paused: false, stopped: false };
      S.m.mime = R.mime;
      S.pendingResume = null;
      clearBackup().then(backupMeeting);
      // 「音声も保存」用に、会議全体を1本で録っておく（区切りなし。保存ボタンを押した人だけドライブへ）
      if (S.settings.audioButton) {
        try {
          R.full = R.mime ? new MediaRecorder(got.stream, { mimeType: R.mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(got.stream);
          R.fullChunks = []; R.full.ondataavailable = function (e) { if (e.data && e.data.size) R.fullChunks.push(e.data); };
          R.full.start(10000);
        } catch (e) { R.full = null; }
      }
      $('#capPill').textContent = prep.source === 'mix' ? '速報・マイク＋会議の音声' : '速報・マイクの音';
      $('#memo').value = ''; $('#capLines').innerHTML = ''; renderMarks(); renderSegList();
      $('#recTitle').textContent = title;
      $('#recMeta').textContent = (prep.source === 'mix' ? 'マイク＋会議の音声' : 'マイクのみ') + ' ・ 参加者' + prep.people.length + '人 ・ ' + (S.m.lang === 'en' ? '英語' : '日本語');
      attachMeter(got.stream);
      watchMeeting(got.meeting);
      startSegment();
      R.timer = setInterval(tick, 500);
      requestWakeLock();
      startCaption();
      setPaused(false);
      show('recording');
    }).catch(function (e) {
      noteError('録音開始', e);
      var box = $('#startError'); box.textContent = errText(e); box.appendChild(document.createElement('br')); box.appendChild(reportLink('録音を始められない：' + errText(e))); box.hidden = false;
    }).then(function () { updateStart(); });
  }

  function tick() {
    if (!R || R.stopped) return;
    var now = Date.now();
    if (!R.paused) R.active += now - R.lastTick;
    R.lastTick = now;
    $('#timer').textContent = hms(R.active / 1000);
    if (!R.paused && Math.floor(R.active / 1000) % 15 === 0) backupSoon();
    if (!R.paused && R.active - R.segStartActive >= SEG_MS) rotateSegment();
    if (R.active >= MAX_MS) { toast('録音が' + (MAX_MS / 60000) + '分に達したため終了しました'); stopRecording(); }
  }
  function startSegment() {
    var idx = R.seg, offsetSec = Math.round(R.active / 1000), chunks = [];
    var r = R.mime ? new MediaRecorder(R.stream, { mimeType: R.mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(R.stream);
    r.ondataavailable = function (e) { if (e.data && e.data.size) { chunks.push(e.data); backupChunk(idx, e.data); } };
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
    try { if (R.full) { if (p) R.full.pause(); else if (R.full.state === 'paused') R.full.resume(); } } catch (e) {}
    $('#recDot').classList.toggle('live', !p); $('#recDot').style.background = p ? 'var(--faint)' : 'var(--rec)';
    $('#recLabel').textContent = p ? '一時停止中' : '録音中'; $('#recLabel').classList.toggle('paused', p);
    $('#btnPause').textContent = p ? '再開' : '一時停止';
    if (p) stopCaption(); else if (R.started) startCaption();
    R.started = true;
  }
  $('#btnPause').addEventListener('click', function () { if (R && !R.stopped) setPaused(!R.paused); });
  $('#btnMark').addEventListener('click', function () {
    if (!R || R.stopped) return;
    var t = hms(R.active / 1000); S.m.marks.push(t); renderMarks(); backupSoon(); toast('「ここ重要」を ' + t + ' に付けました');
  });
  function renderMarks() {
    var marks = S.m ? S.m.marks : [];
    $('#markCount').textContent = '（' + marks.length + '件）';
    $('#markList').innerHTML = marks.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
  }
  $('#memo').addEventListener('input', function () { if (S.m) { S.m.memo = this.value; backupSoon(); } });
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
    if (R.full) {
      var full = R.full, fchunks = R.fullChunks, m = S.m;
      full.onstop = function () { m.audioBlob = new Blob(fchunks, { type: full.mimeType || R.mime || 'audio/webm' }); updateAudioButtons(); };
      try { full.stop(); } catch (e) {}
    }
    stopCaption(); releaseWakeLock(); if (R.meterStop) R.meterStop();
    stopTracks(R.extra);
    S.m.durationSec = Math.round(R.active / 1000);
    S.m.stoppedAt = Date.now();
    backupSoon();
    if (S.m.source === 'mix' && R.meetHeard === false) toast('録音中、会議の音声（相手の声）が一度も届いていませんでした。共有のしかたを確認してください', true);
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

  /** 会議の音声（Zoom・Teams側の音）が実際に届いているかを、マイクとは別に見張る */
  function watchMeeting(stream) {
    var old = $('#meetLevel'); if (old) old.remove();
    if (!stream) return;
    var tag = document.createElement('span'); tag.id = 'meetLevel'; tag.className = 'pill pill-gray'; tag.style.marginLeft = '8px';
    tag.textContent = '相手の声：待機中'; $('#recMeta').after(tag);
    R.meetHeard = false;
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume();
      var an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
      var buf = new Float32Array(an.fftSize), quiet = 0;
      var iv = setInterval(function () {
        if (!R || R.stopped) { clearInterval(iv); try { ctx.close(); } catch (e) {} return; }
        an.getFloatTimeDomainData(buf);
        var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        var on = Math.sqrt(sum / buf.length) > 0.01;
        if (on) { R.meetHeard = true; quiet = 0; } else quiet++;
        tag.className = 'pill ' + (on ? 'pill-blue' : 'pill-gray');
        tag.textContent = on ? '相手の声：届いています' : (R.meetHeard ? '相手の声：静か' : '相手の声：まだ届いていません');
      }, 300);
    } catch (e) { tag.textContent = '相手の声：確認できません'; }
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
    if (S.m && !S.settings.captions) { $('#capNote').textContent = '字幕はマイページでオフになっています。録音と書き起こしは続いています。'; return; }
    // iPhone・iPad は字幕と録音がマイクを取り合って録音が止まることがあるため、録音を優先する
    if (IS_IOS) { $('#capNote').textContent = 'iPhone・iPadでは録音を優先するため、字幕は出しません。議事録は終了後にAIが作ります。'; return; }
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
      seg.error = errText(e); noteError('書き起こし ' + segLabel(seg), e);
      seg.retries = seg.retries || 0;
      if (BUSY_RE.test(seg.error) && seg.retries < AUTO_RETRY_SEC.length && seg.blob) {
        var wait = AUTO_RETRY_SEC[seg.retries++];
        seg.status = '混雑待ち'; seg.retryAt = Date.now() + wait * 1000;
        setTimeout(function () { if (seg.status === '混雑待ち') queue = queue.then(function () { return transcribeSeg(seg); }); }, wait * 1000);
      } else seg.status = '失敗';
    }).then(function () { renderSegList(); checkAllSettled(); });
  }
  function blobToBase64(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1] || ''); }; r.onerror = rej; r.readAsDataURL(blob); });
  }
  function segLabel(s) { var a = s.offsetSec, b = s.lenSec != null ? a + s.lenSec : null; return hms(a).slice(0, 5 + (a >= 3600 ? 3 : 0)).replace(/^00:/, '') + '〜' + (b != null ? hms(b).replace(/^00:/, '') : ''); }
  function segCounts() {
    var segs = S.m ? S.m.segs.filter(Boolean) : [];
    var done = segs.filter(function (s) { return s.status === '完了' || s.status === '省略'; }).length;
    return { all: segs.length, done: done, failed: segs.filter(function (s) { return s.status === '失敗'; }), busy: segs.some(function (s) { return s.status === '待機' || s.status === '処理中' || s.status === '録音中' || s.status === '混雑待ち'; }),
      waiting: segs.filter(function (s) { return s.status === '混雑待ち'; }) };
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
    backupSoon();
  }

  // ============================================================ 4 仕上げ
  function openFinish() {
    var m = S.m;
    $('#finTitle').textContent = m.title;
    $('#finMeta').textContent = (m.when || jDate(m.startedAt)) + ' ・ ' + m.format + ' ・ 参加者' + m.people.length + '人 ・ 録音 ' + hms(m.durationSec);
    $('#btnSave').disabled = true; $('#speakerBox').hidden = true; $('#reviewBox').hidden = true; $('#finTabs').hidden = true; $('#procBox').hidden = false;
    setFinTab('minutes');
    $('#btnSaveLabel').textContent = m.viewing ? 'ドキュメントに反映' : 'Googleドキュメントに保存';
    $('#btnOpenDoc').hidden = !m.viewing; if (m.viewing) $('#btnOpenDoc').href = m.saved.webViewLink || '#';
    updateAudioButtons();
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
      $('#procNote').textContent = c.all + '区間中 ' + c.done + '区間 完了。このまま少しお待ちください（画面は閉じないでください）。' +
        (c.waiting.length ? ' AIが混み合っているため、' + c.waiting.length + '区間は' + Math.max(1, Math.round((c.waiting[0].retryAt - Date.now()) / 60000)) + '分ほど後に自動でやり直します。' : '');
    } else if (c.failed.length) {
      $('#procTitle').textContent = '一部の区間で書き起こしに失敗しました';
      $('#procNote').textContent = '▶で録れた音を聞けます。音が入っていれば、少し待って「やり直す」を押してください（AIの混雑や取りこぼしのことがあります）。音声はこの画面にだけ残っています。';
      if (!S.m.summary && c.done) {
        var go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-outline'; go.textContent = '失敗した区間を除いて要約する';
        go.addEventListener('click', function () { summarize(); }); acts.appendChild(go);
      }
      acts.appendChild(reportLink('書き起こしに失敗：' + String(c.failed[0].error || '').slice(0, 200)));
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
      if (!S.m.readyAt) S.m.readyAt = Date.now();
      buildSpeakerSelects(); renderMinutes(); renderTranscript();
      $('#speakerBox').hidden = false; $('#reviewBox').hidden = false; $('#finTabs').hidden = false; $('#btnSave').disabled = false;
      renderProcessing();
    }).catch(function (e) {
      noteError('要約', e);
      $('#procTitle').textContent = '要約に失敗しました';
      $('#procNote').textContent = errText(e);
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary'; b.textContent = 'もう一度要約する';
      b.addEventListener('click', function () { summarize(); }); $('#procActions').innerHTML = ''; $('#procActions').appendChild(b);
      $('#procActions').appendChild(reportLink('要約に失敗：' + errText(e)));
    }).then(function () { summarizing = false; });
  }
  function setFinTab(tab) {
    $('#reviewBox').dataset.tab = tab;
    $$('#finTabs button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === tab)); });
  }
  $$('#finTabs button').forEach(function (b) { b.addEventListener('click', function () { setFinTab(b.dataset.tab); }); });
  $('#btnResummary').addEventListener('click', function () {
    if (S.m.edited && !confirm('手直しした内容は元に戻ります。要約を作り直しますか？')) return;
    S.m.summary = null; S.m.resummaries = (S.m.resummaries || 0) + 1; $('#btnSave').disabled = true; summarize();
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
  /** 保存先フォルダ：マイページで選んだフォルダ、なければマイドライブの「議事録アプリ」（無ければ作る） */
  function ensureFolder() {
    var f = S.settings.folder;
    if (f && f.id) return Promise.resolve(f);
    if (S.folderId) return Promise.resolve({ id: S.folderId, name: S.folderName });
    var q = "appProperties has { key='minutesAppFolder' and value='1' } and mimeType='application/vnd.google-apps.folder' and trashed=false";
    return gfetch(DRIVE + '/files?fields=files(id,name)&q=' + encodeURIComponent(q)).then(function (j) {
      if (j.files && j.files.length) { S.folderName = j.files[0].name; S.folderId = j.files[0].id; return { id: S.folderId, name: S.folderName }; }
      return gfetch(DRIVE + '/files?fields=id,name', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { minutesAppFolder: '1' } })
      }).then(function (nf) { S.folderName = nf.name; S.folderId = nf.id; return { id: nf.id, name: nf.name }; });
    });
  }
  function folderLabel(f) { return f && f.id ? (f.driveId ? '共有ドライブ ／ ' : 'マイドライブ ／ ') + f.name : 'マイドライブ ／ ' + FOLDER_NAME; }
  function baseName(m) { return isoDate(m.startedAt) + '_' + m.title.replace(/[\\/:*?"<>|]/g, '_'); }
  function multipartUpload(meta, blob) {
    if (DEMO) return blob.text().then(function (t) { var id = 'demo' + (++demoN); DEMO_FILES[id] = { meta: meta, text: t, created: new Date().toISOString() }; return { id: id, name: meta.name, webViewLink: '#' }; });
    var boundary = 'b' + Math.random().toString(16).slice(2);
    var body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + boundary + '\r\nContent-Type: ' + (blob.type || 'application/octet-stream') + '\r\n\r\n', blob, '\r\n--' + boundary + '--']);
    return gfetch(UPLOAD + '/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink', {
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
  /** 仕上げ画面の中身（再表示用）。本人のドライブの「アプリ専用の見えない場所」に置く */
  function resultPayload(doc) {
    var m = S.m;
    return { v: 1, app: VERSION, docId: doc.id, docLink: doc.webViewLink, docName: doc.name, title: m.title, when: m.when, format: m.format, people: m.people, lang: m.lang, source: m.source,
      startedAt: m.startedAt.getTime(), durationSec: m.durationSec, marks: m.marks, memo: m.memo, names: m.names, summary: m.summary, utter: allUtter(), minutesHtml: $('#minutesBody').innerHTML, savedAt: Date.now() };
  }
  function saveResult(doc) {
    var body = new Blob([JSON.stringify(resultPayload(doc))], { type: 'application/json' });
    if (S.m.resultId) return gfetch(UPLOAD + '/files/' + S.m.resultId + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body });
    return multipartUpload({ name: 'result-' + doc.id + '.json', parents: ['appDataFolder'], appProperties: { kind: 'result', docId: doc.id } }, body).then(function (f) { S.m.resultId = f.id; });
  }
  $('#btnSave').addEventListener('click', function () {
    var btn = this, m = S.m;
    if (m.viewing) { updateDoc(btn); return; }
    btn.disabled = true;
    var folder = null;
    var desc = String(m.summary.overview || '').slice(0, 140);
    m.editedAtSave = !!m.edited;
    ensureToken().then(ensureFolder).then(function (f) {
      folder = f;
      return multipartUpload({ name: baseName(m) + '_議事録', mimeType: 'application/vnd.google-apps.document', parents: [f.id], description: desc, appProperties: { minutesApp: '1' } }, new Blob([docHtml()], { type: 'text/html' }));
    }).then(function (f) {
      m.saved = f;
      return saveResult(f).catch(function (e) { noteError('再表示用の中身の保存', e); });
    }).then(function () {
      clearBackup();
      $('#savedName').textContent = m.saved.name; $('#savedOpen').href = m.saved.webViewLink;
      $('#savedFolder').textContent = folderLabel(folder);
      updateAudioButtons();
      openRate();
      show('saved');
    }).catch(function (e) {
      noteError('保存', e);
      toast('保存できませんでした：' + errText(e) + (S.settings.folder ? '（マイページの保存先も確認してください）' : ''), true, '保存できない：' + errText(e));
      btn.disabled = false;
    });
  });
  /** 見返しモード：画面の内容でドキュメントを置き換える */
  function updateDoc(btn) {
    var m = S.m;
    if (!confirm('Googleドキュメントの中身を、この画面の内容で置き換えます。ドキュメント側で直接直した部分は消えます。よろしいですか？')) return;
    btn.disabled = true;
    ensureToken().then(function () {
      if (DEMO) return null;
      return gfetch(UPLOAD + '/files/' + m.saved.id + '?uploadType=media&supportsAllDrives=true&fields=id', { method: 'PATCH', headers: { 'Content-Type': 'text/html' }, body: new Blob([docHtml()], { type: 'text/html' }) });
    }).then(function () { return saveResult(m.saved); }).then(function () {
      m.edited = false; toast('ドキュメントに反映しました');
    }).catch(function (e) { noteError('ドキュメントに反映', e); toast('反映できませんでした：' + errText(e), true, 'ドキュメントに反映できない：' + errText(e)); })
      .then(function () { btn.disabled = false; });
  }

  // ============================================================ 音声も保存（必要な人だけ。1会議＝1ファイル）
  function updateAudioButtons() {
    var m = S.m, can = !!(m && m.audioBlob && !m.audioSaved && S.settings.audioButton && !m.viewing);
    $('#btnAudio').hidden = !can; $('#btnAudio2').hidden = !can;
    $('#savedAudio').textContent = m && m.audioSaved ? '保存しました（' + m.audioSaved.name + '）' : '保存していません';
  }
  function resumableUpload(meta, blob) {
    if (DEMO) return sleep(600).then(function () { return { id: 'audio', name: meta.name }; });
    return fetch(UPLOAD + '/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink', {
      method: 'POST', body: JSON.stringify(meta),
      headers: { Authorization: 'Bearer ' + S.google.token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'application/octet-stream' }
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('Google HTTP ' + res.status + ' ' + t.slice(0, 200)); });
      var loc = res.headers.get('Location'); if (!loc) throw new Error('アップロード先を受け取れませんでした');
      return fetch(loc, { method: 'PUT', body: blob });
    }).then(function (res) { return res.json().then(function (j) { if (!res.ok) throw new Error('Google HTTP ' + res.status); return j; }); });
  }
  function saveAudio(btn) {
    var m = S.m; if (!m || !m.audioBlob) return;
    btn.disabled = true;
    ensureToken().then(ensureFolder).then(function (f) {
      var ext = /mp4/.test(m.audioBlob.type) ? 'm4a' : 'webm';
      return resumableUpload({ name: baseName(m) + '_音声.' + ext, parents: [f.id], appProperties: { minutesAppAudio: '1' } }, m.audioBlob);
    }).then(function (f) { m.audioSaved = f; updateAudioButtons(); toast('音声を保存しました'); })
      .catch(function (e) { noteError('音声の保存', e); toast('音声を保存できませんでした：' + errText(e), true, '音声を保存できない：' + errText(e)); })
      .then(function () { btn.disabled = false; });
  }
  $('#btnAudio').addEventListener('click', function () { saveAudio(this); });
  $('#btnAudio2').addEventListener('click', function () { saveAudio(this); });

  // ============================================================ 試行の感想（保存完了画面。管理者のスプレッドシートに1行）
  var rate = { v: 0 };
  var RATE_LABEL = ['', 'よくない', 'いまひとつ', 'ふつう', '良い', 'とても良い'];
  function openRate() {
    rate = { v: 0 };
    $('#rateSaved').value = ''; $('#rateComment').value = ''; paintStars(0);
    $('#rateBox').hidden = !!(S.m && (S.m.viewing || S.m.rated));
  }
  function paintStars(v) {
    $$('#rateStars button').forEach(function (b) { var on = Number(b.dataset.v) <= v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(Number(b.dataset.v) === v)); });
    $('#rateLabel').textContent = RATE_LABEL[v] || '';
    $('#rateSend').disabled = !(v && $('#rateSaved').value !== '');
  }
  $$('#rateStars button').forEach(function (b) { b.setAttribute('role', 'radio'); b.addEventListener('click', function () { rate.v = Number(b.dataset.v); paintStars(rate.v); }); });
  $('#rateSaved').addEventListener('change', function () { paintStars(rate.v); });
  $('#rateSkip').addEventListener('click', function () { $('#rateBox').hidden = true; });
  function usageStats() {
    var m = S.m, segs = (m.segs || []).filter(Boolean), ua = navigator.userAgent;
    var models = {}; segs.forEach(function (s) { if (s.model) models[s.model] = (models[s.model] || 0) + 1; });
    return {
      app: VERSION, device: IS_IOS ? 'iPhone/iPad' : /Android/i.test(ua) ? 'Android' : 'PC',
      browser: /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'その他',
      format: m.format, source: m.source === 'mix' ? 'マイク＋会議の音声' : 'マイクのみ', lang: m.lang,
      minutes: Math.round((m.durationSec || 0) / 6) / 10, people: (m.people || []).length, segs: segs.length,
      failed: segs.filter(function (s) { return s.status === '失敗'; }).length,
      retries: segs.reduce(function (a, s) { return a + (s.retries || 0); }, 0),
      models: Object.keys(models).map(function (k) { return k + '×' + models[k]; }).join(' '),
      readySec: m.stoppedAt && m.readyAt ? Math.round((m.readyAt - m.stoppedAt) / 1000) : '',
      resummaries: m.resummaries || 0, edited: !!m.editedAtSave, audioSaved: !!m.audioSaved, resumed: !!m.resumed
    };
  }
  $('#rateSend').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    api('feedback', { rating: rate.v, savedMin: Number($('#rateSaved').value), comment: $('#rateComment').value.trim(), stats: usageStats() }).then(function (r) {
      if (!r.ok) throw new Error(r.error || ('HTTP ' + r.code));
      S.m.rated = true; $('#rateBox').hidden = true; toast('感想を送りました。ありがとうございます');
    }).catch(function (e) { noteError('感想の送信', e); toast('送れませんでした：' + errText(e), true); btn.disabled = false; });
  });

  // ============================================================ 仕上げ画面の再表示（最近の議事録から）
  function openResult(rid, file) {
    gfetch(DRIVE + '/files/' + rid + '?alt=media').then(function (d) {
      if (!d || !d.summary) throw new Error('中身を読めませんでした');
      S.m = { id: 'view', viewing: true, title: d.title, when: d.when, format: d.format, people: d.people || [], lang: d.lang, source: d.source,
        startedAt: new Date(d.startedAt), durationSec: d.durationSec || 0, marks: d.marks || [], memo: d.memo || '', names: d.names || {}, summary: d.summary,
        segs: [{ idx: 0, offsetSec: 0, status: '完了', utter: d.utter || [] }], speakerNotes: '', edited: false, resultId: rid,
        saved: { id: d.docId, name: d.docName || file.name, webViewLink: file.webViewLink || d.docLink } };
      R = null;
      openFinish();
      $('#procBox').hidden = true;
      buildSpeakerSelects();
      $('#minutesBody').innerHTML = d.minutesHtml || minutesInnerHtml();
      renderTranscript();
      $('#speakerBox').hidden = false; $('#reviewBox').hidden = false; $('#finTabs').hidden = false; $('#btnSave').disabled = false;
      S.m.edited = false;
    }).catch(function (e) {
      noteError('仕上げ画面の再表示', e);
      toast('仕上げ画面を開けませんでした（' + errText(e) + '）。ドキュメントで開いてください', true);
    });
  }
  $('#btnCopyLink').addEventListener('click', function () {
    var link = S.m && S.m.saved && S.m.saved.webViewLink; if (!link) return;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast('リンクをコピーしました'); }, function () { prompt('このリンクをコピーしてください', link); });
  });

  // ============================================================ 設定（本人のドライブの「アプリ専用の見えない場所」に settings.json）
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function settingsKey() { return 'minutes.settings.' + (S.user ? S.user.email : ''); }
  function loadSettings() {
    var cached = lsGet(settingsKey());
    if (cached) { try { S.settings = Object.assign({}, DEFAULTS, JSON.parse(cached)); } catch (e) {} }
    return gfetch(DRIVE + '/files?spaces=appDataFolder&fields=files(id)&q=' + encodeURIComponent("name='settings.json'")).then(function (j) {
      var f = j.files && j.files[0]; if (!f) return;
      S.settingsFileId = f.id;
      return gfetch(DRIVE + '/files/' + f.id + '?alt=media').then(function (d) {
        if (d && typeof d === 'object') { S.settings = Object.assign({}, DEFAULTS, d); lsSet(settingsKey(), JSON.stringify(S.settings)); }
      });
    }).catch(function (e) { noteError('設定の読み込み', e); });   // 読めなくても既定値で動く
  }
  var settingsTimer = null;
  function saveSettings() {
    lsSet(settingsKey(), JSON.stringify(S.settings));
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(function () {
      var body = new Blob([JSON.stringify(S.settings)], { type: 'application/json' });
      var p = S.settingsFileId
        ? gfetch(UPLOAD + '/files/' + S.settingsFileId + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body })
        : multipartUpload({ name: 'settings.json', parents: ['appDataFolder'] }, body).then(function (f) { S.settingsFileId = f.id; });
      p.then(function () { $('#mySaved').textContent = '設定を保存しました（' + hm(new Date()) + '）。別のPCでも同じアカウントなら引き継がれます。'; })
        .catch(function (e) { noteError('設定の保存', e); $('#mySaved').textContent = '設定はこのPCにだけ保存しました（' + errText(e) + '）。'; });
    }, 600);
  }

  // ============================================================ マイページ
  function openMy() {
    $('#myEmail').textContent = S.user ? S.user.email : '';
    $('#myVersion').textContent = '議事録アプリ v' + VERSION;
    renderMy(); show('mypage');
  }
  var TOGGLES = { setCaptions: 'captions', setCalendar: 'calendar', setAudio: 'audioButton', setResume: 'resume' };
  function renderMy() {
    var st = S.settings;
    $('#myFolder').textContent = folderLabel(st.folder) + (st.folder && st.folder.id ? '' : '（標準）');
    $('#btnResetFolder').hidden = !(st.folder && st.folder.id);
    $('#setSource').value = st.source; $('#setLang').value = st.lang; $('#setRecent').value = String(st.recentCount);
    Object.keys(TOGGLES).forEach(function (id) { $('#' + id).checked = !!st[TOGGLES[id]]; });
    if (!CFG.pickerApiKey && !DEMO) { $('#btnPickFolder').disabled = true; $('#pickNote').textContent = '「フォルダを選ぶ」は、管理者がGoogle Cloudの設定（フォルダ選択用のキー）を終えると使えるようになります。それまでは標準の保存先に保存します。'; }
  }
  $('#setSource').addEventListener('change', function () { S.settings.source = this.value; saveSettings(); });
  $('#setLang').addEventListener('change', function () { S.settings.lang = this.value; saveSettings(); });
  $('#setRecent').addEventListener('change', function () { S.settings.recentCount = Number(this.value); saveSettings(); });
  Object.keys(TOGGLES).forEach(function (id) {
    $('#' + id).addEventListener('change', function () {
      S.settings[TOGGLES[id]] = this.checked; saveSettings();
      if (id === 'setResume' && !this.checked) clearBackup();
    });
  });
  $('#btnResetFolder').addEventListener('click', function () { S.settings.folder = null; saveSettings(); renderMy(); toast('保存先を標準（マイドライブ ／ ' + FOLDER_NAME + '）に戻しました'); });
  $('#btnFeedback').addEventListener('click', function () { openReport({ kind: 'feedback', message: 'マイページからの連絡' }); });

  // Googleの「フォルダを選ぶ画面」（Google Picker）。選ばれたフォルダだけがアプリに許可される
  var pickerReady = null;
  function loadPicker() {
    if (pickerReady) return pickerReady;
    pickerReady = new Promise(function (res, rej) {
      var sc = document.createElement('script'); sc.src = 'https://apis.google.com/js/api.js';
      sc.onload = function () { gapi.load('picker', { callback: res, onerror: function () { rej(new Error('フォルダ選択の部品を読み込めませんでした')); } }); };
      sc.onerror = function () { pickerReady = null; rej(new Error('フォルダ選択の部品を読み込めませんでした')); };
      document.head.appendChild(sc);
    });
    return pickerReady;
  }
  function setPickedFolder(id) {
    return gfetch(DRIVE + '/files/' + id + '?supportsAllDrives=true&fields=id,name,driveId,capabilities(canAddChildren)').then(function (f) {
      if (f.capabilities && f.capabilities.canAddChildren === false) { toast('このフォルダには保存する権限がありません。別のフォルダを選んでください', true); return; }
      S.settings.folder = { id: f.id, name: f.name, driveId: f.driveId || '' }; saveSettings(); renderMy();
      toast('保存先を「' + f.name + '」にしました');
    });
  }
  $('#btnPickFolder').addEventListener('click', function () {
    if (DEMO) { setPickedFolder('pick'); return; }
    ensureToken().then(loadPicker).then(function () {
      var P = google.picker;
      var mine = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
      var shared = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder').setEnableDrives(true);
      var b = new P.PickerBuilder().setTitle('議事録の保存先フォルダを選んでください').addView(mine).addView(shared)
        .setOAuthToken(S.google.token).setDeveloperKey(CFG.pickerApiKey).setAppId(String(CFG.clientId).split('-')[0]).setLocale('ja')
        .setCallback(function (data) {
          if (data[P.Response.ACTION] !== P.Action.PICKED) return;
          setPickedFolder(data[P.Response.DOCUMENTS][0][P.Document.ID]).catch(function (e) { noteError('フォルダ選択', e); toast('フォルダを確認できませんでした：' + errText(e), true); });
        });
      if (P.Feature && P.Feature.SUPPORT_DRIVES) b.enableFeature(P.Feature.SUPPORT_DRIVES);
      b.build().setVisible(true);
    }).catch(function (e) { noteError('フォルダ選択', e); toast(errText(e), true); });
  });

  // ============================================================ 管理者への連絡（宛先は裏側GASで固定。診断情報だけを送る）
  var lastErrors = [];
  function noteError(where, e) { lastErrors.push({ t: new Date().toISOString(), where: where, msg: String(errText(e)).slice(0, 300) }); if (lastErrors.length > 8) lastErrors.shift(); }
  window.addEventListener('error', function (e) { noteError('画面', e.message); });
  window.addEventListener('unhandledrejection', function (e) { noteError('処理', e.reason); });
  function diagnostics() {
    var m = S.m, ua = navigator.userAgent, cv = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '';
    var d = { app: VERSION, screen: S.screen, browser: cv ? 'Chrome ' + cv : ua.slice(0, 160), os: navigator.platform, online: navigator.onLine, time: new Date().toISOString(), errors: lastErrors.slice() };
    if (m) d.meeting = { format: m.format, source: m.source, lang: m.lang, people: (m.people || []).length, durationSec: m.durationSec || (R && R.active ? Math.round(R.active / 1000) : null),
      viewing: !!m.viewing, resumed: !!m.resumed, meetHeard: R && 'meetHeard' in R ? R.meetHeard : null,
      segs: (m.segs || []).filter(Boolean).map(function (s) { return { range: segLabel(s), status: s.status, kb: s.blob ? Math.round(s.blob.size / 1024) : null, model: s.model || null, diag: s.diag || null, error: s.error ? String(s.error).slice(0, 300) : null }; }) };
    d.settings = { source: S.settings.source, captions: S.settings.captions, resume: S.settings.resume, folder: S.settings.folder ? (S.settings.folder.driveId ? 'shared' : 'custom') : 'default' };
    return d;
  }
  var rep = null;
  function reportLink(message) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'report-link'; b.textContent = 'このエラーを管理者に知らせる';
    b.addEventListener('click', function () { openReport({ kind: 'error', message: message }); });
    return b;
  }
  function openReport(ctx) {
    if (!S.session) { toast('ログインしてから送れます', true); return; }
    rep = ctx; rep.detail = diagnostics();
    $('#repTitle').textContent = ctx.kind === 'feedback' ? '不具合・要望を管理者に送る' : '管理者に知らせる';
    $('#repComment').value = '';
    $('#repDetail').textContent = '内容：' + ctx.message + '\n' + JSON.stringify(rep.detail, null, 2);
    var dlg = $('#reportDlg'); if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function closeReport() { var dlg = $('#reportDlg'); if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
  $('#repCancel').addEventListener('click', closeReport);
  $('#repSend').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    api('report', { kind: rep.kind, screen: S.screen, message: rep.message, comment: $('#repComment').value.trim(), detail: rep.detail }).then(function (r) {
      if (!r.ok) throw new Error(r.error || ('HTTP ' + r.code));
      closeReport(); toast('管理者に送りました。ありがとうございます');
    }).catch(function (e) { toast('送れませんでした：' + errText(e), true); }).then(function () { btn.disabled = false; });
  });

  // ============================================================ 途中再開（録音をこのPCのブラウザ内＝IndexedDBに一時保存）
  var idb = null;
  function db() {
    if (idb) return idb;
    idb = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('このブラウザは一時保存に対応していません')); return; }
      var rq = indexedDB.open('minutesApp', 1);
      rq.onupgradeneeded = function () { var d = rq.result; if (!d.objectStoreNames.contains('meeting')) d.createObjectStore('meeting'); if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { autoIncrement: true }); };
      rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
    });
    idb.catch(function () { idb = null; });
    return idb;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) { return new Promise(function (res, rej) {
      var t = d.transaction(store, mode), r = fn(t.objectStore(store));
      t.oncomplete = function () { res(r && r.result); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
    }); });
  }
  function backupOn() { return !!(S.settings.resume && S.m && !S.m.viewing && !S.m.saved); }
  function backupMeeting() {
    if (!backupOn()) return Promise.resolve();
    var m = S.m;
    var rec = { id: m.id, title: m.title, when: m.when, format: m.format, people: m.people, lang: m.lang, source: m.source, startedAt: m.startedAt.getTime(), mime: m.mime,
      marks: m.marks, memo: m.memo, speakerNotes: m.speakerNotes, activeSec: R && R.active != null ? Math.round(R.active / 1000) : (m.durationSec || 0), durationSec: m.durationSec || null,
      segs: m.segs.filter(Boolean).map(function (s) { return { idx: s.idx, offsetSec: s.offsetSec, lenSec: s.lenSec == null ? null : s.lenSec, status: s.status, utter: s.utter || null }; }) };
    return tx('meeting', 'readwrite', function (st) { return st.put(rec, 'current'); }).catch(function (e) { noteError('一時保存', e); });
  }
  var backupTimer = null;
  function backupSoon() { if (!backupOn()) return; clearTimeout(backupTimer); backupTimer = setTimeout(backupMeeting, 1500); }
  function backupChunk(idx, blob) { if (!backupOn()) return; var id = S.m.id; tx('chunks', 'readwrite', function (st) { return st.add({ id: id, seg: idx, data: blob }); }).catch(function (e) { noteError('一時保存（音声）', e); }); }
  function clearBackup() {
    clearTimeout(backupTimer);
    return Promise.all([tx('meeting', 'readwrite', function (st) { return st.clear(); }), tx('chunks', 'readwrite', function (st) { return st.clear(); })]).catch(function () {});
  }
  function readBackup() { return tx('meeting', 'readonly', function (st) { return st.get('current'); }).catch(function () { return null; }); }
  function readChunks(id) {
    return db().then(function (d) { return new Promise(function (res, rej) {
      var out = {}, t = d.transaction('chunks', 'readonly'), rq = t.objectStore('chunks').openCursor();
      rq.onsuccess = function () { var c = rq.result; if (c) { var v = c.value; if (v.id === id) (out[v.seg] = out[v.seg] || []).push(v.data); c.continue(); } };
      t.oncomplete = function () { res(out); }; t.onerror = function () { rej(t.error); };
    }); });
  }
  function checkResume() {
    var box = $('#resumeBox'); box.hidden = true; S.pendingResume = null;
    if (!S.settings.resume) return;
    readBackup().then(function (b) {
      if (!b || !b.id || S.screen !== 'home') return;
      S.pendingResume = b;
      box.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8A6A00" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" style="flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '<div><b>途中で閉じた録音があります</b><div>' + esc(b.title) + '（' + esc(b.when || jDate(new Date(b.startedAt))) + '・録音 ' + hms(b.activeSec || 0) + '）。続きから書き起こし・要約して保存できます。</div>' +
        '<div class="acts"><button type="button" class="btn btn-primary" id="btnResume">続きから仕上げる</button><button type="button" class="btn" id="btnDiscard">破棄する</button></div></div>';
      box.hidden = false;
      $('#btnResume').addEventListener('click', function () { resumeMeeting(b); });
      $('#btnDiscard').addEventListener('click', function () {
        if (!confirm('途中の録音を破棄します。元に戻せません。よろしいですか？')) return;
        clearBackup().then(function () { S.pendingResume = null; box.hidden = true; });
      });
    });
  }
  function resumeMeeting(b) {
    readChunks(b.id).then(function (chunks) {
      S.m = { id: b.id, title: b.title, when: b.when, format: b.format, people: b.people || [], lang: b.lang, source: b.source, startedAt: new Date(b.startedAt), mime: b.mime,
        segs: [], marks: b.marks || [], memo: b.memo || '', speakerNotes: b.speakerNotes || '', summary: null, names: {}, edited: false, saved: null,
        durationSec: b.durationSec || b.activeSec || 0, resumed: true };
      R = { stopped: true };   // 録音そのものは終わっている扱い
      S.pendingResume = null; $('#resumeBox').hidden = true;
      var pending = [];
      (b.segs || []).forEach(function (s) {
        var seg = { idx: s.idx, offsetSec: s.offsetSec, lenSec: s.lenSec, status: s.status, utter: s.utter || undefined };
        S.m.segs[s.idx] = seg;
        if (s.status === '完了' || s.status === '省略') return;
        var parts = chunks[s.idx];
        if (!parts || !parts.length) { seg.status = '省略'; seg.note = '音声が残っていませんでした'; return; }
        seg.blob = new Blob(parts, { type: b.mime || 'audio/webm' });
        if (seg.lenSec == null) seg.lenSec = Math.max(0, (b.activeSec || 0) - s.offsetSec);
        seg.status = '待機'; pending.push(seg);
      });
      openFinish();
      pending.forEach(function (seg) { queue = queue.then(function () { return transcribeSeg(seg); }); });
      if (!pending.length) checkAllSettled();
      toast('途中の録音を読み込みました。続きから書き起こします');
    }).catch(function (e) { noteError('途中再開', e); toast('途中の録音を読み込めませんでした：' + errText(e), true, '途中再開できない：' + errText(e)); });
  }

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
      if (action === 'report') return { ok: true };
      if (action === 'feedback') { window.__demoFeedback = p; return { ok: true }; }
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
  var DEMO_FILES = {}, demoN = 0, demoSampleGone = false;
  function demoGoogle(url, opts) {
    return sleep(250).then(function () {
      var mm;
      if (/userinfo/.test(url)) return { name: '見本ユーザー' };
      if ((mm = url.match(/\/files\/([^/?]+)\?alt=media/))) return DEMO_FILES[mm[1]] ? JSON.parse(DEMO_FILES[mm[1]].text) : {};
      if ((mm = url.match(/upload\/drive\/v3\/files\/([^/?]+)\?/))) { var uid = mm[1]; return opts.body.text().then(function (t) { if (DEMO_FILES[uid]) DEMO_FILES[uid].text = t; return { id: uid }; }); }
      if (/spaces=appDataFolder/.test(url)) {
        var all = Object.keys(DEMO_FILES).filter(function (k) { return (DEMO_FILES[k].meta.parents || [])[0] === 'appDataFolder'; })
          .map(function (k) { return { id: k, name: DEMO_FILES[k].meta.name, appProperties: DEMO_FILES[k].meta.appProperties || {} }; });
        return { files: all.filter(function (f) { return /settings\.json/.test(decodeURIComponent(url)) ? f.name === 'settings.json' : !!f.appProperties.docId; }) };
      }
      if (/files\/pick\?/.test(url)) return { id: 'pick', name: '見本フォルダ', driveId: '' };
      if (opts && (opts.method === 'PATCH' || opts.method === 'DELETE') && (mm = url.match(/drive\/v3\/files\/([^/?]+)/))) {
        var did = mm[1];
        if (opts.method === 'DELETE') { delete DEMO_FILES[did]; return null; }
        var b = JSON.parse(opts.body);
        if (did === 'd1') { demoSampleGone = true; return { id: did }; }
        if (DEMO_FILES[did]) { if (b.trashed) DEMO_FILES[did].meta.trashed = true; if (b.appProperties) DEMO_FILES[did].meta.appProperties = {}; }
        return { id: did };
      }
      if (/calendar/.test(url)) {
        var d = new Date(); d.setMinutes(0, 0, 0);
        var mk = function (h, len, title, loc, names) { var s = new Date(d); s.setHours(h); var e = new Date(s.getTime() + len * 60000); return { summary: title, location: loc, start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() }, attendees: names.map(function (n, i) { return { displayName: n, self: i === 0 }; }) }; };
        return { items: [mk(10, 60, '営業部 定例ミーティング', 'https://teams.microsoft.com/l/meetup', ['見本ユーザー', 'まっつん', 'おの']), mk(14, 60, '新規提案 社内レビュー', 'https://zoom.us/j/1', ['見本ユーザー', 'めぐ']), mk(17, 30, 'AIブートキャンプ 振り返り', '会議室A', ['見本ユーザー', 'やっすー', 'もっつ'])] };
      }
      if (/drive\/v3\/files\?pageSize/.test(url)) {
        var mine = Object.keys(DEMO_FILES).filter(function (k) { return (DEMO_FILES[k].meta.appProperties || {}).minutesApp && !DEMO_FILES[k].meta.trashed; }).reverse()
          .map(function (k) { return { id: k, name: DEMO_FILES[k].meta.name, webViewLink: '#', createdTime: DEMO_FILES[k].created, description: DEMO_FILES[k].meta.description }; });
        var all2 = mine.concat(demoSampleGone ? [] : [{ id: 'd1', name: isoDate(new Date()) + '_営業部 定例ミーティング_議事録', webViewLink: '#', createdTime: new Date().toISOString(), description: '10月の重点施策を確認。提案書の初稿を来週水曜までに共有することで合意。' }]);
        var ps = Number((url.match(/pageSize=(\d+)/) || [])[1]) || 6, start = Number((url.match(/pageToken=(\d+)/) || [])[1]) || 0;
        return { files: all2.slice(start, start + ps), nextPageToken: start + ps < all2.length ? String(start + ps) : undefined };
      }
      if (/drive\/v3\/files\?fields=files/.test(url)) return { files: [{ id: 'f1', name: FOLDER_NAME }] };
      if (/upload/.test(url)) return { id: 'x', name: '（見本）保存したドキュメント', webViewLink: '#' };
      return {};
    });
  }
  if (DEMO) { var dl = $('#loginError'); dl.textContent = '見本モードです。Googleにも裏側APIにもつながず、AIの結果は作り物です。'; dl.hidden = false; dl.style.background = '#EEF2FA'; dl.style.color = '#1F3C78'; }

  show('login');
})();
