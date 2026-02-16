(function () {
  function createButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bgm-toggle";
    btn.setAttribute("aria-label", "배경음악 켜기/끄기");
    btn.textContent = "BGM OFF";
    document.body.append(btn);
    return btn;
  }

  function initArcadeBgm() {
    if (window.__arcadeBgmInited) return;
    window.__arcadeBgmInited = true;

    const storageKey = "arcade_bgm_enabled";
    let enabled = localStorage.getItem(storageKey);
    if (enabled == null) enabled = "1";
    let shouldPlay = enabled !== "0";

    const btn = createButton();

    const Ctx = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let master = null;
    let running = false;
    let timer = null;
    let step = 0;

    const tempo = 128;
    const beat = 60 / tempo / 2; // eighth note
    const melody = [0, 4, 7, 4, 0, 4, 9, 7, 0, 4, 7, 11, 12, 11, 9, 7];
    const bass = [0, 0, -5, -5, 0, 0, -3, -3, 0, 0, -5, -5, -7, -7, -5, -5];

    function midiToFreq(midi) {
      return 440 * Math.pow(2, (midi - 69) / 12);
    }

    function ensureAudio() {
      if (!Ctx) return false;
      if (!ctx) {
        ctx = new Ctx();
        master = ctx.createGain();
        master.gain.value = 0.0001;
        master.connect(ctx.destination);
      }
      return true;
    }

    function trigger(freq, when, duration, type, level) {
      if (!ctx || !master || !freq) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(level, when + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      osc.connect(gain);
      gain.connect(master);
      osc.start(when);
      osc.stop(when + duration + 0.02);
    }

    function schedule() {
      if (!running || !ctx) return;
      const now = ctx.currentTime + 0.05;
      for (let i = 0; i < 16; i++) {
        const t = now + i * beat;
        const mi = melody[(step + i) % melody.length];
        const bi = bass[(step + i) % bass.length];
        trigger(midiToFreq(64 + mi), t, beat * 0.86, "triangle", 0.07);
        if (i % 2 === 0) {
          trigger(midiToFreq(40 + bi), t, beat * 1.7, "square", 0.045);
        }
      }
      step = (step + 16) % melody.length;
      timer = setTimeout(schedule, beat * 1000 * 16 * 0.92);
    }

    async function startAudio() {
      if (!ensureAudio()) return;
      if (ctx.state !== "running") {
        try {
          await ctx.resume();
        } catch {
          return;
        }
      }
      if (running) return;
      running = true;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(0.16, ctx.currentTime, 0.06);
      schedule();
    }

    function stopAudio() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (ctx && master) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      }
    }

    function renderButton() {
      if (shouldPlay) {
        btn.classList.add("on");
        btn.textContent = "BGM ON";
      } else {
        btn.classList.remove("on");
        btn.textContent = "BGM OFF";
      }
    }

    function armAutoplay() {
      if (!shouldPlay) return;
      const onceStart = () => {
        startAudio();
        window.removeEventListener("pointerdown", onceStart);
        window.removeEventListener("keydown", onceStart);
      };
      window.addEventListener("pointerdown", onceStart, { once: true });
      window.addEventListener("keydown", onceStart, { once: true });
    }

    btn.addEventListener("click", async () => {
      shouldPlay = !shouldPlay;
      localStorage.setItem(storageKey, shouldPlay ? "1" : "0");
      renderButton();
      if (shouldPlay) await startAudio();
      else stopAudio();
    });

    renderButton();
    armAutoplay();
  }

  window.initArcadeBgm = initArcadeBgm;
})();
