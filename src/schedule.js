// 纯函数模块：提醒时刻（occurrence）计算与展示标签。不依赖 Electron，可单独冒烟测试。
const pad = (n) => String(n).padStart(2, '0');

function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hhmm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function minutesOf(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function timeOf(m) {
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// 去重键：任务id + 日期 + 时刻（策划书 3.3）
function occKey(id, date, time) {
  return `${id}|${date}|${time}`;
}

// 某任务在某天的全部触发时刻（已排序）
function occurrencesForDate(task, date) {
  if (!task.enabled) return [];
  const r = task.repeat;
  const dow = date.getDay(); // 0=周日
  const out = [];
  if (r.type === 'once') {
    // 仅一次：date 优先，其次 createdOn（创建日）；两者都无的旧数据视为每天（靠归档清理）
    const day = task.date || task.createdOn;
    if (!day || day === dateStr(date)) out.push(task.time);
  } else if (r.type === 'daily') {
    out.push(task.time);
  } else if (r.type === 'workdays') {
    if (dow >= 1 && dow <= 5) out.push(task.time);
  } else if (r.type === 'weekdays') {
    if (r.weekdays.includes(dow)) out.push(task.time);
  } else if (r.type === 'interval') {
    const winStart = minutesOf(r.activeWindow[0]);
    const winEnd = minutesOf(r.activeWindow[1]);
    const start = Math.max(minutesOf(task.time), winStart);
    for (let m = start; m <= winEnd; m += r.minutes) out.push(timeOf(m));
  }
  return out.sort();
}

// 任务行指向的 occurrence：今天最新一个已到点的；没有则取今天下一个；今天没有则 null
function currentOccurrence(task, now) {
  const occs = occurrencesForDate(task, now);
  if (!occs.length) return null;
  const cur = hhmm(now);
  let latest = null;
  let next = null;
  for (const t of occs) {
    if (t <= cur) latest = t;
    else if (!next) next = t;
  }
  return latest || next;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function repeatLabel(task) {
  const r = task.repeat;
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

module.exports = { dateStr, hhmm, minutesOf, timeOf, occKey, occurrencesForDate, currentOccurrence, repeatLabel };
