// 小组件渲染层：只做展示与交互，业务规则全部在主进程。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  let state = null;
  let editingId = null;
  let repSel = 'daily';
  let weekdays = [1, 2, 3, 4, 5];
  let toastTimer = null;

  // ---------- 工具 ----------
  function toast(msg, actionLabel, actionFn) {
    const el = $('toast');
    el.textContent = '';
    el.appendChild(document.createTextNode(msg));
    if (actionLabel) {
      const b = document.createElement('button');
      b.className = 'toastBtn';
      b.textContent = actionLabel;
      b.addEventListener('click', () => {
        el.classList.add('hidden');
        clearTimeout(toastTimer);
        actionFn();
      });
      el.appendChild(b);
    }
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), actionLabel ? 5000 : 2200);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---------- 时/分步进器（任务表单 f 前缀 / 模板表单 ft 前缀共用） ----------
  const clampStep = (v, max) => Math.min(max, Math.max(0, Number.isInteger(v) ? v : 0));

  function bindSteppers(prefix) {
    const hour = $(prefix + 'Hour');
    const min = $(prefix + 'Min');
    document.querySelectorAll(`[id="${prefix}HourBox"] .stepBtn, [id="${prefix}MinBox"] .stepBtn`).forEach((b) => {
      b.addEventListener('click', () => {
        const d = Number(b.dataset.d);
        if (b.dataset.k === 'hour') hour.value = (clampStep(parseInt(hour.value, 10), 23) + d + 24) % 24;
        else min.value = (clampStep(parseInt(min.value, 10), 59) + d + 60) % 60;
      });
    });
    [hour, min].forEach((inp) => {
      inp.addEventListener('blur', () => {
        inp.value = clampStep(parseInt(inp.value, 10), inp.id.endsWith('Hour') ? 23 : 59);
      });
    });
  }

  function getFormTime(prefix) {
    const h = clampStep(parseInt($(prefix + 'Hour').value, 10), 23);
    const m = clampStep(parseInt($(prefix + 'Min').value, 10), 59);
    return `${pad(h)}:${pad(m)}`;
  }

  function setFormTime(prefix, t) {
    const [h, m] = t.split(':').map(Number);
    $(prefix + 'Hour').value = h;
    $(prefix + 'Min').value = m;
  }
  function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  function minutesToTime(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }

  function applyVisualSettings() {
    const s = state.settings;
    app.dataset.theme = s.theme;
    app.style.setProperty('--alpha', s.opacity);
    app.style.setProperty('--alpha-hover', Math.min(1, s.opacity + 0.22));
    $('pinBtn').classList.toggle('on', s.pinned);
  }

  // ---------- 时钟（每秒读系统时间，抗节流） ----------
  function tickClock() {
    const d = new Date();
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $('time').textContent = t;
    $('date').textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
    if (app.classList.contains('mini')) $('miniTime').textContent = t;
    renderPomo();
    renderAlert();
  }

  // ---------- 番茄钟 ----------
  const RING_C = 2 * Math.PI * 8;
  $('ringFg').style.strokeDasharray = RING_C;
  function renderPomo() {
    const p = state ? state.pomodoro : { phase: 'idle', endsAt: 0, totalSec: 0 };
    const fg = $('ringFg');
    if (p.phase === 'idle') {
      $('pomoTime').textContent = '🍅';
      fg.style.strokeDashoffset = RING_C;
      $('pomoBtn').textContent = '▶';
      $('pomoBtn').title = `番茄钟：一键开始 ${state ? state.settings.pomodoro.focus : 25} 分钟专注`;
      return;
    }
    const remain = Math.max(0, Math.round((p.endsAt - Date.now()) / 1000));
    const label = p.phase === 'focus' ? '专注 ' : '休息 ';
    $('pomoTime').textContent = label + `${pad(Math.floor(remain / 60))}:${pad(remain % 60)}`;
    const prog = p.totalSec ? 1 - remain / p.totalSec : 0;
    fg.style.strokeDashoffset = RING_C * (1 - Math.min(1, Math.max(0, prog)));
    $('pomoBtn').textContent = '⏹';
    $('pomoBtn').title = '停止番茄钟';
  }

  // ---------- 任务列表（按 id diff，动画不中断） ----------
  const rowEls = new Map();

  function buildRow(t) {
    const row = document.createElement('div');
    row.className = 'task';
    row.dataset.id = t.id;
    const circle = document.createElement('button');
    circle.className = 'circle';
    const mid = document.createElement('div');
    mid.className = 'tMid';
    const title = document.createElement('div');
    title.className = 'tTitle';
    const sub = document.createElement('div');
    sub.className = 'tSub';
    mid.append(title, sub);
    row.append(circle, mid);
    circle.addEventListener('click', () => onComplete(t.id, row));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtx(t.id, e.clientX, e.clientY); });
    attachLongPress(row, (x, y) => openCtx(t.id, x, y));
    return row;
  }

  function updateRow(row, t) {
    const done = t.state === 'done';
    const skip = t.state === 'skip';
    row.classList.toggle('done', done);
    row.classList.toggle('skip', skip);
    row.classList.toggle('disabled', !t.enabled);
    row.querySelector('.tTitle').textContent = t.title;
    const today = todayStr();
    const isInterval = t.repeat && t.repeat.type === 'interval';
    let subText;
    if (isInterval) subText = t.repeatLabel;
    else if (t.date && t.date !== today) {
      const parts = t.date.split('-');
      subText = `${Number(parts[1])}月${Number(parts[2])}日 ${t.time}`;
    } else subText = `${t.repeatLabel} ${t.time}`;
    row.querySelector('.tSub').textContent = subText;
    let tip = `${t.title} · ${t.date ? t.date + ' ' : ''}${subText}`;
    if (t.repeat && t.repeat.type === 'interval' && t.repeat.activeWindow) {
      tip += `（生效 ${t.repeat.activeWindow[0]}–${t.repeat.activeWindow[1]}）`;
    }
    if (done) tip += ' · 本次已完成';
    else if (skip) tip += ' · 本次已跳过（下次照常提醒）';
    if (!t.enabled) tip += ' · 已停用';
    if (t.overdueAlert && !done && !skip) tip += ' · 超时会霸屏提醒';
    row.title = tip;
    const c = row.querySelector('.circle');
    c.textContent = done ? '✓' : skip ? '–' : '';
    c.title = done ? '本次已完成' : skip ? '本次已跳过' : '点击完成本次任务';
  }

  function renderTasks() {
    const list = $('list');
    const rank = (t) => (!t.enabled ? 2 : (t.state === 'done' || t.state === 'skip') ? 1 : 0);
    const ordered = [...state.tasks].sort((a, b) => rank(a) - rank(b) || a.time.localeCompare(b.time));
    const alive = new Set();
    for (const t of ordered) {
      alive.add(t.id);
      let row = rowEls.get(t.id);
      if (!row) { row = buildRow(t); rowEls.set(t.id, row); }
      updateRow(row, t);
      list.appendChild(row); // append 会移动已有节点 → 同时完成排序
    }
    for (const [id, el] of rowEls) {
      if (!alive.has(id)) { el.remove(); rowEls.delete(id); }
    }
    $('emptyHint').classList.toggle('hidden', state.tasks.length > 0);
    $('doneBadge').textContent = `今日完成 ${state.doneToday}`;
    $('streakVal').textContent = `连续${state.streak}天`;
    $('dndBadge').classList.toggle('hidden', !state.settings.dndMode);
    $('miniCount').textContent = ordered.filter((t) => t.enabled && t.state === 'pending').length;
    renderAlert();
  }

  // ---------- 超时霸屏提醒页（重建守卫：任务集合不变时只刷新分钟文本） ----------
  let alertKey = null;

  function occMinutesAgo(occ) {
    if (!occ) return 0;
    const [h, m] = occ.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  }

  function renderAlert() {
    if (!state) return;
    const list = state.tasks.filter((t) => t.overdue);
    const show = list.length > 0;
    const had = !!alertKey;
    $('alertView').classList.toggle('hidden', !show);
    $('list').classList.toggle('hidden', show);
    $('badgeRow').classList.toggle('hidden', show);
    $('foot').classList.toggle('hidden', show);
    $('bar').classList.toggle('hidden', show);
    $('musicBar').classList.toggle('hidden', show);
    $('emptyHint').classList.toggle('hidden', show || state.tasks.length > 0);
    if (!show) { alertKey = null; return; }
    const key = list.map((t) => t.id).join(',');
    const box = $('alertView');
    if (key !== alertKey) {
      alertKey = key;
      // 霸屏=接管全窗：关闭所有打开的抽屉，避免被盖住
      document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
      box.textContent = '';
      for (const t of list) box.appendChild(buildAlertCard(t));
      if (!had) SoundKit.play('remind', state.settings.soundPack, state.settings.sound); // 仅「无→有」边沿响一声
    } else {
      for (const t of list) {
        const sub = box.querySelector(`[data-id="${t.id}"] .aSub`);
        if (sub) sub.textContent = `已超时 ${occMinutesAgo(t.occ)} 分钟 · 计划时刻 ${t.occ}`;
      }
    }
  }

  function buildAlertCard(t) {
    const card = document.createElement('div');
    card.className = 'alertCard';
    card.dataset.id = t.id;
    const title = document.createElement('div');
    title.className = 'aTitle';
    title.textContent = t.title;
    const sub = document.createElement('div');
    sub.className = 'aSub';
    sub.textContent = `已超时 ${occMinutesAgo(t.occ)} 分钟 · 计划时刻 ${t.occ}`;
    const btns = document.createElement('div');
    btns.className = 'rbtns';
    const btn = (label, cls, fn) => {
      const b = document.createElement('button');
      if (cls) b.className = cls;
      b.textContent = label;
      b.addEventListener('click', fn);
      btns.appendChild(b);
    };
    btn('✓ 完成', 'primary', () => api.completeTask(t.id).then((r) => { if (!r.ok) toast(r.error); }));
    btn(`${state.settings.snoozeMinutes}分后`, '', () => api.snoozeTask(t.id, state.settings.snoozeMinutes));
    btn('跳过', '', () => api.skipTask(t.id).then((r) => { if (!r.ok) toast(r.error); }));
    card.append(title, sub, btns);
    return card;
  }

  // ---------- 完成动画（三种随机，≤1s） ----------
  function onComplete(id, row) {
    api.completeTask(id).then((res) => {
      if (!res.ok) { toast(res.error); return; }
      SoundKit.play('done', state.settings.soundPack, state.settings.sound);
      playDoneAnim(row);
    });
  }

  function playDoneAnim(row) {
    const kind = ['check', 'bubble', 'strike'][Math.floor(Math.random() * 3)];
    row.classList.add('anim-' + kind);
    if (kind === 'check') {
      const colors = ['#FF6B4A', '#FFC53D', '#4ADE80', '#60A5FA', '#C084FC'];
      for (let i = 0; i < 14; i++) {
        const s = document.createElement('span');
        s.className = 'confetti';
        s.style.background = colors[i % colors.length];
        s.style.setProperty('--tx', (Math.random() * 140 - 70) + 'px');
        s.style.setProperty('--ty', (-20 - Math.random() * 70) + 'px');
        s.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
        s.style.left = 24 + Math.random() * 20 + 'px';
        row.appendChild(s);
      }
    }
    setTimeout(() => {
      row.classList.remove('anim-' + kind);
      row.querySelectorAll('.confetti').forEach((c) => c.remove());
    }, 1000);
  }

  // ---------- 右键菜单 / 长按 ----------
  function openCtx(id, x, y) {
    const t = state.tasks.find((x2) => x2.id === id);
    if (!t) return;
    const menu = $('ctxMenu');
    menu.textContent = '';
    const add = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { menu.classList.add('hidden'); fn(); });
      menu.appendChild(b);
    };
    add('✏️ 编辑', () => openTaskModal(t));
    if (t.enabled) {
      add('⏰ 稍后提醒', async () => {
        const r = await api.snoozeTask(id, state.settings.snoozeMinutes);
        toast(r.ok ? `将在 ${r.minutes} 分钟后提醒` : r.error);
      });
      add('⏸ 停用', () => api.toggleTask(id, false));
    } else {
      add('▶ 启用', () => api.toggleTask(id, true));
    }
    add('🗑 删除', async () => {
      const r = await api.deleteTask(id);
      if (!r.ok) { toast(r.error); return; }
      toast(`已删除「${t.title}」`, '撤销', async () => {
        const u = await api.undoDelete();
        if (!u.ok) toast(u.error);
      });
    });
    menu.classList.remove('hidden');
    const mw = 150, mh = menu.children.length * 38 + 8;
    menu.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 4) + 'px';
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxMenu')) $('ctxMenu').classList.add('hidden');
  });

  function attachLongPress(el, cb) {
    let timer = null;
    let sx = 0, sy = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.circle')) return;
      sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { timer = null; cb(sx, sy); }, 600);
    });
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
    });
  }

  // ---------- 添加 / 编辑任务 ----------
  const REP_CHIPS = [
    { k: 'once', label: '仅一次' }, { k: 'daily', label: '每天' },
    { k: 'workdays', label: '工作日' }, { k: 'everyhour', label: '每1小时' }, { k: 'custom', label: '自定义' },
  ];

  function chip(label, cls) {
    const b = document.createElement('button');
    b.className = 'chip' + (cls ? ' ' + cls : '');
    b.textContent = label;
    return b;
  }

  function renderTplGrid() {
    const grid = $('tplGrid');
    grid.textContent = '';
    for (const tp of state.customTemplates) {
      const b = chip('📌 ' + tp.title, 'tpl');
      b.title = `${tp.time} · 点选填入表单（在「模板」里可编辑）`;
      b.addEventListener('click', () => {
        $('fTitle').value = tp.title;
        setFormTime('f', tp.time);
        fillRepeat(tp.repeat);
      });
      grid.appendChild(b);
    }
    const b = chip('✏️ 自定义', 'tpl');
    b.addEventListener('click', () => { $('fTitle').value = ''; $('fTitle').focus(); });
    grid.appendChild(b);
  }

  function renderTimeChips() {
    const box = $('timeChips');
    box.textContent = '';
    for (const t of ['09:00', '12:00', '14:00', '18:00']) {
      const b = chip(t);
      b.addEventListener('click', () => { setFormTime('f', t); });
      box.appendChild(b);
    }
  }

  function renderRepChips() {
    const box = $('repChips');
    box.textContent = '';
    for (const rc of REP_CHIPS) {
      const b = chip(rc.label);
      b.classList.toggle('sel', repSel === rc.k);
      b.addEventListener('click', () => { repSel = rc.k; renderRepChips(); });
      box.appendChild(b);
    }
    $('repCustom').classList.toggle('hidden', repSel !== 'custom');
    if (repSel === 'custom') $('repCustom').classList.remove('hidden');
    $('dateRow').classList.toggle('hidden', repSel !== 'once');
  }

  function renderWeekdays() {
    const row = $('weekdayRow');
    row.textContent = '';
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const b = chip(WEEK[d]);
      b.classList.toggle('sel', weekdays.includes(d));
      b.addEventListener('click', () => {
        weekdays = weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d];
        renderWeekdays();
      });
      row.appendChild(b);
    }
  }

  function fillRepeat(r) {
    weekdays = [1, 2, 3, 4, 5];
    $('fInterval').value = '';
    $('fUnit').value = 'm';
    $('fWinStart').value = (r && r.activeWindow && r.activeWindow[0]) || '09:00';
    $('fWinEnd').value = (r && r.activeWindow && r.activeWindow[1]) || '22:00';
    if (r.type === 'once' || r.type === 'daily' || r.type === 'workdays') repSel = r.type;
    else if (r.type === 'interval' && r.minutes === 60 && r.activeWindow[0] === '09:00' && r.activeWindow[1] === '22:00') repSel = 'everyhour';
    else {
      repSel = 'custom';
      if (r.type === 'weekdays') weekdays = [...r.weekdays];
      if (r.type === 'interval') {
        $('fInterval').value = r.minutes % 60 === 0 && r.minutes >= 60 ? String(r.minutes / 60) : String(r.minutes);
        $('fUnit').value = r.minutes % 60 === 0 && r.minutes >= 60 ? 'h' : 'm';
      }
    }
    renderRepChips();
    renderWeekdays();
  }

  function buildRepeat() {
    if (repSel === 'custom') {
      const n = parseInt($('fInterval').value, 10);
      const win = [$('fWinStart').value, $('fWinEnd').value];
      if (Number.isInteger(n) && n >= 1) {
        const minutes = $('fUnit').value === 'h' ? n * 60 : n;
        if (minutes > 1440) throw new Error('间隔不能超过 24 小时');
        return { type: 'interval', minutes, activeWindow: win[0] && win[1] ? win : ['09:00', '22:00'] };
      }
      if (weekdays.length) return { type: 'weekdays', weekdays: [...weekdays] };
      throw new Error('自定义重复：请填间隔或选择周几');
    }
    if (repSel === 'everyhour') return { type: 'interval', minutes: 60 };
    return { type: repSel };
  }

  function openTaskModal(t) {
    editingId = t ? t.id : null;
    $('taskModalTitle').textContent = t ? '编辑提醒' : '添加提醒';
    renderTplGrid();
    if (t) {
      $('fTitle').value = t.title;
      setFormTime('f', t.time);
      $('fDate').value = t.date || todayStr();
      $('fOverdue').checked = !!t.overdueAlert;
      fillRepeat(t.repeat);
    } else {
      $('fTitle').value = '';
      $('fOverdue').checked = false;
      const now = new Date();
      setFormTime('f', minutesToTime(Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5 % 1440));
      $('fDate').value = todayStr();
      fillRepeat({ type: 'daily' });
    }
    $('taskModal').classList.remove('hidden');
  }

  async function saveTask() {
    try {
      const payload = {
        title: $('fTitle').value,
        time: getFormTime('f'),
        repeat: buildRepeat(),
        overdueAlert: $('fOverdue').checked,
      };
      if (repSel === 'once') payload.date = $('fDate').value || null;
      const res = editingId ? await api.updateTask(editingId, payload) : await api.addTask(payload);
      if (!res.ok) { toast(res.error); return; }
      toast(editingId ? `已更新「${payload.title}」` : `已添加「${payload.title}」`);
      $('taskModal').classList.add('hidden');
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- 设置面板 ----------
  const THEMES_UI = [
    { k: 'lively', label: '活泼' }, { k: 'steady', label: '沉稳' }, { k: 'quiet', label: '安静' },
  ];
  let opacitySaveTimer = null;

  function openSettings() {
    const s = state.settings;
    const box = $('themeChips');
    box.textContent = '';
    for (const th of THEMES_UI) {
      const b = chip(th.label);
      b.classList.toggle('sel', s.theme === th.k);
      b.addEventListener('click', () => saveSettings({ theme: th.k }));
      box.appendChild(b);
    }
    $('opacitySlider').value = Math.round(s.opacity * 100);
    $('opacityVal').textContent = Math.round(s.opacity * 100) + '%';
    $('soundChk').checked = s.sound;
    $('soundPackSel').value = s.soundPack;
    $('snoozeSel').value = String(s.snoozeMinutes);
    $('pomoFocus').value = s.pomodoro.focus;
    $('pomoBreak').value = s.pomodoro.break;
    $('loginChk').checked = s.launchAtLogin;
    $('dndChk').checked = !!s.dndMode;
    $('overdueSel').value = String(s.overdueMinutes || 0);
    $('musicHint').textContent = s.musicFolder ? `已选择文件夹 · ${tracks.length} 首` : '未设置 · 支持 mp3 / flac / wav / m4a / ogg';
    renderPomoChips();
    $('aboutLine').textContent = `小滴答 v${state.version} · 纯本地应用，数据不出你的电脑`;
    $('setModal').classList.remove('hidden');
  }

  function saveSettings(patch) {
    return api.updateSettings(patch).then((r) => {
      if (!r.ok) toast(r.error);
      return r;
    });
  }

  function renderPomoChips() {
    const mk = (boxId, inputId, values, key) => {
      const box = $(boxId);
      box.textContent = '';
      for (const v of values) {
        const b = chip(String(v));
        b.classList.toggle('sel', Number($(inputId).value) === v);
        b.addEventListener('click', () => {
          $(inputId).value = v;
          box.querySelectorAll('.chip').forEach((x) => x.classList.remove('sel'));
          b.classList.add('sel');
          saveSettings({ [key]: v });
        });
        box.appendChild(b);
      }
    };
    mk('pomoFocusChips', 'pomoFocus', [15, 25, 45, 60], 'pomodoroFocus');
    mk('pomoBreakChips', 'pomoBreak', [5, 10, 15], 'pomodoroBreak');
  }

  function bindSettings() {
    $('opacitySlider').addEventListener('input', () => {
      const v = Number($('opacitySlider').value);
      $('opacityVal').textContent = v + '%';
      app.style.setProperty('--alpha', v / 100);
      app.style.setProperty('--alpha-hover', Math.min(1, v / 100 + 0.22));
    });
    $('opacitySlider').addEventListener('change', () => {
      clearTimeout(opacitySaveTimer);
      opacitySaveTimer = setTimeout(() => saveSettings({ opacity: Number($('opacitySlider').value) / 100 }), 250);
    });
    $('soundChk').addEventListener('change', () => saveSettings({ sound: $('soundChk').checked }));
    $('dndChk').addEventListener('change', () => saveSettings({ dndMode: $('dndChk').checked }));
    $('overdueSel').addEventListener('change', () => saveSettings({ overdueMinutes: Number($('overdueSel').value) }));
    $('soundPackSel').addEventListener('change', () => {
      const pack = $('soundPackSel').value;
      SoundKit.play('done', pack, true);
      saveSettings({ soundPack: pack });
    });
    $('snoozeSel').addEventListener('change', () => saveSettings({ snoozeMinutes: Number($('snoozeSel').value) }));
    $('pomoFocus').addEventListener('change', () => {
      const v = parseInt($('pomoFocus').value, 10);
      if (Number.isInteger(v) && v >= 1 && v <= 180) saveSettings({ pomodoroFocus: v });
      else toast('专注时长需为 1-180 分钟');
    });
    $('pomoBreak').addEventListener('change', () => {
      const v = parseInt($('pomoBreak').value, 10);
      if (Number.isInteger(v) && v >= 1 && v <= 60) saveSettings({ pomodoroBreak: v });
      else toast('休息时长需为 1-60 分钟');
    });
    $('loginChk').addEventListener('change', () => saveSettings({ launchAtLogin: $('loginChk').checked }));
    $('exportBtn').addEventListener('click', async () => {
      const r = await api.exportData();
      toast(r.ok ? '已导出备份' : r.error);
    });
    $('importBtn').addEventListener('click', async () => {
      const r = await api.importData();
      toast(r.ok ? '导入成功' : r.error);
    });
    $('musicPickBtn').addEventListener('click', async () => {
      const r = await api.pickMusicFolder();
      toast(r.ok ? `已加载 ${r.tracks.length} 首曲目` : r.error);
    });
    $('musicClearBtn').addEventListener('click', async () => {
      const r = await saveSettings({ musicFolder: '' });
      if (r.ok) { clearMusicUI(); toast('已清除音乐文件夹'); }
    });
    $('setClose').addEventListener('click', () => $('setModal').classList.add('hidden'));
  }

  // ---------- 每日打卡月历 ----------
  let calOffset = 0;

  function openHeatmap() {
    calOffset = 0;
    renderCalendar();
    $('heatModal').classList.remove('hidden');
  }

  function renderCalendar() {
    const base = new Date();
    const d = new Date(base.getFullYear(), base.getMonth() + calOffset, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    $('calTitle').textContent = `${y}年${m}月`;
    const grid = $('calGrid');
    grid.textContent = '';
    const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7; // 周一=0
    const daysIn = new Date(y, m, 0).getDate();
    const today = todayStr();
    for (let i = 0; i < firstDow; i++) grid.appendChild(document.createElement('span'));
    for (let day = 1; day <= daysIn; day++) {
      const key = `${y}-${pad(m)}-${pad(day)}`;
      const count = (state.heat && state.heat[key]) || 0;
      const cell = document.createElement('span');
      cell.className = 'calCell h' + (count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4);
      cell.textContent = day;
      if (key === today) cell.classList.add('today');
      cell.title = `${key} · 完成 ${count} 次`;
      grid.appendChild(cell);
    }
  }

  // ---------- 迷你模式 ----------
  function setMiniClass(v) {
    app.classList.toggle('mini', v);
    $('miniBox').classList.toggle('hidden', !v);
    if (v) tickClock();
  }

  // ---------- 模板管理 ----------
  let editingTplId = null;
  let ftRepSel = 'daily';
  let ftWeekdays = [1, 2, 3, 4, 5];

  function repeatLabelLocal(r) {
    if (r.type === 'once') return '仅一次';
    if (r.type === 'daily') return '每天';
    if (r.type === 'workdays') return '工作日';
    if (r.type === 'weekdays') return '周' + r.weekdays.slice().sort().map((d) => WEEK[d]).join('');
    if (r.type === 'interval') {
      const base = r.minutes === 60 ? '每1小时'
        : r.minutes % 60 === 0 ? `每${r.minutes / 60}小时`
          : `每${r.minutes}分钟`;
      return r.activeWindow ? `${base} · ${r.activeWindow[0]}起` : base;
    }
    return '';
  }

  function openTplManager() {
    renderTplList();
    $('tplModal').classList.remove('hidden');
  }

  function renderTplList() {
    const list = $('tplList');
    list.textContent = '';
    if (!state.customTemplates.length) {
      const e = document.createElement('div');
      e.className = 'tplEmpty';
      e.textContent = '还没有模板，点下面新建一个';
      list.appendChild(e);
    }
    for (const tp of state.customTemplates) {
      const row = document.createElement('div');
      row.className = 'tplRow';
      const info = document.createElement('div');
      info.className = 'tplInfo';
      const nm = document.createElement('div');
      nm.className = 'tTitle';
      nm.textContent = tp.title;
      const sm = document.createElement('div');
      sm.className = 'tSub';
      sm.textContent = `${tp.time} · ${repeatLabelLocal(tp.repeat)}`;
      info.append(nm, sm);
      const edit = document.createElement('button');
      edit.className = 'chip';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openTplForm(tp));
      const del = document.createElement('button');
      del.className = 'chip';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        row.classList.add('removing');
        const r = await api.deleteTemplate(tp.id);
        if (!r.ok) { row.classList.remove('removing'); toast(r.error); return; }
        setTimeout(renderTplList, 200); // 等淡出动画播完再刷新
      });
      row.append(info, edit, del);
      list.appendChild(row);
    }
  }

  function renderFtRepChips() {
    const box = $('ftRepChips');
    box.textContent = '';
    for (const rc of REP_CHIPS) {
      const b = chip(rc.label);
      b.classList.toggle('sel', ftRepSel === rc.k);
      b.addEventListener('click', () => { ftRepSel = rc.k; renderFtRepChips(); });
      box.appendChild(b);
    }
    $('ftRepCustom').classList.toggle('hidden', ftRepSel !== 'custom');
    if (ftRepSel === 'custom') $('ftRepCustom').classList.remove('hidden');
  }

  function renderFtWeekdays() {
    const row = $('ftWeekdayRow');
    row.textContent = '';
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const b = chip(WEEK[d]);
      b.classList.toggle('sel', ftWeekdays.includes(d));
      b.addEventListener('click', () => {
        ftWeekdays = ftWeekdays.includes(d) ? ftWeekdays.filter((x) => x !== d) : [...ftWeekdays, d];
        renderFtWeekdays();
      });
      row.appendChild(b);
    }
  }

  function ftFillRepeat(r) {
    ftWeekdays = [1, 2, 3, 4, 5];
    $('ftInterval').value = '';
    $('ftUnit').value = 'm';
    $('ftWinStart').value = (r && r.activeWindow && r.activeWindow[0]) || '09:00';
    $('ftWinEnd').value = (r && r.activeWindow && r.activeWindow[1]) || '22:00';
    if (r.type === 'once' || r.type === 'daily' || r.type === 'workdays') ftRepSel = r.type;
    else if (r.type === 'interval' && r.minutes === 60 && r.activeWindow[0] === '09:00' && r.activeWindow[1] === '22:00') ftRepSel = 'everyhour';
    else {
      ftRepSel = 'custom';
      if (r.type === 'weekdays') ftWeekdays = [...r.weekdays];
      if (r.type === 'interval') {
        $('ftInterval').value = r.minutes % 60 === 0 && r.minutes >= 60 ? String(r.minutes / 60) : String(r.minutes);
        $('ftUnit').value = r.minutes % 60 === 0 && r.minutes >= 60 ? 'h' : 'm';
      }
    }
    renderFtRepChips();
    renderFtWeekdays();
  }

  function ftBuildRepeat() {
    if (ftRepSel === 'custom') {
      const n = parseInt($('ftInterval').value, 10);
      const win = [$('ftWinStart').value, $('ftWinEnd').value];
      if (Number.isInteger(n) && n >= 1) {
        const minutes = $('ftUnit').value === 'h' ? n * 60 : n;
        if (minutes > 1440) throw new Error('间隔不能超过 24 小时');
        return { type: 'interval', minutes, activeWindow: win[0] && win[1] ? win : ['09:00', '22:00'] };
      }
      if (ftWeekdays.length) return { type: 'weekdays', weekdays: [...ftWeekdays] };
      throw new Error('自定义重复：请填间隔或选择周几');
    }
    if (ftRepSel === 'everyhour') return { type: 'interval', minutes: 60 };
    return { type: ftRepSel };
  }

  function openTplForm(tp) {
    editingTplId = tp ? tp.id : null;
    $('tplFormTitle').textContent = tp ? '编辑模板' : '新建模板';
    $('ftTitle').value = tp ? tp.title : '';
    setFormTime('ft', tp ? tp.time : '09:00');
    ftFillRepeat(tp ? tp.repeat : { type: 'daily' });
    $('tplFormModal').classList.remove('hidden');
  }

  async function saveTplForm() {
    try {
      const payload = { title: $('ftTitle').value, time: getFormTime('ft'), repeat: ftBuildRepeat() };
      const res = editingTplId ? await api.updateTemplate(editingTplId, payload) : await api.addTemplate(payload);
      if (!res.ok) { toast(res.error); return; }
      toast(editingTplId ? `已更新模板「${payload.title}」` : `已新建模板「${payload.title}」`);
      $('tplFormModal').classList.add('hidden');
      renderTplList();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- 缩放把手（rAF 合帧：每帧最多一次 IPC） ----------
  function createResizeHandles() {
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const h = document.createElement('div');
      h.className = 'rz rz-' + edge;
      h.addEventListener('pointerdown', (e) => {
        if (app.classList.contains('mini')) return;
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const sx = e.clientX, sy = e.clientY;
        let latest = null;
        let raf = 0;
        api.resizeStart(edge);
        const move = (ev) => {
          latest = [ev.clientX - sx, ev.clientY - sy];
          if (!raf) {
            raf = requestAnimationFrame(() => {
              raf = 0;
              if (latest) api.resizeMove(edge, latest[0], latest[1]);
            });
          }
        };
        const up = () => {
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          if (latest) api.resizeMove(edge, latest[0], latest[1]);
          latest = null;
          api.resizeEnd();
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
      });
      app.appendChild(h);
    }
  }

  // ---------- 本地音乐（播放列表来自主进程扫描，控制纯渲染层） ----------
  let tracks = [];
  let trackIdx = 0;
  const audio = new Audio();

  function clearMusicUI() {
    tracks = [];
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    $('mTrackName').textContent = '—';
    $('mSeek').value = 0;
    $('mPlay').textContent = '▶';
    $('musicBar').dataset.state = 'empty';
  }

  function applyTracks(list) {
    tracks = list || [];
    trackIdx = 0;
    $('musicBar').dataset.state = tracks.length ? 'ready' : 'empty';
    if (tracks.length) {
      audio.src = tracks[0].url;
      $('mTrackName').textContent = tracks[0].name;
    }
  }

  async function loadMusicList() {
    const r = await api.musicList();
    if (!r.ok) {
      clearMusicUI();
      if (state && state.settings.musicFolder) toast('音乐文件夹无法读取，已停用音乐栏');
      return;
    }
    applyTracks(r.tracks);
  }

  function bindMusic() {
    // 未设置音乐文件夹：整条可点，直达设置的音乐分区（瞬时滚动，被遮挡/节流时也可靠）
    $('musicBar').addEventListener('click', () => {
      if ($('musicBar').dataset.state !== 'empty') return;
      openSettings();
      const sec = $('musicSection');
      if (sec) sec.scrollIntoView({ block: 'center' });
    });
    const playAt = (i) => {
      if (!tracks.length) return;
      trackIdx = (i + tracks.length) % tracks.length;
      audio.src = tracks[trackIdx].url;
      $('mTrackName').textContent = tracks[trackIdx].name;
      audio.play();
      $('mPlay').textContent = '⏸';
    };
    $('mPlay').addEventListener('click', () => {
      if (!tracks.length) return;
      if (audio.paused) { audio.play(); $('mPlay').textContent = '⏸'; }
      else { audio.pause(); $('mPlay').textContent = '▶'; }
    });
    $('mNext').addEventListener('click', () => playAt(trackIdx + 1));
    $('mPrev').addEventListener('click', () => playAt(trackIdx - 1));
    audio.addEventListener('ended', () => playAt(trackIdx + 1));
    audio.addEventListener('timeupdate', () => {
      if (audio.duration) $('mSeek').value = Math.round(audio.currentTime / audio.duration * 1000);
    });
    $('mSeek').addEventListener('input', () => {
      if (audio.duration) audio.currentTime = Number($('mSeek').value) / 1000 * audio.duration;
    });
  }

  // ---------- 主循环 ----------
  function renderAll() {
    applyVisualSettings();
    renderTasks();
    renderPomo();
  }

  async function init() {
    state = await api.getState();
    if (state.recovered && state.recovered.fatal) toast('数据文件损坏且无法恢复，已从空数据开始');
    else if (state.recovered) toast('检测到数据损坏，已从备份恢复');
    let knownFolder = null;
    api.onState((s) => {
      state = s;
      renderAll();
      if (!$('heatModal').classList.contains('hidden')) renderCalendar();
      // 音乐文件夹变更（选择/清除/导入备份）时刷新列表
      if (s.settings.musicFolder !== knownFolder) {
        knownFolder = s.settings.musicFolder;
        if (knownFolder) loadMusicList();
        else clearMusicUI();
      }
    });
    api.onMini(setMiniClass);
    renderAll();
    tickClock();
    setInterval(tickClock, 1000);
    renderTimeChips();
    if (state.settings.musicFolder) { knownFolder = state.settings.musicFolder; loadMusicList(); }

    // 事件绑定
    $('pinBtn').addEventListener('click', () => api.setPinned(!state.settings.pinned));
    $('settingsBtn').addEventListener('click', openSettings);
    $('miniBtn').addEventListener('click', () => api.setMini(true));
    $('closeBtn').addEventListener('click', () => api.hideToTray());
    $('miniRestore').addEventListener('click', () => api.setMini(false));
    $('addBtn').addEventListener('click', () => openTaskModal(null));
    $('tplBtn').addEventListener('click', openTplManager);
    $('tplNew').addEventListener('click', () => openTplForm(null));
    $('tplClose').addEventListener('click', () => $('tplModal').classList.add('hidden'));
    $('ftCancel').addEventListener('click', () => $('tplFormModal').classList.add('hidden'));
    $('ftSave').addEventListener('click', saveTplForm);
    $('quitBtn').addEventListener('click', () => api.quitApp());
    $('pomoTime').addEventListener('click', () => { if (state.pomodoro.phase === 'idle') openSettings(); });
    $('streakBtn').addEventListener('click', openHeatmap);
    $('taskCancel').addEventListener('click', () => $('taskModal').classList.add('hidden'));
    $('taskSave').addEventListener('click', saveTask);
    $('heatClose').addEventListener('click', () => $('heatModal').classList.add('hidden'));
    $('pomoBtn').addEventListener('click', () => {
      if (state.pomodoro.phase === 'idle') api.pomoStart();
      else api.pomoControl('stop');
    });
    document.querySelectorAll('.timeRow [data-step]').forEach((b) => {
      b.addEventListener('click', () => {
        const cur = getFormTime('f');
        setFormTime('f', minutesToTime((timeToMinutes(cur) + Number(b.dataset.step) + 1440) % 1440));
      });
    });
    bindSteppers('f');
    bindSteppers('ft');
    $('calPrev').addEventListener('click', () => { calOffset -= 1; renderCalendar(); });
    $('calNext').addEventListener('click', () => { calOffset += 1; renderCalendar(); });
    bindSettings();
    bindMusic();
    createResizeHandles();
  }

  init();
})();
