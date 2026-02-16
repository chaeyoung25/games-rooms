(function () {
  const TRACKS = [
    "/static/assets/music/kornevmusic-corporate-inspirational-456218.mp3",
    "/static/assets/music/nickpanek-epic-anime-rock-song-with-piano-elements-261109.mp3",
    "/static/assets/music/notaigenerated-dynamic-energetic-rock-126339.mp3",
    "/static/assets/music/sigmamusicart-corporate-party-rock-203112.mp3",
  ];

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

    const storageEnabledKey = "arcade_bgm_enabled";
    const storageTrackKey = "arcade_bgm_track_index";

    let enabled = localStorage.getItem(storageEnabledKey);
    if (enabled == null) enabled = "1";
    let shouldPlay = enabled !== "0";

    let trackIndex = Number(localStorage.getItem(storageTrackKey) || "0");
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= TRACKS.length) trackIndex = 0;

    const btn = createButton();
    const audio = new Audio();
    audio.preload = "none";
    audio.loop = false;
    audio.volume = 0.4;

    function setTrack(index) {
      trackIndex = (index + TRACKS.length) % TRACKS.length;
      localStorage.setItem(storageTrackKey, String(trackIndex));
      const src = TRACKS[trackIndex];
      if (audio.src !== src) audio.src = src;
    }

    function renderButton() {
      if (shouldPlay) {
        btn.classList.add("on");
        btn.textContent = `BGM ON ${trackIndex + 1}/${TRACKS.length}`;
      } else {
        btn.classList.remove("on");
        btn.textContent = "BGM OFF";
      }
    }

    async function playNow() {
      if (!shouldPlay) return;
      setTrack(trackIndex);
      try {
        await audio.play();
      } catch {
        // blocked by autoplay policy; will retry on user input
      }
      renderButton();
    }

    function stopNow() {
      audio.pause();
      renderButton();
    }

    function nextTrack(autoPlay = true) {
      setTrack(trackIndex + 1);
      if (autoPlay && shouldPlay) {
        playNow();
      } else {
        renderButton();
      }
    }

    audio.addEventListener("ended", () => {
      nextTrack(true);
    });

    btn.addEventListener("click", async () => {
      shouldPlay = !shouldPlay;
      localStorage.setItem(storageEnabledKey, shouldPlay ? "1" : "0");
      if (shouldPlay) await playNow();
      else stopNow();
    });

    function armAutoplay() {
      if (!shouldPlay) return;
      const onceStart = () => {
        playNow();
        window.removeEventListener("pointerdown", onceStart);
        window.removeEventListener("keydown", onceStart);
      };
      window.addEventListener("pointerdown", onceStart, { once: true });
      window.addEventListener("keydown", onceStart, { once: true });
    }

    setTrack(trackIndex);
    renderButton();
    armAutoplay();
  }

  window.initArcadeBgm = initArcadeBgm;
})();
