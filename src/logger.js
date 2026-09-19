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
        const nl = old.indexOf('\n', Math.floor(old.length / 2)); // 从下一行开始截断，避免切断多字节字符
        fs.writeFileSync(file, nl === -1 ? '' : old.slice(nl + 1));
      }
      fs.appendFileSync(file, line);
    } catch (_) { /* 日志失败不影响主流程 */ }
  }
  return { info: (m) => write('INFO ' + m), error: (m) => write('ERR  ' + m) };
}

module.exports = { createLogger };
