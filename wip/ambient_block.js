  // ---------- harmony: the room's slow progression ----------
  // I – vi – IV – V in D, voiced with Lydian colour and smooth voice leading. Every 16 s the pad
  // glides to the next chord, the aeolian strings retune into it and the sub follows the root;
  // every melodic layer (crystals, piano, chip phrases) takes its notes from the chord in force.
  const CHORDS = [
    { name: "Dmaj9#11", pad: [12, 19, 26, 28, 32, 35], root: 0, triad: [0, 4, 7], ext: [11, 14, 18], sub: -12, strings: [0, 7, 12, 16, 19] },
    { name: "Bm11", pad: [9, 16, 24, 26, 31, 35], root: 9, triad: [0, 3, 7], ext: [10, 14, 17], sub: -15, strings: [-3, 4, 9, 12, 16] },
    { name: "Gmaj9#11", pad: [5, 12, 21, 28, 31, 35], root: 5, triad: [0, 4, 7], ext: [11, 14, 18], sub: -7, strings: [5, 9, 12, 17, 21] },
    { name: "A6/9", pad: [7, 14, 21, 26, 28, 35], root: 7, triad: [0, 4, 7], ext: [9, 14], sub: -5, strings: [7, 11, 14, 19, 21] },
  ];
  const CHORD_SECONDS = 16;
  let chordIx = 0, chordAt = 0, sub = null, musicOn = true, lastPhrase = -1e9;
  const chord = () => CHORDS[chordIx];
  // chord tones from `low` upward, ascending: the ladder every melody climbs
  function ladder(low, count, c = chord()) {
    const pcs = [...new Set([...c.triad, ...c.ext].map((iv) => (c.root + iv) % 12))].sort((a, b) => a - b);
    const out = [];
    for (let m = low; out.length < count; m++) if (pcs.includes((((m - ROOT) % 12) + 12) % 12)) out.push(m);
    return out;
  }
  const chordNote = (low, span) => { const l = ladder(low, span); return l[(Math.random() * l.length) | 0]; };

  function changeChord(t) {
    chordIx = (chordIx + 1) % CHORDS.length;
    chordAt = t;
    const c = chord();
    pad.forEach((v, i) => v.oscs.forEach((o) => o.frequency.setTargetAtTime(mtof(ROOT + c.pad[i]), t, 0.7)));
    strings.forEach((s, i) => s.dl.delayTime.setTargetAtTime(1 / mtof(ROOT + c.strings[i]), t, 0.9));
    if (sub) sub.frequency.setTargetAtTime(mtof(ROOT + c.sub), t, 1.2);
    // now and then a chip phrase surfaces over the new chord (never two close together)
    if (musicOn && t - lastPhrase > 40 && (lastPhrase < 0 || Math.random() < 0.45)) { lastPhrase = t; chipPhrase(t + 0.9); }
  }

  function chatter(t) {   // distant data packets crossing the void
    const n = 3 + ((Math.random() * 4) | 0), l = ladder(ROOT + 36 + ((Math.random() * 5) | 0), 7), notes = [];
    for (let k = 0; k < n; k++) notes.push(l[Math.min(l.length - 1, k + ((Math.random() * 2) | 0))]);
    chip(notes, { duty: [0.125, 0.25, 0.5][(Math.random() * 3) | 0], step: rand(0.035, 0.06), hold: 0.02, decay: 0.12 },
         { t, gain: 0.012, pan: rand(-0.9, 0.9), dry: 0.2, rev: 0.85, del: 0.6, echo: 0.45 });
  }

  // ---------- ambience ----------
  function startAmbient(t) {
    const c = chord();
    // 1. sub pressure: the chord root down in the floor, with A1 and D2 above it, breathing slowly
    [[c.sub, 0.06], [ROOT - 5, 0.03], [ROOT, 0.03]].forEach(([m, g], i) => {
      const o = ctx.createOscillator(), a = ctx.createGain();
      o.frequency.value = mtof(ROOT + (i === 0 ? m : m - ROOT)); a.gain.value = g;
      lfo(rand(0.03, 0.07), g * 0.5, a.gain, t);
      o.connect(a); out(a, { ambient: true, dry: 1, rev: 0.25 }); o.start(t);
      if (i === 0) sub = o;
    });
    // 2. glass pad: six voices spread wide; each drifts in and out on its own and glides with the chords
    pad = c.pad.map((iv, i) => {
      const f = mtof(ROOT + iv), filt = ctx.createBiquadFilter(), g = ctx.createGain();
      filt.type = "lowpass"; filt.Q.value = 0.6; filt.frequency.value = 900;
      lfo(rand(0.02, 0.05), 450, filt.frequency, t);
      const oscs = [-6, 7].map((det) => {
        const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = f; o.detune.value = det;
        lfo(rand(0.08, 0.2), 3, o.detune, t);                                  // slow chorus wobble
        o.connect(filt); o.start(t);
        return o;
      });
      g.gain.value = 0; filt.connect(g);
      out(g, { ambient: true, pan: (i / 5) * 1.5 - 0.75, dry: 0.22, rev: 0.95, del: 0.08 });
      return { g, filt, oscs, level: 0.05 / (1 + iv / 24) };
    });
    pad.forEach((v) => v.g.gain.setTargetAtTime(v.level * rand(0.3, 1), t, 3));
    // 3. aeolian strings: wind (pink noise) through tuned feedback-comb strings
    const wind = noise(true, t), color = ctx.createBiquadFilter();
    color.type = "bandpass"; color.frequency.value = 650; color.Q.value = 0.5;
    lfo(0.035, 380, color.frequency, t);
    wind.connect(color);
    const breath = ctx.createGain(); breath.gain.value = 0.02;                 // the wind itself, barely there
    color.connect(breath); out(breath, { ambient: true, dry: 0.3, rev: 0.7, pan: 0 });
    strings = c.strings.map((iv, i) => {
      const f = mtof(ROOT + iv), exc = ctx.createGain(), dl = ctx.createDelay(0.05), damp = ctx.createBiquadFilter(), fb = ctx.createGain();
      exc.gain.value = 0;
      dl.delayTime.value = 1 / f;
      damp.type = "lowpass"; damp.frequency.value = 2400 + f * 5;
      damp.Q.value = -6;      // no resonant bump: in a feedback loop any gain above 1 runs away
      fb.gain.value = 0.991;
      color.connect(exc); exc.connect(dl); dl.connect(damp).connect(fb).connect(dl);
      lfo(rand(0.08, 0.2), (1 / f) * 0.0009, dl.delayTime, t);               // the string breathes in pitch
      const o = ctx.createGain(); o.gain.value = 0.3; dl.connect(o);
      out(o, { ambient: true, pan: [-0.6, 0.5, -0.2, 0.7, 0.1][i], dry: 0.3, rev: 0.9, del: 0.14 });
      return { exc, dl };
    });
    // 4. air: a high, slowly moving hiss — the size of the room
    const air = noise(false, t), hp = ctx.createBiquadFilter(), bp = ctx.createBiquadFilter(), ag = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 5000; bp.type = "bandpass"; bp.Q.value = 0.6; bp.frequency.value = 8000;
    lfo(0.05, 2000, bp.frequency, t);
    ag.gain.value = 0.07;
    air.connect(hp).connect(bp).connect(ag);
    const ap = out(ag, { ambient: true, dry: 0.4, rev: 0.6 });
    lfo(0.03, 0.6, ap.pan, t);
    // 5. tide: two slow waves of filtered noise that swell and brighten together, out of step
    [[0.071, -0.55], [0.053, 0.55]].forEach(([rate, pan]) => {
      const src = noise(true, t), lp = ctx.createBiquadFilter(), g = ctx.createGain();
      lp.type = "lowpass"; lp.Q.value = -3; lp.frequency.value = 650;
      lfo(rate, 520, lp.frequency, t);                                        // the wave brightens as it rises…
      g.gain.value = 0.022; lfo(rate, 0.02, g.gain, t);                       // …and swells at the same moment
      src.connect(lp).connect(g);
      out(g, { ambient: true, pan, dry: 0.5, rev: 0.65 });
    });
  }

  function gust(s, t) { s.exc.gain.setTargetAtTime(Math.random() < 0.3 ? 0 : rand(0.01, 0.07), t, rand(1.5, 4)); }
  function breathe(v, t) { v.g.gain.setTargetAtTime(Math.random() < 0.2 ? 0 : v.level * rand(0.25, 1), t, rand(4, 9)); }
  function crystal(t) {
    const l = ladder(ROOT + 36, 10);
    const count = Math.random() < 0.3 ? 2 + ((Math.random() * 2) | 0) : 1;
    let k = (Math.random() * (l.length - 3)) | 0;
    for (let i = 0; i < count; i++) {
      bell(l[k], { t: t + i * 0.19, gain: 0.016, pan: rand(-0.8, 0.8), dry: 0.25, rev: 0.9, del: 0.55, decay: 3.4, index: 2.5 });
      k = Math.min(l.length - 1, k + 1 + ((Math.random() * 2) | 0));
    }
  }
  // felt piano: a soft, dark string note now and then, sometimes with its fifth or octave
  function piano(t) {
    if (!musicOn) return;
    const m = chordNote(ROOT + 24, 8), pan = rand(-0.5, 0.5);
    pluck(m, { t, gain: 0.08, pan, bright: 0.15, dry: 0.45, rev: 0.75, del: 0.3 });
    if (Math.random() < 0.35) pluck(m + (Math.random() < 0.5 ? 7 : 12), { t: t + rand(0.08, 0.3), gain: 0.05, pan: -pan, bright: 0.15, dry: 0.4, rev: 0.8, del: 0.3 });
  }
  function deepBreath(t) {                                                     // the room inhales, rarely
    const src = noise(true, t), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = "lowpass"; lp.frequency.value = 170;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 4); g.gain.linearRampToValueAtTime(0, t + 10);
    src.connect(lp).connect(g);
    const o = out(g, { ambient: true, dry: 0.7, rev: 0.6 });
    src.stop(t + 10.5); src.onended = () => o.disconnect();
  }

  // ---------- chip phrases: short original vignettes in classic chip-music style ----------
  // A tiny four-channel "sound chip" score is composed over the current chord and rendered offline:
  //   lead   – 12.5 % pulse, a motif stated, repeated higher, then answered; delayed vibrato and slides
  //   echo   – the lead again a dotted-sixteenth later, quieter and on the other side (the NES echo trick)
  //   arp    – a C64-style chord arpeggio cycling at 40 Hz with a slow pulse-width sweep
  //   bass   – triangle root/fifth bounce;  drums – LFSR noise hats and snares, half the time
  // It fades in from the void, plays once (~7 s) and recedes; it should feel like a game in another room.
  const BEAT = 60 / 100;
  const MOTIFS = [[2, 1, 1, 2, 2], [1, 1, 2, 1, 1, 2], [3, 1, 2, 2], [2, 2, 1, 1, 2], [1, 1, 1, 1, 2, 2]];  // in eighths
  function composePhrase(c) {
    const ev = [], E = BEAT / 2, lead = ladder(ROOT + 36 + ((Math.random() * 3) | 0), 9, c);
    const rhythm = MOTIFS[(Math.random() * MOTIFS.length) | 0];
    const contour = rhythm.map(() => (Math.random() * 5) | 0);
    for (let bar = 0; bar < 3; bar++) {
      let t = bar * 8 * E, prev = null;
      rhythm.forEach((len, k) => {
        let idx = contour[k] + (bar === 1 ? 2 : 0);                           // bar 2 restates the motif higher
        if (bar === 2 && k === rhythm.length - 1) idx = 0;                     // and the answer comes home
        const midi = lead[Math.min(lead.length - 1, idx)], last = bar === 2 && k === rhythm.length - 1;
        const note = { t, dur: last ? 4 * E : len * E * 0.85, midi, wave: "pulse", duty: bar === 2 ? 0.25 : 0.125, vol: 0.5, pan: 0.2,
                       vib: { delay: last ? 0.25 : 0.18, depth: 0.22, rate: 5.5 } };
        if (prev !== null && Math.random() < 0.22) { note.slideFrom = prev; note.slideTime = 0.045; }
        ev.push(note, { ...note, t: t + 0.75 * E, vol: 0.18, pan: -0.45 });   // the echo channel
        prev = midi; t += len * E;
      });
    }
    // C64-style arpeggio, entering on bar 2
    const arpRoot = ROOT + 24 + c.root;
    ev.push({ t: 8 * E, dur: 15 * E, midi: arpRoot, wave: "pulse", duty: 0.3, pwm: 0.6, arp: [...c.triad, 12], arpStep: 0.025, vol: 0.2, pan: -0.25, release: 0.4 });
    // triangle bass from bar 2
    for (let k = 8; k < 24; k++) {
      ev.push({ t: k * E, dur: 0.4 * E, midi: ROOT + c.root + (k % 4 === 2 ? 7 : 0), wave: "tri", vol: 0.7, pan: 0, release: 0.03 });
    }
    // noise drums, half the time
    if (Math.random() < 0.5) {
      for (let k = 8; k < 24; k++) {
        if (k % 2 === 1) ev.push({ t: k * E, dur: 0.035, midi: ROOT + 70, wave: "noise", vol: 0.16, pan: 0.3, perc: true });
        if (k % 8 === 4) ev.push({ t: k * E, dur: 0.14, midi: ROOT + 46, wave: "noise", vol: 0.28, pan: 0, perc: true });
      }
    }
    return { events: ev, seconds: 24 * E + 1.2 };
  }
  function renderTrack(events, seconds) {
    const len = Math.ceil(CHIP_SR * seconds), L = new Float32Array(len), R = new Float32Array(len);
    for (const e of events) {
      const i0 = Math.floor(e.t * CHIP_SR), rel = e.release || 0.06, n = Math.floor((e.dur + rel) * CHIP_SR);
      const gl = Math.cos(((e.pan || 0) + 1) * Math.PI / 4), gr = Math.sin(((e.pan || 0) + 1) * Math.PI / 4);
      let phase = 0, lfsr = 1, nz = 1, clock = 0;
      for (let k = 0; k < n && i0 + k < len; k++) {
        const t = k / CHIP_SR;
        let midi = e.midi;
        if (e.arp) midi += e.arp[Math.floor(t / e.arpStep) % e.arp.length];
        if (e.slideFrom !== undefined && t < e.slideTime) midi = e.slideFrom + (e.midi - e.slideFrom) * (t / e.slideTime);
        if (e.vib && t > e.vib.delay) midi += Math.sin((t - e.vib.delay) * e.vib.rate * 2 * Math.PI) * e.vib.depth * Math.min(1, (t - e.vib.delay) / 0.25);
        let env = e.perc ? Math.max(0, 1 - t / e.dur)
                         : t < 0.004 ? t / 0.004 : t < e.dur ? 1 - 0.45 * Math.min(1, t / Math.max(0.08, e.dur)) : 0.55 * Math.max(0, 1 - (t - e.dur) / rel);
        env = (Math.floor(env * 15) / 15) * e.vol;
        if (env <= 0) continue;
        const f = mtof(midi);
        let v;
        if (e.wave === "noise") {
          clock += (f * 8) / CHIP_SR;
          while (clock >= 1) { clock -= 1; const bit = (lfsr ^ (lfsr >> 6)) & 1; lfsr = (lfsr >> 1) | (bit << 14); nz = lfsr & 1 ? 1 : -1; }
          v = nz;
        } else {
          phase = (phase + f / CHIP_SR) % 1;
          const duty = e.pwm ? 0.3 + 0.18 * Math.sin(t * e.pwm * 2 * Math.PI) : e.duty;
          v = e.wave === "tri" ? Math.round((phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4) * 7.5) / 7.5 : phase < duty ? 1 : -1;
        }
        const s = (Math.round(v * env * 15) / 15) * 0.3;
        L[i0 + k] += s * gl; R[i0 + k] += s * gr;
      }
    }
    const buf = ctx.createBuffer(2, len, CHIP_SR);
    buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
    return buf;
  }
  function chipPhrase(t, c = chord()) {
    const { events, seconds } = composePhrase(c);
    const src = ctx.createBufferSource(); src.buffer = renderTrack(events, seconds);
    const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 110;
    lp.type = "lowpass"; lp.Q.value = -3;
    lp.frequency.setValueAtTime(600, t); lp.frequency.exponentialRampToValueAtTime(6500, t + 2.5);          // emerges from the void…
    lp.frequency.setValueAtTime(6500, t + seconds - 2.2); lp.frequency.exponentialRampToValueAtTime(700, t + seconds); // …and recedes
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.11, t + 1.5);
    g.gain.setValueAtTime(0.11, t + seconds - 1.6); g.gain.linearRampToValueAtTime(0, t + seconds);
    src.connect(hp).connect(lp).connect(g);
    const o = out(g, { ambient: true, pan: rand(-0.25, 0.25), dry: 0.4, rev: 0.75, del: 0.25 });
    const e = ctx.createGain(); e.gain.value = 0.25; g.connect(e).connect(echoIn);
    src.onended = () => { o.disconnect(); e.disconnect(); };
    src.start(t);
  }

  function every(min, max, fn) {
    const loop = () => { if (!ambientOn) return; fn(now() + 0.05); timers.push(setTimeout(loop, rand(min, max) * 1000)); };
    timers.push(setTimeout(loop, rand(min, max) * 1000));
  }
  function runAmbientTimers() {
    stopAmbientTimers();
    ambientOn = true;
    strings.forEach((s) => every(3, 9, (t) => gust(s, t)));
    pad.forEach((v) => every(7, 16, (t) => breathe(v, t)));
    every(6, 14, crystal);
    every(40, 75, deepBreath);
    every(9, 22, chatter);
    every(3.5, 9, piano);
    every(CHORD_SECONDS, CHORD_SECONDS, changeChord);                          // the harmony clock
  }
  function stopAmbientTimers() { ambientOn = false; timers.forEach(clearTimeout); timers = []; }
