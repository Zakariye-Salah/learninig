/* =======================
   AUDIO: unlock + start/stop
   ======================= */
let _gestureAudioCtx = null;
let currentSpinAudio = null;

function ensureAudioOnGesture() {
  try {
    if (_gestureAudioCtx && _gestureAudioCtx.ctx) {
      const ctx = _gestureAudioCtx.ctx;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(()=>{});
      return _gestureAudioCtx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
      const g = ctx.createGain();
      g.gain.value = 0.00001;
      g.connect(ctx.destination);
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(()=>{});
    } catch(e){}
    _gestureAudioCtx = { ctx };
    return _gestureAudioCtx;
  } catch (e) {
    return null;
  }
}

function startSpinAudio(ctx, freq = 220) {
  try {
    if (!ctx) {
      const g = ensureAudioOnGesture();
      if (!g || !g.ctx) return null;
      ctx = g.ctx;
    }
    stopSpinAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.value = 0.02;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    currentSpinAudio = { ctx, osc, gain };
    return currentSpinAudio;
  } catch (e) {
    console.warn('startSpinAudio failed', e);
    return null;
  }
}

function stopSpinAudio() {
  try {
    if (!currentSpinAudio) return;
    const { ctx, osc, gain } = currentSpinAudio;
    try {
      if (gain && ctx && typeof ctx.currentTime === 'number') {
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
      }
      if (osc && ctx && typeof ctx.currentTime === 'number') {
        osc.stop(ctx.currentTime + 0.06);
      } else if (osc && typeof osc.stop === 'function') {
        try { osc.stop(); } catch(e){}
      }
    } catch(e){}
  } catch(e){}
  currentSpinAudio = null;
}

function playTick(ctx, freq = 1200, dur = 0.035) {
  try {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq + (Math.random() * 80 - 40);
    g.gain.value = 0.0001;
    o.connect(g);
    g.connect(ctx.destination);
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.04, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.start(now);
    o.stop(now + dur + 0.01);
  } catch(e){}
}

function playApplause() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const bufferSize = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i=0;i<bufferSize;i++){
      data[i] = (Math.random()*2 - 1) * (1 - i / bufferSize);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'highpass';
    band.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(band);
    band.connect(g);
    g.connect(ctx.destination);
    src.start();
    setTimeout(()=> {
      const osc = ctx.createOscillator();
      const g2 = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 880;
      g2.gain.value = 0.01;
      osc.connect(g2);
      g2.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
      try { src.stop(ctx.currentTime + 0.16); } catch(e){}
    }, 30);
  } catch(e){ console.warn('applause fail', e); }
}

/* =========================
   buildAnimationOptionsFromPercents
   (more precise slot allocation)
   ========================= */
function buildAnimationOptionsFromPercents(percents, totalSlots) {
  totalSlots = Math.max(40, Math.round(Number(totalSlots || computeDeviceTotalSlots()) || 120));
  const keys = Object.keys(percents || {});
  if (!keys.length) return [];

  const entries = keys.map(k => ({k: String(k), p: Math.max(0.01, Number(percents[k] || 0))}));
  const raw = entries.map(e => (e.p / 100) * totalSlots);

  // take floor counts, then distribute leftover by largest fractional part
  let floorCounts = raw.map(v => Math.max(1, Math.floor(v)));
  let sum = floorCounts.reduce((s,x) => s + x, 0);
  const remainders = raw.map((v,i) => ({i, rem: v - Math.floor(v)}));
  remainders.sort((a,b) => b.rem - a.rem);
  let remain = totalSlots - sum;
  for (let r = 0; r < remainders.length && remain > 0; r++, remain--) {
    floorCounts[remainders[r].i]++;
  }
  // if still not matching due to odd rounding, adjust safely
  while (floorCounts.reduce((s,x) => s + x, 0) > totalSlots) {
    const idxObj = floorCounts.map((v,i) => ({v,i})).sort((a,b)=>b.v-a.v)[0];
    if (floorCounts[idxObj.i] > 1) floorCounts[idxObj.i]--;
    else break;
  }
  while (floorCounts.reduce((s,x) => s + x, 0) < totalSlots) {
    const idx = entries.map((e,i)=>({p:e.p,i})).sort((a,b)=>b.p-a.p)[0].i;
    floorCounts[idx] = (floorCounts[idx] || 0) + 1;
  }

  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = 0; j < floorCounts[i]; j++) out.push(entries[i].k);
  }

  // shuffle for randomness
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  // ensure every key appears at least once
  for (const e of entries) if (!out.includes(e.k)) out.push(e.k);
  return out;
}

