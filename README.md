# 小滴答 · 桌面每日提醒

半透明常驻桌面小组件 + 到点弹窗提醒。设计与验收标准见 [策划书.md](策划书.md)。

## 运行（开发）

双击项目根目录的「启动小滴答.bat」，或：

```bash
npm install
npm start
```

> 若 Electron 二进制下载超时，项目内已配置 `.npmrc` 使用 npmmirror 镜像；也可手动设置环境变量 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试。

## 打包（产出 exe）

```bash
npm run dist
```

产物在 `dist/`：绿色便携版 exe + NSIS 安装包。未签名，首次运行 SmartScreen 提示属正常，点「更多信息 → 仍要运行」。

## 测试

```bash
node scripts/smoke-tests.js   # 调度与数据层冒烟测试
npm run icons                 # 重新生成应用图标
```

## 数据

单 JSON 存于 `%APPDATA%/小滴答/data.json`（含自动轮换的 `data.json.bak`）。设置面板可导出/导入备份。
