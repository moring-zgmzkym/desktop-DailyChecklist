// 冒烟测试：node scripts/smoke-tests.js
// 覆盖：occurrence 计算、数据校验、原子写/.bak 恢复、非法导入拒绝。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const S = require('../src/schedule');
const { Store, sanitizeTask } = require('../src/store');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name, '\n    ', e.message);
    process.exitCode = 1;
  }
}

console.log('[schedule]');

ok('daily 每天触发一次', () => {
  const t = { enabled: true, time: '07:30', repeat: { type: 'daily' } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 13)), ['07:30']);
});

ok('weekdays 只在指定周几触发', () => {
  const t = { enabled: true, time: '10:00', repeat: { type: 'weekdays', weekdays: [1, 3] } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 14)), ['10:00']); // 周一
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 13)), []);        // 周日
});

ok('once 无日期兼容旧行为（当天触发）', () => {
  const t = { enabled: true, time: '09:00', repeat: { type: 'once' } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 15)), ['09:00']);
});

ok('once 带日期只在指定日触发', () => {
  const t = { enabled: true, time: '09:00', date: '2026-09-15', repeat: { type: 'once' } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 14)), []);
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 15)), ['09:00']);
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 16)), []);
});

ok('once 无日期按 createdOn（创建日）触发', () => {
  const t = { enabled: true, time: '09:00', createdOn: '2026-09-15', repeat: { type: 'once' } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 15)), ['09:00']);
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 16)), []);
});

ok('workdays 周末不触发', () => {
  const t = { enabled: true, time: '09:00', repeat: { type: 'workdays' } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 12)), []); // 周六
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 11)), ['09:00']); // 周五
});

ok('interval 从起始时间起算且受生效时段约束', () => {
  const t = { enabled: true, time: '09:00', repeat: { type: 'interval', minutes: 120, activeWindow: ['09:00', '22:00'] } };
  const occ = S.occurrencesForDate(t, new Date(2026, 8, 13));
  assert.equal(occ[0], '09:00');
  assert.equal(occ[occ.length - 1], '21:00');
  assert.equal(occ.length, 7);
});

ok('interval 起始时间早于生效时段时被钳制', () => {
  const t = { enabled: true, time: '07:00', repeat: { type: 'interval', minutes: 60, activeWindow: ['09:00', '11:00'] } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 13)), ['09:00', '10:00', '11:00']);
});

ok('停用的任务无 occurrence', () => {
  const t = { enabled: false, time: '09:00', repeat: { type: 'daily' } };
  assert.deepEqual(S.occurrencesForDate(t, new Date(2026, 8, 13)), []);
});

ok('currentOccurrence 取已到点最近的，否则取下一个', () => {
  // interval 从 10:00 起每 2 小时：10:00, 12:00, ..., 22:00
  const t = { enabled: true, time: '10:00', repeat: { type: 'interval', minutes: 120, activeWindow: ['09:00', '22:00'] } };
  assert.equal(S.currentOccurrence(t, new Date(2026, 8, 13, 12, 5)), '12:00');
  assert.equal(S.currentOccurrence(t, new Date(2026, 8, 13, 11, 55)), '10:00');
  assert.equal(S.currentOccurrence(t, new Date(2026, 8, 13, 8, 0)), '10:00'); // 尚未到点，取今天下一个
  assert.equal(S.currentOccurrence(t, new Date(2026, 8, 13, 23, 0)), '22:00');
});

ok('repeatLabel 展示', () => {
  assert.equal(S.repeatLabel({ repeat: { type: 'weekdays', weekdays: [1, 3, 5] } }), '周一三五');
  assert.equal(S.repeatLabel({ repeat: { type: 'interval', minutes: 120 } }), '每2小时');
  assert.equal(S.repeatLabel({ repeat: { type: 'interval', minutes: 45 } }), '每45分钟');
  assert.equal(S.repeatLabel({ repeat: { type: 'interval', minutes: 120, activeWindow: ['09:00', '22:00'] } }), '每2小时 · 09:00起');
});

console.log('[store]');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdd-test-'));
const log = { info() {}, error() {} };

ok('空目录加载得到默认数据（正常首次运行，非损坏）', () => {
  const st = new Store(dir, log);
  const rec = st.load();
  assert.equal(rec.from, null);
  assert.equal(rec.fatal, false);
  assert.deepEqual(st.data.tasks, []);
});

ok('保存后可重新加载；.bak 轮换生效', () => {
  const st = new Store(dir, log);
  st.load();
  st.data.tasks.push(sanitizeTask({ id: 't1', title: '喝水', time: '10:00', repeat: { type: 'daily' } }));
  st.saveNow();
  assert.ok(fs.existsSync(path.join(dir, 'data.json')));
  st.data.tasks.push(sanitizeTask({ id: 't2', title: '休息眼睛', time: '12:00', repeat: { type: 'daily' } }));
  st.saveNow(); // 第二次保存时第一版进入 .bak
  const st2 = new Store(dir, log);
  const rec = st2.load();
  assert.equal(rec.from, 'data.json');
  assert.equal(st2.data.tasks.length, 2);
});