/* =========================
   ensureOutcomeInAnimOptions
   (improved; can force center later)
   ========================= */
function ensureOutcomeInAnimOptions(animArray, outcome) {
  const outStr = String(outcome);
  const arr = animArray.slice().map(String);
  if (arr.indexOf(outStr) !== -1) return arr;
  const insertAt = Math.max(1, Math.floor(arr.length / 2));
  arr.splice(insertAt, 0, outStr);
  return arr;
}

/* =========================
   animateSpin - deterministic final tile
   - ensures a tile equal to targetOutcome is placed at the exact center index
   - rotates array so that a pre-existing occurrence lands at center (preferred)
   - if none exists, overwrites the center tile with outcome (safe)
   ========================= */
function animateSpin(trackOptions, targetOutcome, opts = {}) {
  const slowDurationMs = opts.slowDurationMs || 2400;
  const defaultRepeats = (computeDeviceTotalSlots() <= 80) ? 5 : 8;
  const repeats = typeof opts.repeats === 'number' ? Math.max(1, opts.repeats) : defaultRepeats;

  return new Promise((resolve) => {
    try {
      const area = document.getElementById('lucky_spinner_area');
      const track = document.getElementById('lucky_spinner_track');
      const resultEl = document.getElementById('lucky_result');
      if (!area || !track || !Array.isArray(trackOptions) || trackOptions.length === 0) {
        return resolve({ finalIndex: 0, value: Number(targetOutcome) });
      }

      // normalize
      let cycleOptions = trackOptions.map(String);

      // Build repeated base array (will be transformed to ensure exact center)
      let base = [];
      for (let r = 0; r < repeats; r++) {
        base = base.concat(cycleOptions);
      }
      const totalTiles = base.length;
      const desiredIndex = Math.floor(totalTiles / 2);

      // find any index that already equals targetOutcome
      const numericTarget = String(targetOutcome);
      let foundIndex = base.findIndex(v => String(v) === numericTarget);

      // helper: right-rotate by k
      function rotateRight(arr, k) {
        const n = arr.length;
        if (n === 0) return arr.slice();
        k = ((k % n) + n) % n;
        if (k === 0) return arr.slice();
        return arr.slice(n - k).concat(arr.slice(0, n - k));
      }

      if (foundIndex >= 0) {
        // rotate base so that foundIndex goes to desiredIndex
        const k = (desiredIndex - foundIndex + totalTiles) % totalTiles; // how much to add to index to reach desiredIndex
        base = rotateRight(base, k);
      } else {
        // no occurrence: ensure at least one entry by overwriting center slot
        base[desiredIndex] = numericTarget;
      }

      // Rebuild DOM tiles from 'base' sequence (we know base[desiredIndex] === numericTarget now)
      track.innerHTML = '';
      if (resultEl) resultEl.style.display = 'none';
      area.style.display = '';

      const tiles = [];
      for (let i = 0; i < base.length; i++) {
        const val = String(base[i]);
        const tile = document.createElement('div');
        tile.className = 'spin-tile';
        tile.innerText = val + ' pts';
        tile.dataset.val = val;
        track.appendChild(tile);
        tiles.push({ el: tile, value: Number(val) });
      }

      // now targetIndex is desiredIndex (we forced/rotated it)
      const targetIndex = desiredIndex;

      // layout measurement on next frames
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
          // compute stride
          let tileStride = 0;
          if (tiles.length >= 2) {
            const r0 = tiles[0].el.getBoundingClientRect();
            const r1 = tiles[1].el.getBoundingClientRect();
            tileStride = Math.round(r1.left - r0.left);
            if (!tileStride || tileStride <= 0) tileStride = Math.round(tiles[0].el.offsetWidth + 8);
          } else tileStride = Math.round(tiles[0].el.offsetWidth + 8);

          const areaRect = area.getBoundingClientRect();
          const areaCenterX = areaRect.left + (areaRect.width / 2);

          const firstTileRect = tiles[0].el.getBoundingClientRect();
          const trackRect = track.getBoundingClientRect();
          const firstTileCenterFromTrackLeft = (firstTileRect.left + firstTileRect.width / 2) - trackRect.left;

          const targetTileCenterFromTrackLeft = firstTileCenterFromTrackLeft + (targetIndex * tileStride);
          const trackLeft = trackRect.left;
          const finalTranslatePx = Math.round(areaCenterX - trackLeft - targetTileCenterFromTrackLeft);

          // overshoot cycles (fast phase)
          const maxCycles = Math.max(1, Math.min(3, Math.floor(cycleOptions.length / 20)));
          const overshootCycles = Math.max(1, Math.floor(2 + Math.random() * maxCycles));
          const overshootTranslatePx = finalTranslatePx - (cycleOptions.length * tileStride * overshootCycles);

          // audio
          try { stopSpinAudio(); } catch(e){}
          const g = ensureAudioOnGesture();
          const ctx = (g && g.ctx) ? g.ctx : ((window.AudioContext || window.webkitAudioContext) ? new (window.AudioContext || window.webkitAudioContext)() : null);
          const audio = ctx ? startSpinAudio(ctx, 220) : null;

          track.style.transition = 'none';
          track.style.transform = `translateX(0px)`;

          const fastMs = 520 + Math.random() * 260;
          const deltaPx = Math.abs(overshootTranslatePx - 0);
          let tilesCrossed = Math.max(4, Math.round(deltaPx / (tileStride || 1)));
          const tickIntervalMs = Math.max(20, (fastMs / (tilesCrossed || 1)) | 0);

          let tickTimer = null;
          if (ctx) {
            let tickCount = 0;
            tickTimer = setInterval(() => {
              try { const f = 1000 + Math.min(2000, 1200 + (tickCount % 6) * 80); playTick(ctx, f, 0.03); } catch(e){}
              tickCount++;
            }, tickIntervalMs);
          }

          // start fast phase
          setTimeout(() => {
            track.style.transition = `transform ${fastMs}ms cubic-bezier(.12,.9,.24,1)`;
            track.style.transform = `translateX(${overshootTranslatePx}px)`;
          }, 20);

          let settled = false;
          let microTimeout = null;

          function finalizeAtExact(tileIndex) {
            try {
              const winTile = tiles[tileIndex];
              if (!winTile || !winTile.el) {
                settled = true;
                if (tickTimer) clearInterval(tickTimer);
                if (audio) try { stopSpinAudio(); } catch(e){}
                return resolve({ finalIndex: tileIndex, value: Number(targetOutcome) });
              }

              const winRect = winTile.el.getBoundingClientRect();
              const curTrackRect = track.getBoundingClientRect();
              const exactFinal = Math.round(areaCenterX - (curTrackRect.left) - (((winRect.left + winRect.width / 2) - curTrackRect.left)));

              // micro snap
              requestAnimationFrame(() => {
                track.style.transition = `transform 180ms cubic-bezier(.22,.9,.32,1)`;
                track.style.transform = `translateX(${exactFinal}px)`;
              });

              const microComplete = () => {
                if (settled) return;
                settled = true;
                if (tickTimer) clearInterval(tickTimer);
                try { if (audio) stopSpinAudio(); } catch(e){}
                tiles.forEach(t => t.el.classList.remove('winner','ultimate','adjacent','dim'));
                const top = Math.max(...base.map(x => Number(x)));
                if (Number(winTile.value) === top) {
                  winTile.el.classList.add('ultimate');
                  try { playApplause(); } catch(e){}
                  try { fireConfetti(80); } catch(e){}
                } else {
                  winTile.el.classList.add('winner');
                }
                const prev = tiles[tileIndex - 1]; const next = tiles[tileIndex + 1];
                if (prev && prev.el) prev.el.classList.add('adjacent');
                if (next && next.el) next.el.classList.add('adjacent');
                tiles.forEach((t, idx) => {
                  if (idx !== tileIndex && idx !== tileIndex-1 && idx !== tileIndex+1) t.el.classList.add('dim');
                });
                const pointer = document.querySelector('.spinner-pointer');
                if (pointer) { pointer.classList.add('pulse'); setTimeout(()=>pointer.classList.remove('pulse'), 1100); }

                // return the numeric value of the centered tile (should match server targetOutcome)
                const finalVal = Number(tiles[tileIndex].value);
                return resolve({ finalIndex: tileIndex, value: finalVal });
              };

              const onMicroEnd = (ev) => {
                if (ev && ev.target !== track) return;
                if (ev && ev.propertyName && ev.propertyName !== 'transform') return;
                track.removeEventListener('transitionend', onMicroEnd);
                if (microTimeout) { clearTimeout(microTimeout); microTimeout = null; }
                microComplete();
              };
              track.addEventListener('transitionend', onMicroEnd);
              microTimeout = setTimeout(() => {
                try { track.removeEventListener('transitionend', onMicroEnd); } catch(e){}
                microComplete();
              }, 450);

            } catch (e) {
              console.warn('finalizeAtExact failed', e);
              if (!settled) {
                settled = true;
                if (tickTimer) clearInterval(tickTimer);
                try { if (audio) stopSpinAudio(); } catch(e){}
                return resolve({ finalIndex: tileIndex, value: Number(targetOutcome) });
              }
            }
          }

          function onFastEnd(ev) {
            if (ev && ev.target !== track) return;
            if (ev && ev.propertyName && ev.propertyName !== 'transform') return;
            track.removeEventListener('transitionend', onFastEnd);
            if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
            try { if (audio && audio.osc && audio.ctx) audio.osc.frequency.setValueAtTime(420, audio.ctx.currentTime); } catch(e){}
            track.style.transition = `transform ${slowDurationMs}ms cubic-bezier(.22,.9,.32,1)`;
            track.style.transform = `translateX(${finalTranslatePx}px)`;

            function onSlowEnd(ev2) {
              if (ev2 && ev2.target !== track) return;
              if (ev2 && ev2.propertyName && ev2.propertyName !== 'transform') return;
              track.removeEventListener('transitionend', onSlowEnd);
              finalizeAtExact(targetIndex);
            }
            track.addEventListener('transitionend', onSlowEnd);

            setTimeout(() => {
              if (!settled) finalizeAtExact(targetIndex);
            }, slowDurationMs + 600);
          }

          track.addEventListener('transitionend', onFastEnd);

          // fallback if fast doesn't occur
          setTimeout(() => {
            if (!settled) {
              try { track.removeEventListener('transitionend', onFastEnd); } catch(e){}
              if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
              try {
                track.style.transition = `transform ${slowDurationMs}ms cubic-bezier(.22,.9,.32,1)`;
                track.style.transform = `translateX(${finalTranslatePx}px)`;
                setTimeout(() => { if (!settled) finalizeAtExact(targetIndex); }, slowDurationMs + 40);
              } catch(e) {
                if (!settled) { settled = true; resolve({ finalIndex: targetIndex, value: Number(targetOutcome) }); }
              }
            }
          }, fastMs + 700);

        } catch (err) {
          console.warn('animateSpin inner failure', err);
          return resolve({ finalIndex: Math.floor(totalTiles/2), value: Number(targetOutcome) });
        }
      })); // rAF x2

    } catch (outerErr) {
      console.warn('animateSpin failure', outerErr);
      return resolve({ finalIndex: 0, value: Number(targetOutcome) });
    }
  });
}
