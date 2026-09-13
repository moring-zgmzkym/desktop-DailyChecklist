// 数据层：启动校验、原子写（tmp→file）、.bak 轮换、防抖落盘、导入导出。
// 文件恢复顺序：data.json → data.json.bak → data.json.tmp（防替换中途崩溃）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const THEMES = ['lively', 'steady', 'quiet'];
const SOUND_PACKS = ['windchime', 'xylophone', 'drop'];
const REPEAT_TYPES = ['once', 'daily', 'workdays', 'weekdays', 'interval'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function defaults() {
  return {
    settings: {
      theme: 'lively',
      opacity: 0.78,
      pinned: true,
      sound: true,
      soundPack: 'windchime',
      widgetBounds: null,
      launchAtLogin: false,
      snoozeMinutes: 5,
      dndMode: false,
      overdueMinutes: 0,
      templatesSeeded: false,
      pomodoro: { focus: 25, break: 5 },
    },
    customTemplates: [],
    tasks: [],
    handled: {}, // occKey -> 'done' | 'skip'
    stats: { days: {}, streak: 0, lastStreakDate: null },
  };
}

function isTime(v) { return typeof v === 'string' && TIME_RE.test(v); }

function isDateStr(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === 'string' ? v : '');
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function sanitizeRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  if (!REPEAT_TYPES.includes(r.type)) return null;
  const out = { type: r.type };
  if (r.type === 'weekdays') {
    if (!Array.isArray(r.weekdays)) return null;
    out.weekdays = [...new Set(r.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!out.weekdays.length) return null;
  }
  if (r.type === 'interval') {
    if (!Number.isInteger(r.minutes) || r.minutes < 1 || r.minutes > 1440) return null;
    out.minutes = r.minutes;
    if (Array.isArray(r.activeWindow) && isTime(r.activeWindow[0]) && isTime(r.activeWindow[1])) {
      out.activeWindow = [r.activeWindow[0], r.activeWindow[1]];
    } else {
      out.activeWindow = ['09:00', '22:00'];
    }
  }
  return out;
}

function sanitizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.id !== 'string' || !t.id) return null;
  if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 50) return null;
  if (!isTime(t.time)) return null;
  const repeat = sanitizeRepeat(t.repeat);
  if (!repeat) return null;
  const out = {
    id: t.id,
    title: t.title.trim(),
    time: t.time,
    repeat,
    enabled: t.enabled !== false,
  };
  // 指定日期仅对「仅一次」任务有意义
  if (repeat.type === 'once' && isDateStr(t.date)) out.date = t.date;
  // 无日期的「仅一次」按创建当天触发
  if (repeat.type === 'once' && !out.date && isDateStr(t.createdOn)) out.createdOn = t.createdOn;
  if (t.overdueAlert === true) out.overdueAlert = true;
  return out;
}

// 容器级结构必须严格：出现过的顶层字段类型不对、或完全不像本应用的数据，整体拒绝。
const TOP_LEVEL = { settings: 'object', tasks: 'array', customTemplates: 'array', stats: 'object', handled: 'object' };