ok('主文件损坏时从 .bak 恢复', () => {
  fs.writeFileSync(path.join(dir, 'data.json'), '{broken json!!!');
  const st = new Store(dir, log);
  const rec = st.load();
  assert.equal(rec.from, 'data.json.bak');
  assert.equal(rec.fatal, false);
  assert.equal(st.data.tasks.length, 1); // .bak 是第一版
});

ok('主文件和 .bak 全坏时进入空数据模式', () => {
  fs.writeFileSync(path.join(dir, 'data.json'), ' garbage');
  fs.writeFileSync(path.join(dir, 'data.json.bak'), ' garbage');
  const st = new Store(dir, log);
  const rec = st.load();
  assert.equal(rec.fatal, true);
  assert.deepEqual(st.data.tasks, []);
});

ok('非法导入被拒绝', () => {
  const st = new Store(dir, log);
  st.load();
  assert.equal(st.importText('not json').ok, false);
  assert.equal(st.importText('{}').ok, false); // 完全不像本应用的数据
  assert.equal(st.importText('{"tasks":"not-array"}').ok, false);
  assert.equal(st.importText('{"settings":42}').ok, false);
  // 坏条目混在合法结构里也整体拒绝（绝不静默丢数据）
  assert.equal(st.importText('{"tasks":[{"id":"x","title":"","time":"10:00","repeat":{"type":"daily"}}]}').ok, false);
});

ok('合法导入整表替换', () => {
  const st = new Store(dir, log);
  st.load();
  const res = st.importText(JSON.stringify({
    settings: { theme: 'quiet', opacity: 0.5 },
    tasks: [{ id: 'a', title: '吃药', time: '08:00', repeat: { type: 'daily' } }],
    stats: { days: { '2026-09-12': 3 }, streak: 2, lastStreakDate: '2026-09-12' },
  }));
  assert.equal(res.ok, true);
  assert.equal(st.data.settings.theme, 'quiet');
  assert.equal(st.data.tasks.length, 1);
  assert.equal(st.data.stats.streak, 2);
});

ok('任务名超长/时间非法被清洗掉', () => {
  assert.equal(sanitizeTask({ id: 'x', title: 'x'.repeat(51), time: '10:00', repeat: { type: 'daily' } }), null);
  assert.equal(sanitizeTask({ id: 'x', title: 'ok', time: '25:00', repeat: { type: 'daily' } }), null);
  assert.equal(sanitizeTask({ id: 'x', title: 'ok', time: '10:00', repeat: { type: 'unknown' } }), null);
});

ok('date 仅 once 保留且拒绝假日期；overdueAlert 可选', () => {
  const keep = sanitizeTask({ id: 'x', title: 'ok', time: '10:00', date: '2026-09-15', overdueAlert: true, repeat: { type: 'once' } });
  assert.equal(keep.date, '2026-09-15');
  assert.equal(keep.overdueAlert, true);
  const stripped = sanitizeTask({ id: 'x', title: 'ok', time: '10:00', date: '2026-09-15', repeat: { type: 'daily' } });
  assert.equal(stripped.date, undefined);
  assert.equal(stripped.overdueAlert, undefined);
  const fake = sanitizeTask({ id: 'x', title: 'ok', time: '10:00', date: '2026-02-30', repeat: { type: 'once' } });
  assert.equal(fake.date, undefined);
});

ok('dndMode 默认关闭且可持久化', () => {
  const st2 = new Store(dir, log);
  st2.load();
  assert.equal(st2.data.settings.dndMode, false);
  st2.data.settings.dndMode = true;
  st2.saveNow();
  const st3 = new Store(dir, log);
  st3.load();
  assert.equal(st3.data.settings.dndMode, true);
});

ok('overdueMinutes 仅接受合法档位', () => {
  const st2 = new Store(dir, log);
  st2.load();
  assert.equal(st2.data.settings.overdueMinutes, 0);
  st2.data.settings.overdueMinutes = 5;
  st2.saveNow();
  const st3 = new Store(dir, log);
  st3.load();
  assert.equal(st3.data.settings.overdueMinutes, 5);
  st3.data.settings.overdueMinutes = 7; // 非法档位
  st3.saveNow();
  const st4 = new Store(dir, log);
  st4.load();
  assert.equal(st4.data.settings.overdueMinutes, 0); // 非法值被清洗回默认
});

ok('musicFolder 持久化与清洗', () => {
  const st2 = new Store(dir, log);
  st2.load();
  st2.data.settings.musicFolder = 'D:/Music';
  st2.saveNow();
  const st3 = new Store(dir, log);
  st3.load();
  assert.equal(st3.data.settings.musicFolder, 'D:/Music');
  st3.data.settings.musicFolder = 'x'.repeat(501);
  st3.saveNow();
  const st4 = new Store(dir, log);
  st4.load();
  assert.equal(st4.data.settings.musicFolder, ''); // 超长被清洗回默认
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(passed + ' passed' + (process.exitCode ? '（有失败）' : ''));
