// 滚动日志：超过上限截断保留后半段。
const fs = require('fs');
const path = require('path');

const MAX = 512 * 1024;

function createLogger(dir) {
  const file = path.join(dir, 'app.log');
  function write(msg) {
    try {
      let line = `[${new Date().toISOString()}] ${msg}\n`;
      if (fs.existsSync(file) && fs.statSync(file).size > MAX) {
        const old = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, old.slice(Math.floor(old.length / 2)));
      }
      fs.appendFileSync(file, line);
    } catch (_) { /* 日志失败不影响主流程 */ }
  }
  return { info: (m) => write('INFO ' + m), error: (m) => write('ERR  ' + m) };
}

module.exports = { createLogger };
