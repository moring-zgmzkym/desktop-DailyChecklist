// WebAudio 合成音效：三套音色（风铃/木琴/水滴）× 两类事件（提醒/完成）。
// 无音频文件、无网络请求（策划书第 5 章零联网基线）。
(function () {
  let ctx = null;

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 单音：type 波形、freq 频率、at 相对秒、dur 总长、decay 指数衰减系数、gain 音量、glide 频率滑向
  function tone(c, { type = 'sine', freq, at = 0, dur = 0.5, decay = 6, gain = 0.12, glide = 0 }) {
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, glide), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const RECIPES = {
    windchime: {
      remind: (c) => { // 高频正弦簇，风铃感
        [1318.5, 1568, 2093].forEach((f, i) => tone(c, { freq: f, at: i * 0.12, dur: 0.9, decay: 5, gain: 0.09 }));
        tone(c, { freq: 2637, at: 0.36, dur: 0.8, decay: 6, gain: 0.05 });
      },
      done: (c) => { [2093, 2637].forEach((f, i) => tone(c, { freq: f, at: i * 0.07, dur: 0.35, decay: 8, gain: 0.07 })); },
    },
    xylophone: {
      remind: (c) => { // 三角波三连音，木琴感
        [523.3, 659.3, 784].forEach((f, i) => tone(c, { type: 'triangle', freq: f, at: i * 0.14, dur: 0.4, decay: 9, gain: 0.14 }));
      },
      done: (c) => { tone(c, { type: 'triangle', freq: 784, dur: 0.3, decay: 9, gain: 0.12 }); },
    },
    drop: {
      remind: (c) => { // 正弦下滑 + 回落，水滴感
        tone(c, { freq: 880, dur: 0.22, decay: 4, gain: 0.13, glide: 392 });
        tone(c, { freq: 660, at: 0.26, dur: 0.22, decay: 4, gain: 0.11, glide: 294 });
      },
      done: (c) => { tone(c, { freq: 988, dur: 0.18, decay: 5, gain: 0.12, glide: 494 }); },
    },
  };

  // kind: 'remind' | 'done'；pack: 'windchime' | 'xylophone' | 'drop'
  function play(kind, pack, enabled) {
    if (!enabled) return;
    try {
      const c = ensureCtx();
      const recipe = (RECIPES[pack] || RECIPES.windchime)[kind] || RECIPES.windchime.remind;
      recipe(c);
    } catch (_) { /* 音效失败不影响功能 */ }
  }

  window.SoundKit = { play };
})();
