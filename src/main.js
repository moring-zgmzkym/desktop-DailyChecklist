// 主进程：窗口、托盘、调度循环、IPC、系统通知兜底、单实例锁。
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, powerMonitor, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store, sanitizeTask, sanitizeRepeat, TIME_RE, isDateStr } = require('./store');
const { createLogger } = require('./logger');
const S = require('./schedule');

app.setAppUserModelId('com.local.xiaodida');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  const log = createLogger(app.getPath('userData'));
  const st = new Store(app.getPath('userData'), log);
  let widget = null;
  let reminderWin = null;
  let tray = null;
  let quitting = false;
  let miniMode = false;
  let savedBounds = null;
  let recoveredInfo = null;

  // 待处理提醒 / 贪睡排程 / 番茄钟
  let pending = []; // {key, occKey, taskId, title, timeLabel, type:'task'|'pomo', pomoPhase, firedAt, notified}
  const scheduled = []; // {key, occKey, taskId, title, at}
  const firedKeys = new Map();
  const pomo = { phase: 'idle', endsAt: 0, totalSec: 0 };
  let boundsTimer = null;

  process.on('uncaughtException', (e) => log.error('uncaught: ' + (e.stack || e.message)));

  app.on('second-instance', () => showWidget());
  app.on('before-quit', () => { quitting = true; st.flush(); });

  // ---------- 提醒 ----------

  function fireReminder(item) {
    if (firedKeys.has(item.key)) return;
    firedKeys.set(item.key, Date.now());
    if (firedKeys.size > 800) {
      let n = 400;
      for (const k of firedKeys.keys()) { firedKeys.delete(k); if (--n <= 0) break; }
    }
    pending.push({ ...item, firedAt: Date.now(), notified: false });
    showReminderWindow();
    if (item.type === 'task') armNotify(item.key, item.title, item.timeLabel);
    broadcast();
  }

  // 弹窗 2 分钟未处理 → 补发系统通知（策划书 3.3）；免打扰中重排不发
  function armNotify(key, title, label) {
    setTimeout(() => {
      const it = pending.find((p) => p.key === key);
      if (!it || it.notified) return;
      if (st.data.settings.dndMode) { armNotify(key, title, label); return; }
      it.notified = true;
      if (Notification.isSupported()) {
        const n = new Notification({ title: '小滴答 · 有提醒待处理', body: `${title}（${label}）` });
        n.on('click', () => showReminderWindow());
        n.show();
      }
    }, 120000);
  }

  function completeOccurrence(occKey, taskId) {
    const firstDone = st.data.handled[occKey] !== 'done';
    st.data.handled[occKey] = 'done';
    if (firstDone) {
      const dk = S.dateStr(new Date());
      st.data.stats.days[dk] = (st.data.stats.days[dk] || 0) + 1;
      if (st.data.stats.lastStreakDate !== dk) {
        const yesterday = S.dateStr(new Date(Date.now() - 86400000));
        st.data.stats.streak = st.data.stats.lastStreakDate === yesterday ? st.data.stats.streak + 1 : 1;
        st.data.stats.lastStreakDate = dk;
      }
    }
    st.scheduleSave();
  }

  function removePendingByTask(taskId) {
    pending = pending.filter((p) => p.taskId !== taskId);
  }

  function hideReminderIfEmpty() {
    if (!pending.length) {
      if (reminderWin && !reminderWin.isDestroyed()) reminderWin.hide();
      return;
    }
    // 免打扰中：即使还有未处理弹窗也保持隐藏，绝不穿墙弹出
    if (st.data.settings.dndMode) return;
    showReminderWindow();
  }

  function reminderAction(payload) {
    const { key, action } = payload;
    const idx = pending.findIndex((p) => p.key === key);
    if (idx < 0) return { ok: false, error: '该提醒已处理' };
    const item = pending[idx];
    pending.splice(idx, 1);
    if (action === 'done') {
      completeOccurrence(item.occKey, item.taskId);
    } else if (action === 'skip') {
      st.data.handled[item.occKey] = 'skip';
      st.scheduleSave();
    } else if (action === 'snooze') {
      const m = [5, 10, 15, 30].includes(payload.minutes) ? payload.minutes : st.data.settings.snoozeMinutes;
      scheduled.push({ key: item.key + '|s' + Date.now(), occKey: item.occKey, taskId: item.taskId, title: item.title, at: Date.now() + m * 60000 });
    } else if (action === 'break') {
      startPomo('break');
    } else if (action === 'focus') {
      startPomo('focus');
    } else if (action === 'stop') {
      pomo.phase = 'idle';
    } else {
      return { ok: false, error: '未知操作' };
    }
    hideReminderIfEmpty();
    broadcast();
    return { ok: true };
  }

  const taskIdSafe = (id) => id;

  function todayAtMs(hm) {
    const [h, m] = hm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  // ---------- 调度循环（15s，非每秒轮询） ----------

  let lastDateKey = null;

  // 跨天清理：仅一次任务过了其日期/创建日后再也不会触发，直接移除
  function purgeExpiredOnce(dk) {
    const before = st.data.tasks.length;
    st.data.tasks = st.data.tasks.filter((t) => !(t.repeat.type === 'once' && (
      (t.date && t.date < dk) || (t.createdOn && t.createdOn < dk) || (!t.date && !t.createdOn)
    )));
    if (st.data.tasks.length !== before) {
      log.info('purged ' + (before - st.data.tasks.length) + ' expired once tasks');
      st.scheduleSave();
    }
  }

  function tick() {
    const now = new Date();
    const dk = S.dateStr(now);
    const cur = S.hhmm(now);
    if (lastDateKey && dk !== lastDateKey) {
      purgeExpiredOnce(dk);
      broadcast(); // 跨天强制刷新（任务状态/霸屏依赖新鲜数据）
    }
    lastDateKey = dk;
    const dnd = !!st.data.settings.dndMode;
    if (!dnd) {
      for (const t of st.data.tasks) {
        if (!t.enabled) continue;
        for (const occ of S.occurrencesForDate(t, now)) {
          if (occ !== cur) continue;
          fireReminder({ key: S.occKey(t.id, dk, occ), occKey: S.occKey(t.id, dk, occ), taskId: t.id, title: t.title, timeLabel: occ, type: 'task' });
        }
      }
      for (let i = scheduled.length - 1; i >= 0; i--) {
        const s = scheduled[i];
        if (s.at <= Date.now()) {
          scheduled.splice(i, 1);
          fireReminder({ key: s.key, occKey: s.occKey, taskId: s.taskId, title: s.title, timeLabel: '稍后', type: 'task' });
        }
      }
    }
    if (pomo.phase !== 'idle' && Date.now() >= pomo.endsAt) {
      const phase = pomo.phase;
      pomo.phase = 'idle';
      if (dnd) {
        log.info('pomodoro finished during dnd, dropped');
      } else {
        fireReminder({
          key: 'pomo|' + phase + '|' + Date.now(), occKey: '', taskId: '',
          title: phase === 'focus' ? '专注完成，休息一下 ☕' : '休息结束，开始下一轮 🍅',
          timeLabel: '', type: 'pomo', pomoPhase: phase,
        });
      }
    }
    // 霸屏阈值跨越依赖周期性刷新：存在开启霸屏的启用任务时随心跳广播
    if (!dnd && st.data.tasks.some((t) => t.enabled && t.overdueAlert)) broadcast();
  }

  // 唤醒/启动后补弹今天错过的（策划书 3.3 / 4）；免打扰中跳过，关闭时统一补弹
  function sweepMissed() {
    if (st.data.settings.dndMode) return;
    const now = new Date();
    const dk = S.dateStr(now);
    const cur = S.hhmm(now);
    for (const t of st.data.tasks) {
      if (!t.enabled) continue;
      for (const occ of S.occurrencesForDate(t, now)) {
        if (occ >= cur) continue;
        const key = S.occKey(t.id, dk, occ);
        if (st.data.handled[key]) continue;
        fireReminder({ key, occKey: key, taskId: t.id, title: t.title, timeLabel: occ, type: 'task' });
      }
    }
  }

  // ---------- 番茄钟 ----------

  function startPomo(phase) {
    const cfg = st.data.settings.pomodoro;
    const mins = phase === 'focus' ? cfg.focus : cfg.break;
    pomo.phase = phase;
    pomo.totalSec = mins * 60;
    pomo.endsAt = Date.now() + mins * 60000;
    broadcast();
  }

  // ---------- 视图模型（渲染层零业务逻辑） ----------

  function viewModel() {
    const now = new Date();
    const dk = S.dateStr(now);
    const cur = S.hhmm(now);
    const dnd = !!st.data.settings.dndMode;
    const threshold = st.data.settings.overdueMinutes || 0;
    const tasks = st.data.tasks.map((t) => {
      const occ = S.currentOccurrence(t, now);
      const key = occ ? S.occKey(t.id, dk, occ) : null;
      const handledState = key && st.data.handled[key] ? st.data.handled[key] : null;
      const state = handledState || 'pending';
      // 超时霸屏：开关开 + 已到点未处理 + 超时时长达阈值 + 非免打扰 + 不在贪睡排程中
      let minutesLate = 0;
      if (occ && occ <= cur) minutesLate = Math.round((Date.now() - todayAtMs(occ)) / 60000);
      const overdue = !!(t.enabled && t.overdueAlert && occ && occ <= cur && !handledState && !dnd
        && minutesLate >= threshold
        && !scheduled.some((s) => s.occKey === key));
      return {
        id: t.id, title: t.title, enabled: t.enabled, time: t.time, date: t.date || null,
        overdueAlert: !!t.overdueAlert, repeat: t.repeat, repeatLabel: S.repeatLabel(t),
        state, overdue, occ: occ || null,
      };
    });
    const pendingVm = pending.map((p) => ({ key: p.key, type: p.type, title: p.title, timeLabel: p.timeLabel, pomoPhase: p.pomoPhase || null }));
    return {
      tasks, pending: pendingVm,
      doneToday: st.data.stats.days[dk] || 0,
      streak: st.data.stats.streak,
      heat: st.data.stats.days,
      settings: st.data.settings,
      customTemplates: st.data.customTemplates,
      pomodoro: { phase: pomo.phase, endsAt: pomo.endsAt, totalSec: pomo.totalSec },
      version: app.getVersion(),
      recovered: recoveredInfo,
    };
  }

  function broadcast() {
    if (widget && !widget.isDestroyed()) widget.webContents.send('state', viewModel());
  }

  // ---------- 窗口 ----------

  const PRELOAD = path.join(__dirname, 'preload.js');

  function boundsOnScreen(b) {
    if (!b) return false;
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return b.x < wa.x + wa.width - 40 && b.x + b.width > wa.x + 40 && b.y < wa.y + wa.height - 40 && b.y + b.height > wa.y + 40;
    });
  }

  function createWidget() {
    const s = st.data.settings;
    widget = new BrowserWindow({
      width: 300, height: 460, minWidth: 260, minHeight: 360, maxWidth: 480, maxHeight: 760,
      frame: false, transparent: true, resizable: true, skipTaskbar: true,
      maximizable: false, fullscreenable: false, backgroundColor: '#00000000',
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    widget.setAlwaysOnTop(!!s.pinned, 'floating');
    const saved = s.widgetBounds;
    if (saved && boundsOnScreen({ x: saved.x, y: saved.y, width: saved.w, height: saved.h })) {
      widget.setBounds({ x: saved.x, y: saved.y, width: saved.w, height: saved.h });
    } else {
      widget.center();
    }
    widget.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    widget.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (level >= 1) log.info(`[renderer] ${message} (${sourceId.split(/[\\/]/).pop()}:${line})`);
    });
    widget.on('close', (e) => {
      if (!quitting) { e.preventDefault(); widget.hide(); }
    });
    widget.on('move', saveBoundsSoon);
    widget.on('resize', saveBoundsSoon);
    widget.webContents.on('render-process-gone', () => {
      log.error('widget renderer gone, reloading');
      setTimeout(() => { if (widget && !widget.isDestroyed()) widget.webContents.reload(); }, 1000);
    });
  }

  function saveBoundsSoon() {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (miniMode || !widget || widget.isDestroyed() || !widget.isVisible()) return;
      const b = widget.getBounds();
      st.data.settings.widgetBounds = { x: b.x, y: b.y, w: b.width, h: b.height };
      st.scheduleSave();
    }, 800);
  }

  function showWidget() {
    if (!widget || widget.isDestroyed()) { createWidget(); return; }
    widget.show();
  }

  function createReminderWin() {
    reminderReady = false;
    reminderWin = new BrowserWindow({
      width: 340, height: 240, frame: false, transparent: true, resizable: false, movable: false,
      show: false, skipTaskbar: true, focusable: false, backgroundColor: '#00000000',
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    reminderWin.setAlwaysOnTop(true, 'floating');
    reminderWin.loadFile(path.join(__dirname, 'renderer', 'reminder.html'));
    reminderWin.webContents.on('did-finish-load', () => {
      reminderReady = true;
      if (pending.length) showReminderWindow(); // 补发创建期间错过的提醒事件
    });
    reminderWin.webContents.on('render-process-gone', () => {
      log.error('reminder renderer gone, recreating');
      reminderWin = null;
      reminderReady = false;
      if (pending.length) showReminderWindow();
    });
    reminderWin.on('closed', () => { reminderWin = null; reminderReady = false; });
  }

  function showReminderWindow() {
    if (!reminderWin || reminderWin.isDestroyed()) {
      createReminderWin(); // did-finish-load 后会重新进入本函数
      return;
    }
    if (!reminderReady) return;
    const n = Math.max(pending.length, 1);
    const h = Math.min(640, 120 + n * 118);
    reminderWin.setBounds({ width: 340, height: h });
    const wa = screen.getPrimaryDisplay().workArea;
    reminderWin.setPosition(wa.x + wa.width - 340 - 14, wa.y + wa.height - h - 14);
    reminderWin.webContents.send('reminders', pending.map((p) => ({ key: p.key, type: p.type, title: p.title, timeLabel: p.timeLabel, pomoPhase: p.pomoPhase || null })));
    if (!reminderWin.isVisible()) reminderWin.showInactive();
  }

  function createTray() {
    let icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon-32.png'));
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('小滴答 · 桌面提醒');
    rebuildTrayMenu();
    tray.on('click', toggleWidgetVisible);
  }

  function rebuildTrayMenu() {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏小组件', click: toggleWidgetVisible },
      { type: 'separator' },
      {
        label: '免打扰（游戏/演示：到点不弹窗，关闭后补弹）',
        type: 'checkbox',
        checked: !!st.data.settings.dndMode,
        click: (item) => applyDnd(item.checked),
      },
      { type: 'separator' },
      { label: '立即退出', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  // 免打扰中心开关：托盘与设置面板共用
  function applyDnd(v) {
    const cur = !!st.data.settings.dndMode;
    st.data.settings.dndMode = !!v;
    if (!!v !== cur) {
      if (v) {
        if (reminderWin && !reminderWin.isDestroyed() && reminderWin.isVisible()) reminderWin.hide();
        log.info('dnd on');
      } else {
        log.info('dnd off, sweeping missed');
        sweepMissed(); // 内部 dnd 已为 false，会补弹今天错过的（firedKeys 去重）
        if (pending.length) showReminderWindow();
      }
    }
    rebuildTrayMenu();
    st.scheduleSave();
    broadcast();
  }

  function toggleWidgetVisible() {
    if (!widget || widget.isDestroyed()) { createWidget(); return; }
    if (widget.isVisible()) widget.hide();
    else widget.show();
  }

  // ---------- IPC（逐参数校验） ----------

  const str = (v, max) => {
    const s = String(v ?? '').trim();
    if (!s || s.length > max) throw new Error('文本需为 1-' + max + ' 字');
    return s;
  };
  const time = (v) => {
    if (typeof v !== 'string' || !TIME_RE.test(v)) throw new Error('时间格式应为 HH:MM');
    return v;
  };

  function readTaskInput(inp) {
    if (!inp || typeof inp !== 'object') throw new Error('参数错误');
    const out = {
      title: str(inp.title, 50),
      time: time(inp.time),
      repeat: sanitizeRepeat(inp.repeat) || (() => { throw new Error('重复规则无效'); })(),
    };
    if (inp.date) {
      if (!isDateStr(inp.date)) throw new Error('日期格式无效');
      if (inp.date < S.dateStr(new Date())) throw new Error('日期不能早于今天');
      out.date = inp.date;
    }
    return out;
  }

  function setupIpc() {
    const wrap = (fn) => (e, payload) => {
      try { return fn(payload) ?? { ok: true }; }
      catch (err) { log.error('ipc: ' + err.message); return { ok: false, error: err.message }; }
    };

    ipcMain.handle('state:get', wrap(() => viewModel()));

    ipcMain.handle('task:add', wrap((inp) => {
      const t = readTaskInput(inp);
      const task = sanitizeTask({ ...t, id: st.newId() });
      if (!task) throw new Error('任务数据无效');
      if (st.data.tasks.length >= 500) throw new Error('任务数已达上限');
      if (task.repeat.type === 'once' && !task.date) task.createdOn = S.dateStr(new Date());
      st.data.tasks.push(task);
      st.scheduleSave();
      broadcast();
      return { ok: true, id: task.id };
    }));

    ipcMain.handle('task:update', wrap(({ id, patch }) => {
      const t = st.data.tasks.find((x) => x.id === id);
      if (!t) throw new Error('任务不存在');
      if (patch && typeof patch === 'object') {
        if (patch.title !== undefined) t.title = str(patch.title, 50);
        if (patch.time !== undefined) t.time = time(patch.time);
        if (patch.repeat !== undefined) {
          const r = sanitizeRepeat(patch.repeat);
          if (!r) throw new Error('重复规则无效');
          t.repeat = r;
        }
        if (patch.date !== undefined) {
          if (patch.date === null || patch.date === '') delete t.date;
          else {
            if (!isDateStr(patch.date)) throw new Error('日期格式无效');
            if (patch.date < S.dateStr(new Date())) throw new Error('日期不能早于今天');
            t.date = patch.date;
          }
        }
        if (patch.overdueAlert !== undefined) {
          if (patch.overdueAlert) t.overdueAlert = true;
          else delete t.overdueAlert;
        }
        // 重复规则不再是「仅一次」时，残留的日期一并清除
        if (t.repeat.type !== 'once') delete t.date;
      }
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('task:delete', wrap(({ id }) => {
      const t = st.data.tasks.find((x) => x.id === id);
      if (t) lastDeleted = { task: t, at: Date.now() };
      st.data.tasks = st.data.tasks.filter((x) => x.id !== id);
      removePendingByTask(id);
      hideReminderIfEmpty();
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('task:undoDelete', wrap(() => {
      if (!lastDeleted) return { ok: false, error: '没有可撤销的删除' };
      if (Date.now() - lastDeleted.at > 5000) {
        lastDeleted = null;
        return { ok: false, error: '撤销时限（5 秒）已过' };
      }
      if (st.data.tasks.length >= 500) return { ok: false, error: '任务数已达上限' };
      if (!st.data.tasks.some((t) => t.id === lastDeleted.task.id)) {
        st.data.tasks.push(lastDeleted.task);
      }
      lastDeleted = null;
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('task:toggle', wrap(({ id, enabled }) => {
      const t = st.data.tasks.find((x) => x.id === id);
      if (!t) throw new Error('任务不存在');
      t.enabled = !!enabled;
      if (!t.enabled) { removePendingByTask(id); hideReminderIfEmpty(); }
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('task:complete', wrap(({ id }) => {
      const t = st.data.tasks.find((x) => x.id === id);
      if (!t) throw new Error('任务不存在');
      const occ = S.currentOccurrence(t, new Date());
      if (!occ) throw new Error('今天没有这个任务');
      const key = S.occKey(id, S.dateStr(new Date()), occ);
      // 从待处理弹窗中同步移除
      pending = pending.filter((p) => p.occKey !== key);
      completeOccurrence(key, id);
      hideReminderIfEmpty();
      broadcast();
    }));

    ipcMain.handle('task:skip', wrap(({ id }) => {
      const t = st.data.tasks.find((x) => x.id === id);
      if (!t) throw new Error('任务不存在');
      const occ = S.currentOccurrence(t, new Date());
      if (!occ) throw new Error('今天没有这个任务');
      const key = S.occKey(id, S.dateStr(new Date()), occ);
      st.data.handled[key] = 'skip';
      pending = pending.filter((p) => p.occKey !== key);
      hideReminderIfEmpty();
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('task:snooze', wrap(({ id, minutes }) => {
      const t = st.data.tasks.find((x) => x.id === id);
      if (!t) throw new Error('任务不存在');
      const m = [5, 10, 15, 30].includes(minutes) ? minutes : st.data.settings.snoozeMinutes;
      const occ = S.currentOccurrence(t, new Date());
      const key = occ ? S.occKey(id, S.dateStr(new Date()), occ) + '|w' : S.occKey(id, S.dateStr(new Date()), t.time) + '|w';
      scheduled.push({ key, occKey: key.replace('|w', ''), taskId: id, title: t.title, at: Date.now() + m * 60000 });
      broadcast(); // 霸屏页依赖新状态：贪睡后立即暂歇
      return { ok: true, minutes: m };
    }));

    ipcMain.handle('settings:update', wrap((patch) => {
      if (!patch || typeof patch !== 'object') throw new Error('参数错误');
      const s = st.data.settings;
      if (patch.theme !== undefined) {
        if (!['lively', 'steady', 'quiet'].includes(patch.theme)) throw new Error('未知主题');
        s.theme = patch.theme;
      }
      if (patch.opacity !== undefined) {
        if (typeof patch.opacity !== 'number' || patch.opacity < 0.3 || patch.opacity > 1) throw new Error('透明度取值 0.3-1');
        s.opacity = patch.opacity;
      }
      if (patch.pinned !== undefined) { s.pinned = !!patch.pinned; widget.setAlwaysOnTop(s.pinned, 'floating'); }
      if (patch.sound !== undefined) s.sound = !!patch.sound;
      if (patch.soundPack !== undefined) {
        if (!['windchime', 'xylophone', 'drop'].includes(patch.soundPack)) throw new Error('未知音色');
        s.soundPack = patch.soundPack;
      }
      if (patch.snoozeMinutes !== undefined) {
        if (![5, 10, 15, 30].includes(patch.snoozeMinutes)) throw new Error('贪睡档位仅 5/10/15/30 分钟');
        s.snoozeMinutes = patch.snoozeMinutes;
      }
      if (patch.overdueMinutes !== undefined) {
        if (![0, 2, 5, 10, 15, 30].includes(patch.overdueMinutes)) throw new Error('霸屏阈值仅 0/2/5/10/15/30 分钟');
        s.overdueMinutes = patch.overdueMinutes;
      }
      if (patch.pomodoroFocus !== undefined) {
        if (!Number.isInteger(patch.pomodoroFocus) || patch.pomodoroFocus < 1 || patch.pomodoroFocus > 180) throw new Error('专注时长 1-180 分钟');
        s.pomodoro.focus = patch.pomodoroFocus;
      }
      if (patch.pomodoroBreak !== undefined) {
        if (!Number.isInteger(patch.pomodoroBreak) || patch.pomodoroBreak < 1 || patch.pomodoroBreak > 60) throw new Error('休息时长 1-60 分钟');
        s.pomodoro.break = patch.pomodoroBreak;
      }
      if (patch.launchAtLogin !== undefined) {
        s.launchAtLogin = !!patch.launchAtLogin;
        app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });
      }
      if (patch.dndMode !== undefined) applyDnd(!!patch.dndMode);
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('template:delete', wrap(({ id }) => {
      st.data.customTemplates = st.data.customTemplates.filter((t) => t.id !== id);
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('template:add', wrap((inp) => {
      const t = readTaskInput(inp);
      const tpl = sanitizeTask({ ...t, id: st.newId() });
      if (!tpl) throw new Error('模板数据无效');
      if (st.data.customTemplates.length >= 100) throw new Error('模板数已达上限');
      st.data.customTemplates.push(tpl);
      st.scheduleSave();
      broadcast();
      return { ok: true, id: tpl.id };
    }));

    ipcMain.handle('template:update', wrap(({ id, patch }) => {
      const t = st.data.customTemplates.find((x) => x.id === id);
      if (!t) throw new Error('模板不存在');
      if (patch && typeof patch === 'object') {
        if (patch.title !== undefined) t.title = str(patch.title, 50);
        if (patch.time !== undefined) t.time = time(patch.time);
        if (patch.repeat !== undefined) {
          const r = sanitizeRepeat(patch.repeat);
          if (!r) throw new Error('重复规则无效');
          t.repeat = r;
        }
        if (t.repeat.type !== 'once') delete t.date;
      }
      st.scheduleSave();
      broadcast();
    }));

    ipcMain.handle('win:pin', wrap((v) => {
      st.data.settings.pinned = !!v;
      widget.setAlwaysOnTop(!!v, 'floating');
      st.scheduleSave();
      broadcast();
    }));

    let hidNotifyShown = false;
    ipcMain.handle('win:hideToTray', wrap(() => {
      widget.hide();
      if (!hidNotifyShown) {
        hidNotifyShown = true;
        if (Notification.isSupported()) {
          const n = new Notification({ title: '小滴答仍在运行', body: '已隐藏到托盘：点此重新显示，或右键托盘图标选择退出' });
          n.on('click', () => showWidget());
          n.show();
        }
      }
    }));

    ipcMain.handle('app:quit', wrap(() => {
      quitting = true;
      app.quit();
    }));

    ipcMain.handle('win:mini', wrap((v) => {
      miniMode = !!v;
      if (miniMode) {
        savedBounds = widget.getBounds();
        widget.setMinimumSize(76, 76);
        widget.setBounds({ width: 76, height: 76 });
      } else {
        // 原地展开：保留小球位置，只恢复宽高，并完整钳制进最近的可视区
        const cur = widget.getBounds();
        const wa = nearestWorkArea(cur);
        const w = savedBounds ? savedBounds.width : 300;
        const h = savedBounds ? savedBounds.height : 460;
        const X = Math.min(Math.max(cur.x, wa.x), Math.max(wa.x, wa.x + wa.width - w));
        const Y = Math.min(Math.max(cur.y, wa.y), Math.max(wa.y, wa.y + wa.height - h));
        widget.setMinimumSize(260, 360);
        widget.setBounds({ x: X, y: Y, width: w, height: h });
      }
      if (widget && !widget.isDestroyed()) widget.webContents.send('mini', miniMode);
    }));

    ipcMain.handle('win:resize', wrap(({ phase, edge, dx, dy }) => {
      if (miniMode) return;
      const MIN_W = 260, MIN_H = 360, MAX_W = 480, MAX_H = 760;
      if (phase === 'start') {
        resizeDrag = { b: widget.getBounds(), edge: String(edge) };
        return;
      }
      if (phase === 'move' && resizeDrag) {
        const { b, edge: e } = resizeDrag;
        const ddx = Number(dx) | 0, ddy = Number(dy) | 0;
        let W = b.width, H = b.height;
        if (e.includes('e')) W = b.width + ddx;
        if (e.includes('w')) W = b.width - ddx;
        if (e.includes('s')) H = b.height + ddy;
        if (e.includes('n')) H = b.height - ddy;
        W = Math.min(MAX_W, Math.max(MIN_W, W));
        H = Math.min(MAX_H, Math.max(MIN_H, H));
        let X = b.x, Y = b.y;
        if (e.includes('w')) X = b.x + (b.width - W);
        if (e.includes('n')) Y = b.y + (b.height - H);
        widget.setBounds({ x: X, y: Y, width: W, height: H });
        return;
      }
      if (phase === 'end') { resizeDrag = null; saveBoundsSoon(); }
    }));

    ipcMain.handle('pomo:start', wrap(() => { startPomo('focus'); }));
    ipcMain.handle('pomo:control', wrap(({ action }) => {
      if (action === 'stop') pomo.phase = 'idle';
      else if (action === 'break') startPomo('break');
      else if (action === 'focus') startPomo('focus');
      else throw new Error('未知操作');
      broadcast();
    }));

    ipcMain.handle('reminder:action', wrap((payload) => reminderAction(payload)));

    ipcMain.handle('data:export', wrap(async () => {
      const res = await dialog.showSaveDialog(widget, {
        defaultPath: `xiaodida-backup-${S.dateStr(new Date())}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, error: '已取消' };
      fs.writeFileSync(res.filePath, st.exportText(), 'utf8');
      return { ok: true };
    }));

    ipcMain.handle('data:import', wrap(async () => {
      const res = await dialog.showOpenDialog(widget, {
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, error: '已取消' };
      const text = fs.readFileSync(res.filePaths[0], 'utf8');
      const r = st.importText(text);
      if (r.ok) broadcast();
      return r;
    }));
  }
  let reminderReady = false;
  let resizeDrag = null;
  let lastDeleted = null;

  // 距给定窗口中心最近的显示器工作区（多屏缝隙防丢球用）
  function nearestWorkArea(b) {
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    let best = areas[0];
    let bestD = Infinity;
    for (const a of areas) {
      const nx = Math.max(a.x, Math.min(cx, a.x + a.width));
      const ny = Math.max(a.y, Math.min(cy, a.y + a.height));
      const d = Math.hypot(nx - cx, ny - cy);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  // ---------- 启动 ----------

  app.whenReady().then(() => {
    recoveredInfo = st.load();
    if (recoveredInfo && recoveredInfo.fatal) log.error('data files unreadable, starting empty');
    else if (recoveredInfo && recoveredInfo.from) log.info('data loaded from ' + recoveredInfo.from);
    purgeExpiredOnce(S.dateStr(new Date()));
    if (st.data.settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true });

    // 首启模板种子：预设写入普通模板（按标题去重，不覆盖自建）；标记后不再复活
    if (!st.data.settings.templatesSeeded) {
      const existing = new Set(st.data.customTemplates.map((t) => t.title));
      const seeds = [
        ['喝水', '09:00', { type: 'interval', minutes: 120, activeWindow: ['09:00', '22:00'] }],
        ['休息眼睛', '10:00', { type: 'interval', minutes: 60 }],
        ['起身活动', '11:00', { type: 'interval', minutes: 60 }],
        ['午饭', '12:00', { type: 'daily' }],
        ['午休', '13:00', { type: 'daily' }],
        ['下班收尾', '18:00', { type: 'workdays' }],
        ['吃药', '08:00', { type: 'daily' }],
      ];
      for (const [title, tm, repeat] of seeds) {
        if (existing.has(title)) continue;
        const tpl = sanitizeTask({ id: st.newId(), title, time: tm, repeat, enabled: true });
        if (tpl && st.data.customTemplates.length < 100) st.data.customTemplates.push(tpl);
      }
      st.data.settings.templatesSeeded = true;
      st.saveNow();
    }

    setupIpc();
    createWidget();
    createReminderWin();
    createTray();
    setInterval(tick, 15000);
    setTimeout(sweepMissed, 1500);
    powerMonitor.on('resume', () => { log.info('system resume, sweeping missed'); sweepMissed(); });
    log.info('app ready');
  });

  app.on('window-all-closed', (e) => { /* 常驻托盘，不退出 */ });
}