function sanitize(data) {
  const d = defaults();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const present = Object.keys(TOP_LEVEL).filter((k) => data[k] !== undefined);
  if (!present.length) return null;
  for (const k of present) {
    const v = data[k];
    const good = TOP_LEVEL[k] === 'array' ? Array.isArray(v) : v && typeof v === 'object' && !Array.isArray(v);
    if (!good) return null;
  }
  const s = data.settings || {};
  if (THEMES.includes(s.theme)) d.settings.theme = s.theme;
  if (typeof s.opacity === 'number' && s.opacity >= 0.3 && s.opacity <= 1) d.settings.opacity = s.opacity;
  if (typeof s.pinned === 'boolean') d.settings.pinned = s.pinned;
  if (typeof s.sound === 'boolean') d.settings.sound = s.sound;
  if (SOUND_PACKS.includes(s.soundPack)) d.settings.soundPack = s.soundPack;
  if (s.widgetBounds && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(s.widgetBounds[k]))) {
    d.settings.widgetBounds = { x: s.widgetBounds.x | 0, y: s.widgetBounds.y | 0, w: s.widgetBounds.w | 0, h: s.widgetBounds.h | 0 };
  }
  if (typeof s.launchAtLogin === 'boolean') d.settings.launchAtLogin = s.launchAtLogin;
  if (typeof s.dndMode === 'boolean') d.settings.dndMode = s.dndMode;
  if ([0, 2, 5, 10, 15, 30].includes(s.overdueMinutes)) d.settings.overdueMinutes = s.overdueMinutes;
  if (typeof s.templatesSeeded === 'boolean') d.settings.templatesSeeded = s.templatesSeeded;
  if ([5, 10, 15, 30].includes(s.snoozeMinutes)) d.settings.snoozeMinutes = s.snoozeMinutes;
  if (s.pomodoro && Number.isInteger(s.pomodoro.focus) && Number.isInteger(s.pomodoro.break) &&
      s.pomodoro.focus >= 1 && s.pomodoro.focus <= 180 && s.pomodoro.break >= 1 && s.pomodoro.break <= 60) {
    d.settings.pomodoro = { focus: s.pomodoro.focus, break: s.pomodoro.break };
  }
  if (Array.isArray(data.customTemplates)) {
    for (const t of data.customTemplates) {
      const ok = sanitizeTask(t);
      if (ok && d.customTemplates.length < 100) d.customTemplates.push(ok);
    }
  }
  if (Array.isArray(data.tasks)) {
    for (const t of data.tasks) {
      const ok = sanitizeTask(t);
      if (ok && d.tasks.length < 500) d.tasks.push(ok);
    }
  }
  if (data.handled && typeof data.handled === 'object') {
    for (const [k, v] of Object.entries(data.handled)) {
      if ((v === 'done' || v === 'skip') && typeof k === 'string' && k.length < 200) d.handled[k] = v;
    }
  }
  if (data.stats && typeof data.stats === 'object') {
    if (data.stats.days && typeof data.stats.days === 'object') {
      for (const [k, v] of Object.entries(data.stats.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isInteger(v) && v >= 0) d.stats.days[k] = v;
      }
    }
    if (Number.isInteger(data.stats.streak) && data.stats.streak >= 0) d.stats.streak = data.stats.streak;
    if (typeof data.stats.lastStreakDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.stats.lastStreakDate)) {
      d.stats.lastStreakDate = data.stats.lastStreakDate;
    }
  }
  return d;
}

class Store {
  constructor(dir, log) {
    this.dir = dir;
    this.file = path.join(dir, 'data.json');
    this.bak = path.join(dir, 'data.json.bak');
    this.tmp = path.join(dir, 'data.json.tmp');
    this.log = log;
    this.data = null;
    this.saveTimer = null;
  }

  load() {
    let recovered = null;
    const candidates = [this.file, this.bak, this.tmp].filter((p) => fs.existsSync(p));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        const clean = sanitize(parsed);
        if (clean) {
          this.data = clean;
          recovered = { from: path.basename(candidate), fatal: false };
          break;
        }
      } catch (e) {
        this.log.error(`load ${path.basename(candidate)} failed: ${e.message}`);
      }
    }
    if (!this.data) {
      this.data = defaults();
      // 三个文件都不存在 = 正常首次运行；有文件但全读不出来 = 真损坏
      recovered = { from: null, fatal: candidates.length > 0 };
    }
    this.pruneHandled();
    return recovered;
  }

  pruneHandled() {
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    for (const k of Object.keys(this.data.handled)) {
      const datePart = k.split('|')[1];
      if (datePart && datePart < cutoff) delete this.data.handled[k];
    }
  }

  saveNow() {
    try {
      this.pruneHandled();
      fs.writeFileSync(this.tmp, JSON.stringify(this.data, null, 2));
      if (fs.existsSync(this.file)) fs.renameSync(this.file, this.bak);
      fs.renameSync(this.tmp, this.file);
    } catch (e) {
      this.log.error('saveNow failed: ' + e.message);
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  flush() {
    clearTimeout(this.saveTimer);
    if (this.data) this.saveNow();
  }

  exportText() {
    return JSON.stringify(this.data, null, 2);
  }

  // 返回 { ok } 或 { ok: false, error }
  importText(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '不是有效的 JSON 文件' };
    }
    const clean = sanitize(parsed);
    if (!clean) return { ok: false, error: '数据结构不符合要求，已拒绝导入' };
    // 条目被清洗掉说明文件内容有损坏，宁可拒绝也不静默丢数据
    const srcTasks = Array.isArray(parsed.tasks) ? parsed.tasks.length : 0;
    const srcTpls = Array.isArray(parsed.customTemplates) ? parsed.customTemplates.length : 0;
    if (srcTasks !== clean.tasks.length || srcTpls !== clean.customTemplates.length) {
      return { ok: false, error: '存在无法识别的任务条目，为避免数据丢失已拒绝导入' };
    }
    this.data = clean;
    this.saveNow();
    return { ok: true };
  }

  newId() {
    return crypto.randomUUID();
  }
}

module.exports = { Store, defaults, sanitizeTask, sanitizeRepeat, TIME_RE, isDateStr };
