// 提醒弹窗渲染层：展示待处理提醒，操作回传主进程。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const rapp = $('rapp');
  let settings = { theme: 'lively', sound: true, soundPack: 'windchime', snoozeMinutes: 5 };
  const seen = new Set();
  let current = [];

  const pad = (n) => String(n).padStart(2, '0');

  api.getState().then((s) => {
    settings = s.settings;
    rapp.dataset.theme = settings.theme;
  });

  function tick() {
    const d = new Date();
    $('rclock').textContent = `现在 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  tick();
  setInterval(tick, 1000);

  function buildCard(item) {
    const card = document.createElement('div');
    card.className = 'rcard';
    const title = document.createElement('div');
    title.className = 'rTitle';
    title.textContent = item.title;
    const time = document.createElement('div');
    time.className = 'rTime';
    time.textContent = item.type === 'pomo' ? '番茄钟'
      : item.timeLabel === '稍后' ? '贪睡后再次提醒'
        : item.timeLabel ? `计划时刻 ${item.timeLabel}` : '';
    if (!time.textContent) time.remove();
    const btns = document.createElement('div');
    btns.className = 'rbtns';
    card.append(title, time, btns);

    const btn = (label, cls, fn) => {
      const b = document.createElement('button');
      if (cls) b.className = cls;
      b.textContent = label;
      b.addEventListener('click', fn);
      btns.appendChild(b);
    };

    if (item.type === 'pomo') {
      if (item.pomoPhase === 'focus') {
        btn('☕ 开始休息', 'primary', () => api.reminderAction(item.key, 'break'));
        btn('跳过', '', () => api.reminderAction(item.key, 'stop'));
      } else {
        btn('🍅 开始专注', 'primary', () => api.reminderAction(item.key, 'focus'));
        btn('结束', '', () => api.reminderAction(item.key, 'stop'));
      }
    } else {
      btn('✓ 完成', 'primary', () => api.reminderAction(item.key, 'done'));
      btn(`${settings.snoozeMinutes}分后再提醒`, '', () => api.reminderAction(item.key, 'snooze', settings.snoozeMinutes));
      btn('今天跳过', '', () => api.reminderAction(item.key, 'skip'));
    }
    return card;
  }

  api.onReminders((list) => {
    current = list || [];
    const fresh = current.some((x) => !seen.has(x.key));
    for (const x of current) seen.add(x.key);
    if (fresh && settings.sound) SoundKit.play('remind', settings.soundPack, true);
    const box = $('rcards');
    box.textContent = '';
    for (const item of current) box.appendChild(buildCard(item));
    if (seen.size > 200) seen.clear();
  });
})();
