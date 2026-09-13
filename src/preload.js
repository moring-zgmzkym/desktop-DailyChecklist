// 通过 contextBridge 暴露白名单 API；主进程侧对每个参数做校验（策划书第 5 章）。
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('api', {
  getState: () => inv('state:get'),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
  onMini: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('mini', h);
    return () => ipcRenderer.removeListener('mini', h);
  },
  onReminders: (cb) => {
    const h = (_e, r) => cb(r);
    ipcRenderer.on('reminders', h);
    return () => ipcRenderer.removeListener('reminders', h);
  },

  addTask: (input) => inv('task:add', input),
  updateTask: (id, patch) => inv('task:update', { id, patch }),
  deleteTask: (id) => inv('task:delete', { id }),
  undoDelete: () => inv('task:undoDelete'),
  toggleTask: (id, enabled) => inv('task:toggle', { id, enabled }),
  completeTask: (id) => inv('task:complete', { id }),
  skipTask: (id) => inv('task:skip', { id }),
  snoozeTask: (id, minutes) => inv('task:snooze', { id, minutes }),

  updateSettings: (patch) => inv('settings:update', patch),
  deleteTemplate: (id) => inv('template:delete', { id }),
  addTemplate: (input) => inv('template:add', input),
  updateTemplate: (id, patch) => inv('template:update', { id, patch }),

  setPinned: (v) => inv('win:pin', v),
  setMini: (v) => inv('win:mini', v),
  hideToTray: () => inv('win:hideToTray'),
  quitApp: () => inv('app:quit'),
  resizeStart: (edge) => inv('win:resize', { phase: 'start', edge }),
  resizeMove: (edge, dx, dy) => inv('win:resize', { phase: 'move', edge, dx, dy }),
  resizeEnd: () => inv('win:resize', { phase: 'end' }),

  pomoStart: () => inv('pomo:start'),
  pomoControl: (action) => inv('pomo:control', { action }),

  reminderAction: (key, action, minutes) => inv('reminder:action', { key, action, minutes }),

  exportData: () => inv('data:export'),
  importData: () => inv('data:import'),
});
