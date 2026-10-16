// Code Room sound — everything is synthesized live with the Web Audio API; there are no samples.
//
// Palette: a dark, reverberant void tuned to D Lydian, in the spirit of the PS2 system menu.
//   Ambience: sub-bass pressure, a slowly breathing glass pad, aeolian "strings in the void"
//             (noise gusts exciting tuned feedback-comb strings), high air, and distant crystal
//             bells that drift in now and then.
//   Events:   glass ticks (hover), an FM bell + sub thump + the selected module's strands
//             plucked one by one (select), a bowed string while you drag a bubble, a deep boot
//             swell when a repository opens, shimmer on rescan, glass switches for the UI.
// Pitch carries meaning: every module has its own note (a hash of its path), and bigger
// modules (more functions) sound lower.
(() => {
  const ROOT = 38;                         // MIDI D2 (73.4 Hz)
  const SCALE = [0, 2, 4, 6, 7, 9, 11];    // Lydian: D E F# G# A B C#
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const weight = (n) => (n.funcs > 150 ? 2 : n.funcs > 40 ? 1 : 0); // bigger module, lower octave
  const noteOf = (id, octave) => ROOT + 12 * Math.max(0, octave) + SCALE[hash(id) % SCALE.length];

  let ctx = null, master, dry, revIn, delIn, echoIn, amb = [], sfx = [], ambLevel = 0, wave, white, pink;
  const AMBIENT_LEVEL = 0.55, SFX_LEVEL = 1.6;   // the room is a bed; interactions sit ~10 dB above it
  let enabled = true, volume = 0.7, started = false, ambientOn = false;
  let pad = [], strings = [], timers = [];
  const now = () => ctx.currentTime;

  // ---------- graph ----------
  function build(c) {
    ctx = c;
    master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.3;
    const clip = ctx.createWaveShaper(); clip.curve = softClip(); clip.oversample = "2x"; // round off any peak
    master.connect(comp).connect(clip).connect(ctx.destination);

    dry = ctx.createGain(); dry.connect(master);
    // reverb: a long generated hall whose tail darkens as it decays
    revIn = ctx.createGain();
    const pre = ctx.createDelay(0.2); pre.delayTime.value = 0.035;
    const lowCut = ctx.createBiquadFilter(); lowCut.type = "highpass"; lowCut.frequency.value = 110;
    const conv = ctx.createConvolver(); conv.buffer = impulse(6.5, 2.4);
    const shelf = ctx.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 5000; shelf.gain.value = -5;
    const revOut = ctx.createGain(); revOut.gain.value = 0.85;
    revIn.connect(pre).connect(lowCut).connect(conv).connect(shelf).connect(revOut).connect(master);
    // ping-pong echoes that bloom into the hall
    delIn = ctx.createGain();
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2), fb = ctx.createGain(), tone = ctx.createBiquadFilter();
    dl.delayTime.value = 0.42; dr.delayTime.value = 0.63; fb.gain.value = 0.36;
    tone.type = "lowpass"; tone.frequency.value = 3000; tone.Q.value = -3;
    const merge = ctx.createChannelMerger(2), delOut = ctx.createGain(); delOut.gain.value = 0.5;
    delIn.connect(dl); dl.connect(dr); dr.connect(tone).connect(fb).connect(dl);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
    merge.connect(delOut); delOut.connect(master); delOut.connect(revIn);
    // a darker, longer echo chamber for the wires: two taps that feed back through a band of tone
    echoIn = ctx.createGain();
    const eL = ctx.createDelay(2), eR = ctx.createDelay(2), efb = ctx.createGain(), elp = ctx.createBiquadFilter(), ehp = ctx.createBiquadFilter();
    eL.delayTime.value = 0.29; eR.delayTime.value = 0.37; efb.gain.value = 0.52;
    elp.type = "lowpass"; elp.frequency.value = 2400; elp.Q.value = -3; ehp.type = "highpass"; ehp.frequency.value = 260;
    echoIn.connect(eL); eL.connect(eR); eR.connect(elp).connect(ehp).connect(efb).connect(eL);
    const eMerge = ctx.createChannelMerger(2), eOut = ctx.createGain(); eOut.gain.value = 0.6;
    eL.connect(eMerge, 0, 0); eR.connect(eMerge, 0, 1);
    eMerge.connect(eOut); eOut.connect(master); eOut.connect(revIn);
    // ambience has its own fader on its sends
    amb = [dry, revIn, delIn].map((target) => { const g = ctx.createGain(); g.gain.value = 0; g.connect(target); return g; });
    sfx = [dry, revIn, delIn].map((target) => { const g = ctx.createGain(); g.gain.value = SFX_LEVEL; g.connect(target); return g; });

    wave = glassWave();
    white = noiseBuffer(false);
    pink = noiseBuffer(true);
  }

  function softClip() {
    const n = 2048, curve = new Float32Array(n), k = 1.4;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
    return curve;
  }

  function impulse(seconds, decay) {
    const sr = ctx.sampleRate, len = Math.floor(sr * seconds), buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.6 - 0.52 * t);       // one-pole lowpass closing over time
        const early = i < sr * 0.08 && Math.random() < 0.004 ? 4 : 1; // sparse early reflections
        d[i] = lp * Math.pow(1 - t, decay) * early;
      }
      const fade = Math.floor(sr * 0.004);
      for (let i = 0; i < fade; i++) d[i] *= i / fade;
    }
    return buf;
  }

  // a soft "glass organ" spectrum: strong fundamental, quickly fading partials
  function glassWave() {
    const amps = [0, 1, 0.42, 0.2, 0.12, 0.08, 0.05, 0.03, 0.02, 0.012, 0.008, 0.005];
    return ctx.createPeriodicWave(new Float32Array(amps.length), Float32Array.from(amps));
  }

  function noiseBuffer(isPink) {
    const sr = ctx.sampleRate, len = sr * 4, buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (!isPink) { d[i] = w * 0.5; continue; }
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    return buf;
  }
  function noise(isPink, t) {
    const s = ctx.createBufferSource(); s.buffer = isPink ? pink : white; s.loop = true;
    s.loopStart = Math.random() * 3; s.start(t, Math.random() * 3);
    return s;
  }

  // route a voice: panner → dry / reverb / delay sends (onto the ambience fader when amb)
  function out(node, { pan = 0, dry: d = 1, rev = 0.3, del = 0, ambient = false } = {}) {
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    node.connect(p);
    const targets = ambient ? amb : sfx;
    [d, rev, del].forEach((amt, i) => {
      if (amt > 0) { const g = ctx.createGain(); g.gain.value = amt; p.connect(g); g.connect(targets[i]); }
    });
    return p;
  }
  function lfo(rate, depth, param, t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = rate; g.gain.value = depth; o.connect(g).connect(param); o.start(t);
    return o;
  }

  // ---------- instruments ----------
  function bell(midi, { t = now(), gain = 0.05, pan = 0, dry: d = 0.55, rev = 0.6, del = 0.3, decay = 2.4, ratio = 3.5, index = 4 } = {}) {
    const f = mtof(midi);
    const car = ctx.createOscillator(); car.frequency.value = f;
    const mod = ctx.createOscillator(); mod.frequency.value = f * ratio;   // inharmonic ratio = glass
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * index, t); mg.gain.exponentialRampToValueAtTime(f * 0.04, t + decay * 0.45);
    mod.connect(mg).connect(car.frequency);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(gain, t + 0.004); amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const shim = ctx.createOscillator(); shim.frequency.value = f * 2; shim.detune.value = 9;  // the beating of a real bell
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t); sg.gain.linearRampToValueAtTime(gain * 0.22, t + 0.01); sg.gain.exponentialRampToValueAtTime(0.0001, t + decay * 0.6);
    car.connect(amp); shim.connect(sg);
    const o = out(amp, { pan, dry: d, rev, del }); sg.connect(o);
    const end = t + decay + 0.05;
    for (const x of [car, mod, shim]) { x.start(t); x.stop(end); }
    car.onended = () => o.disconnect();
  }

  function glassTick(midi, { t = now(), gain = 0.04, pan = 0, rev = 0.35, del = 0.12 } = {}) {
    const f = mtof(midi), amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(gain, t + 0.0015); amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    const a = ctx.createOscillator(); a.frequency.value = f;
    const b = ctx.createOscillator(); b.frequency.value = f * 2.756;            // a struck-glass overtone
    const bg = ctx.createGain(); bg.gain.setValueAtTime(0.5, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    a.connect(amp); b.connect(bg).connect(amp);
    const click = noise(false, t), hp = ctx.createBiquadFilter(), cg = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 6500;
    cg.gain.setValueAtTime(gain * 0.5, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    click.connect(hp).connect(cg).connect(amp);
    const o = out(amp, { pan, dry: 0.8, rev, del });
    for (const x of [a, b]) { x.start(t); x.stop(t + 0.32); }
    click.stop(t + 0.03);
    a.onended = () => o.disconnect();
  }

  // Karplus-Strong string, rendered once per note into a buffer and cached
  const pluckCache = new Map();
  function pluckBuffer(midi, bright) {
    const key = midi + ":" + bright.toFixed(1);
    if (pluckCache.has(key)) return pluckCache.get(key);
    const sr = ctx.sampleRate, f = mtof(midi), dur = Math.min(4, 1.4 + 140 / f);  // low strings ring longer
    const len = Math.floor(sr * dur), buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const period = sr / (f * (ch ? 1.0011 : 0.9989)), N = Math.floor(period), frac = period - N; // two detuned strings
      const ring = new Float32Array(N), exc = new Float32Array(N);
      let lp = 0;
      for (let i = 0; i < N; i++) { lp += (Math.random() * 2 - 1 - lp) * (0.2 + bright * 0.6); exc[i] = lp; }
      const pickAt = Math.max(1, Math.floor(N * 0.17));                         // plucked near the bridge
      for (let i = 0; i < N; i++) ring[i] = exc[i] - 0.65 * exc[(i + pickAt) % N];
      const rho = Math.pow(0.001, 1 / (f * dur)), c = (1 - frac) / (1 + frac);  // -60 dB over dur; allpass tuning
      let apX = 0, apY = 0, i0 = 0, dc = 0, peak = 1e-6;
      for (let n = 0; n < len; n++) {
        const a = ring[i0], b = ring[(i0 + 1) % N];
        dc += (a - dc) * 0.002;
        const s = a - dc; d[n] = s; peak = Math.max(peak, Math.abs(s));
        const v = rho * 0.5 * (a + b), y = c * v + apX - c * apY; apX = v; apY = y;
        ring[i0] = y; i0 = (i0 + 1) % N;
      }
      const atk = Math.floor(sr * 0.0015);
      for (let n = 0; n < len; n++) d[n] = (d[n] / peak) * 0.6 * (n < atk ? n / atk : 1);
    }
    pluckCache.set(key, buf);
    return buf;
  }
  function pluck(midi, { t = now(), gain = 0.15, pan = 0, bright = 0.5, dry: d = 0.7, rev = 0.5, del = 0.18 } = {}) {
    const src = ctx.createBufferSource(); src.buffer = pluckBuffer(midi, bright);
    const body = ctx.createBiquadFilter();                                     // a little wood in the body
    body.type = "peaking"; body.frequency.value = Math.min(4000, mtof(midi) * 2.5); body.Q.value = 1.1; body.gain.value = 4;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(body).connect(g);
    const o = out(g, { pan, dry: d, rev, del });
    src.start(t);
    src.onended = () => o.disconnect();
  }

  function whoosh(t, from, to, dur, gain, pan = 0, q = 1.2) {
    const src = noise(true, t), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = "bandpass"; bp.Q.value = q;
    bp.frequency.setValueAtTime(from, t); bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + dur * 0.45); g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp).connect(g);
    const o = out(g, { pan, dry: 0.5, rev: 0.6 });
    src.stop(t + dur + 0.05);
    src.onended = () => o.disconnect();
  }

  function thump(t, gain) {
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.frequency.setValueAtTime(125, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.22);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    lp.type = "lowpass"; lp.frequency.value = 220;
    o.connect(lp).connect(g);
    const p = out(g, { dry: 1, rev: 0.15 });
    o.start(t); o.stop(t + 0.5);
    o.onended = () => p.disconnect();
  }

  // ---------- chip: 8-bit voices rendered like an old sound chip ----------
  // Pulse waves (12.5 / 25 / 50 % duty), a 4-bit stair-step triangle and a 15-bit LFSR noise
  // channel in its short, metallic mode; 15-step volume envelopes; rendered at 22 kHz and then
  // sent through the same void as everything else, so the bits sit inside the room.
  const CHIP_SR = 22050, chipCache = new Map();
  function chipBuffer(notes, { wave = "pulse", duty = 0.25, step = 0.05, hold = 0.03, decay = 0.2, slide = 0 } = {}) {
    const key = [wave, duty, step, hold, decay, slide, ...notes].join(",");
    if (chipCache.has(key)) return chipCache.get(key);
    const len = Math.ceil(CHIP_SR * (step * (notes.length - 1) + hold + decay + 0.01));
    const buf = ctx.createBuffer(1, len, CHIP_SR), d = buf.getChannelData(0);
    let phase = 0, lfsr = 1, noiseOut = 1, clock = 0;
    for (let i = 0; i < len; i++) {
      const t = i / CHIP_SR, k = Math.min(notes.length - 1, Math.floor(t / step)), tn = t - k * step;
      const f = mtof(notes[k] + slide * tn);
      const fall = k === notes.length - 1 ? decay : Math.max(0.005, step - hold);
      const env = Math.floor(Math.max(0, tn < hold ? 1 : 1 - (tn - hold) / fall) * 15) / 15;
      let v;
      if (wave === "noise") {
        clock += (f * 8) / CHIP_SR;
        while (clock >= 1) { clock -= 1; const bit = (lfsr ^ (lfsr >> 6)) & 1; lfsr = (lfsr >> 1) | (bit << 14); noiseOut = lfsr & 1 ? 1 : -1; }
        v = noiseOut;
      } else {
        phase = (phase + f / CHIP_SR) % 1;
        v = wave === "tri" ? Math.round((phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4) * 7.5) / 7.5 : phase < duty ? 1 : -1;
      }
      d[i] = (Math.round(v * env * 15) / 15) * 0.5;
    }
    chipCache.set(key, buf);
    return buf;
  }
  function chip(notes, opts = {}, { t = now(), gain = 0.03, pan = 0, dry: d = 0.6, rev = 0.45, del = 0.3, echo = 0 } = {}) {
    const src = ctx.createBufferSource(); src.buffer = chipBuffer(notes, opts);
    const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 140;
    lp.type = "lowpass"; lp.frequency.value = 7000; lp.Q.value = -3;   // keep the edge, lose the fizz
    g.gain.value = gain;
    src.connect(hp).connect(lp).connect(g);
    const o = out(g, { pan, dry: d, rev, del });
    let e = null;
    if (echo) { e = ctx.createGain(); e.gain.value = echo; g.connect(e).connect(echoIn); }
    src.onended = () => { o.disconnect(); if (e) e.disconnect(); };
    src.start(t);
  }
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

  function fadeAmbient(level, time = 4) {
    ambLevel = level;
    const t = now();
    amb.forEach((g) => { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(level, t, time / 3); });
  }
  function setFocus(on) {   // a selected module brightens the room a little
    const t = now();
    pad.forEach((v) => v.filt.frequency.setTargetAtTime(on ? 1700 : 900, t, 1.2));
  }

  function bootAt(t, bloom) {
    const c = chord();
    const B = bloom || { start: 0.2, petals: Array.from({ length: 10 }, (_, k) => ({ at: 0.55 + k * 0.17, pan: Math.sin(k * 2.4) * 0.7 })), waves: [3, 3.95], end: 5.4 };
    const s0 = t + B.start, end = t + B.end;
    for (const [m, peak] of [[ROOT + c.sub, 0.15], [ROOT, 0.06]]) {             // the sub swells as the rose opens
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = mtof(m);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, s0 + 1.6); g.gain.exponentialRampToValueAtTime(0.0001, end + 1.5);
      o.connect(g); const p = out(g, { dry: 1, rev: 0.3 });
      o.start(t); o.stop(end + 1.6); o.onended = () => p.disconnect();
    }
    c.pad.forEach((iv0, i) => {                                                 // the chord blooms open with the petals
      const iv = iv0 - 12, filt = ctx.createBiquadFilter(), g = ctx.createGain();
      filt.type = "lowpass"; filt.Q.value = 0.8;
      filt.frequency.setValueAtTime(180, t); filt.frequency.exponentialRampToValueAtTime(2400, s0 + 1.9); filt.frequency.exponentialRampToValueAtTime(750, end + 1);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.032 / (1 + iv / 20), s0 + 1.9); g.gain.exponentialRampToValueAtTime(0.0001, end + 2.5);
      filt.connect(g);
      const oscs = [-8, 8].map((det) => {
        const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = mtof(ROOT + iv); o.detune.value = det;
        o.connect(filt); o.start(t); o.stop(end + 2.6); return o;
      });
      const p = out(g, { pan: (i / 5) * 1.4 - 0.7, dry: 0.35, rev: 0.9, del: 0.1 });
      oscs[0].onended = () => p.disconnect();
    });
    whoosh(s0, 260, 3200, 1.8, 0.03, 0, 0.8);                                   // the bud parting
    // petal cascade: soft plucks climbing the chord, one per sampled petal, panned where it opens
    const steps = ladder(ROOT + 19, B.petals.length + 2, c);
    B.petals.forEach((p, k) => {
      const at = t + p.at, x = k / Math.max(1, B.petals.length - 1);
      pluck(steps[k], { t: at, gain: 0.085 * (1 - 0.35 * x), pan: p.pan, bright: 0.25 + 0.3 * x, dry: 0.45, rev: 0.75, del: 0.3 });
      if (k % 3 === 2) glassTick(steps[k] + 24, { t: at + 0.02, gain: 0.012, pan: p.pan, rev: 0.6, del: 0.3 });
    });
    // each inward wave: the room inhales, a falling breath that lands on the centre
    B.waves.forEach((w, k) => {
      const at = t + w, g = k ? 0.022 : 0.04;
      whoosh(at, 4200, 320, 1.25, g, k ? 0.25 : -0.25, 0.9);
      bell(ROOT + c.root + 12, { t: at + 1.1, gain: k ? 0.02 : 0.035, decay: 2.6, index: 1.6, ratio: 2, rev: 0.75, del: 0.2 });
    });
    // settled: a low bell chord, then the chip flourish far off in the void
    [0, 7, 16].forEach((iv, i) => bell(ROOT + c.root + 12 + iv, { t: end + i * 0.06, gain: 0.04 / (1 + i * 0.4), pan: (i - 1) * 0.4, decay: 3.6, index: 2, ratio: 3.5, rev: 0.85, del: 0.35 }));
    const fl = ladder(ROOT + 36, 6, c);
    chip([...fl.slice(0, 5), ...fl.slice(0, 4).reverse()], { duty: 0.125, step: 0.045, hold: 0.025, decay: 0.25 },
         { t: end + 0.5, gain: 0.012, pan: 0.35, dry: 0.35, rev: 0.7, del: 0.5, echo: 0.4 });
    thump(end, 0.08);
  }

  // ---------- public API ----------
  const ready = () => ctx && started && enabled && ctx.state === "running";
  let lastHover = 0, lastBit = 0, lastKey = 0, lastSliderNote = -1, lastSlider = 0, bow = null;

  const api = {
    get enabled() { return enabled; },
    get volume() { return volume; },
    get musicOn() { return musicOn; },
    get state() { return !enabled ? "muted" : ctx ? ctx.state : "waiting for a click"; },

    // call from a user gesture (autoplay rules); safe to call again
    start() {
      if (!enabled) return;
      try {
        if (!ctx) build(new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" }));
        if (ctx.state === "suspended") ctx.resume();
        if (!started) {
          started = true;
          startAmbient(now() + 0.05);
          fadeAmbient(AMBIENT_LEVEL, 6);
          runAmbientTimers();
        } else if (!ambientOn) runAmbientTimers();
        master.gain.cancelScheduledValues(now());
        master.gain.setTargetAtTime(volume * 0.9, now(), 0.4);
      } catch (err) { console.warn("Code Room sound unavailable:", err); }
    },
    setEnabled(on) {
      enabled = on;
      if (!ctx) { if (on) api.start(); return; }
      if (on) { api.start(); }
      else {
        master.gain.setTargetAtTime(0, now(), 0.15);
        stopAmbientTimers();
        setTimeout(() => { if (!enabled && ctx.state === "running") ctx.suspend(); }, 700);
      }
    },
    // the musical layers (felt piano, chip phrases); the room's ambience keeps playing either way
    setMusic(on) { musicOn = !!on; },
    setVolume(v) {
      volume = clamp(v, 0, 1);
      if (ctx && enabled) master.gain.setTargetAtTime(volume * 0.9, now(), 0.08);
    },
    // pause the room while the window is hidden; pick up where it was when it comes back
    setHidden(hidden) {
      if (!ctx || !started || !enabled) return;
      if (hidden) { master.gain.setTargetAtTime(0, now(), 0.2); stopAmbientTimers(); setTimeout(() => document.hidden && ctx.suspend(), 800); }
      else { ctx.resume(); master.gain.setTargetAtTime(volume * 0.9, now(), 0.6); runAmbientTimers(); }
    },

    // a data pulse reached a module along a selected strand: a single bit lands there
    bit(n, pan = 0) {
      if (!ready() || !n) return;
      const t = now();
      if (t - lastBit < 0.06) return;
      lastBit = t;
      const m = noteOf(n.id, 4 - weight(n));
      chip([m, m + 12], { duty: 0.125, step: 0.028, hold: 0.015, decay: 0.07 }, { t, gain: 0.028, pan: pan * 0.8, dry: 0.5, rev: 0.45, del: 0.4, echo: 0.25 });
    },

    hover(n, pan = 0) {
      if (!ready() || !n) return;
      const t = now();
      if (t - lastHover < 0.07) return;
      lastHover = t;
      glassTick(noteOf(n.id, 4 - weight(n)), { t, gain: 0.032, pan: pan * 0.8 });
    },

    // deps: [{ n, refs, pan }] strongest first
    select(n, deps = [], pan = 0) {
      if (!ready() || !n) return;
      const t = now() + 0.01, m = noteOf(n.id, 3 - weight(n));
      thump(t, 0.16 + 0.07 * weight(n));
      whoosh(t, 500, 2600, 0.38, 0.03, pan);
      bell(m, { t, gain: 0.1, pan, decay: 2.8, index: 4, rev: 0.6, del: 0.3 });
      bell(m + 7, { t: t + 0.045, gain: 0.028, pan: pan * 0.5, decay: 2.2, index: 2.5 });
      bell(m + 14, { t: t + 0.09, gain: 0.018, pan: -pan * 0.5, decay: 2, index: 2 });
      setFocus(true);
      chip([m + 24, m + 31], { duty: 0.25, step: 0.03, hold: 0.02, decay: 0.1 }, { t: t + 0.02, gain: 0.02, pan, rev: 0.5, del: 0.35 }); // lock-on
      // the strands ring out: each dependency's string is plucked in turn
      deps.slice(0, 10).forEach((d, k) => pluck(noteOf(d.n.id, 2 - weight(d.n)), {
        t: t + 0.15 + k * 0.075, gain: 0.2 * Math.pow(0.88, k), pan: clamp(d.pan, -0.85, 0.85),
        bright: clamp(0.3 + Math.log2(1 + (d.refs || 1)) * 0.08, 0.3, 0.8), rev: 0.55, del: 0.22,
      }));
    },
    deselect() {
      if (!ready()) return;
      const t = now(), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(mtof(ROOT + 38), t); o.frequency.exponentialRampToValueAtTime(mtof(ROOT + 31), t + 0.35);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.025, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g); const p = out(g, { dry: 0.6, rev: 0.6, del: 0.15 });
      o.start(t); o.stop(t + 0.65); o.onended = () => p.disconnect();
      whoosh(t, 2400, 450, 0.32, 0.018);
      setFocus(false);
    },

    // Dragging a bubble pulls on its wires: each of its strongest strands becomes a taut metal
    // string tuned to the module at the other end. Moving scrapes them, stretching raises their
    // pitch, and letting go twangs them back down to rest, all feeding a long echo.
    // wires: [{ id, funcs }] for the strands to sound (strongest first)
    dragStart(n, pan = 0, wires = []) {
      if (!ready() || !n || bow) return;
      const t = now();
      const list = (wires.length ? wires : [n]).slice(0, 4);
      // friction: bright noise that excites every wire while the hand moves
      const src = noise(false, t), hp = ctx.createBiquadFilter(), bp = ctx.createBiquadFilter(), exc = ctx.createGain();
      hp.type = "highpass"; hp.frequency.value = 1200;
      bp.type = "bandpass"; bp.frequency.value = 3200; bp.Q.value = 0.8;
      exc.gain.value = 0;
      src.connect(hp).connect(bp).connect(exc);
      const bus = ctx.createGain(); bus.gain.value = 1;
      const p = out(bus, { pan, dry: 0.65, rev: 0.7, del: 0.25 });
      const echo = ctx.createGain(); echo.gain.value = 0.55; bus.connect(echo).connect(echoIn);
      const scrape = ctx.createGain(); scrape.gain.value = 0.1; exc.connect(scrape).connect(bus);    // the wire's own hiss
      const strings = list.map((w, k) => {
        let midi = noteOf(w.id, 0);
        while (mtof(midi) < 98) midi += 12;          // keep every wire between ~G2 and ~A3 so it can bend up a fifth
        const f = mtof(midi), dl = ctx.createDelay(0.05), damp = ctx.createBiquadFilter(), fb = ctx.createGain(), g = ctx.createGain();
        dl.delayTime.value = 1 / f;
        damp.type = "lowpass"; damp.frequency.value = 7500; damp.Q.value = -6;  // bright and metallic, never resonant
        fb.gain.value = 0.996;
        const send = ctx.createGain(); send.gain.value = 0.9 * Math.pow(0.8, k);
        exc.connect(send).connect(dl); dl.connect(damp).connect(fb).connect(dl);
        g.gain.value = 0.7 * Math.pow(0.85, k); dl.connect(g).connect(bus);
        return { dl, fb, f, midi };
      });
      glassTick(noteOf(n.id, 3 - weight(n)), { t, gain: 0.03, pan, rev: 0.4, del: 0.2 });  // the grab
      bow = { src, exc, bus, p, strings, pan, stretch: 0 };
    },
    // speed in px/s, stretch 0..1 (how far the bubble has been pulled)
    dragMove(speed, stretch = 0) {
      if (!bow) return;
      const t = now();
      bow.exc.gain.setTargetAtTime(Math.min(0.28, speed * 0.00028), t, 0.05);
      bow.stretch = clamp(stretch, 0, 1);
      const ratio = Math.pow(2, (bow.stretch * 7) / 12);                       // up to a fifth of tension
      for (const s of bow.strings) s.dl.delayTime.setTargetAtTime(1 / (s.f * ratio), t, 0.08);
    },
    dragEnd() {
      if (!bow) return;
      const b = bow; bow = null;
      const t = now(), ratio = Math.pow(2, (b.stretch * 7) / 12);
      b.exc.gain.setTargetAtTime(0, t, 0.08);
      // the wires spring back to rest: their pitch slides down while they keep ringing
      for (const s of b.strings) {
        s.dl.delayTime.cancelScheduledValues(t);
        s.dl.delayTime.setTargetAtTime(1 / s.f, t, 0.12);
        s.fb.gain.setTargetAtTime(0.97, t + 0.8, 0.6);
      }
      // and a twang per wire, sliding from the stretched pitch to its rest pitch
      b.strings.forEach((s, k) => {
        const src = ctx.createBufferSource();
        src.buffer = pluckBuffer(s.midi + 12, 0.7);
        src.playbackRate.setValueAtTime(ratio, t + k * 0.03);
        src.playbackRate.exponentialRampToValueAtTime(1, t + k * 0.03 + 0.35);
        const g = ctx.createGain(); g.gain.value = 0.38 * Math.pow(0.8, k);
        src.connect(g).connect(b.bus);
        src.start(t + k * 0.03);
      });
      setTimeout(() => { try { b.src.stop(); } catch (_) {} b.p.disconnect(); b.bus.disconnect(); }, 6000);
    },

    // a repository finished loading: the room blooms open. `bloom` carries the visual cues (seconds
    // from now): when the petals start, one { at, pan } per sampled petal in bloom order, the two
    // inward waves and the end. Without it a default timeline is used.
    boot({ bloom = null } = {}) { if (ready()) bootAt(now() + 0.05, bloom); },

    rescanStart() {
      if (!ready()) return;
      const t = now(), src = noise(false, t), bp = ctx.createBiquadFilter(), g = ctx.createGain(), trem = ctx.createGain();
      bp.type = "bandpass"; bp.frequency.value = 3600; bp.Q.value = 3;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.022, t + 0.15); g.gain.linearRampToValueAtTime(0, t + 0.7);
      trem.gain.value = 0.5; lfo(11, 0.5, trem.gain, t);
      src.connect(bp).connect(trem).connect(g);
      const p = out(g, { pan: -0.4, dry: 0.5, rev: 0.5 });
      p.pan.linearRampToValueAtTime(0.4, t + 0.7);
      src.stop(t + 0.75); src.onended = () => p.disconnect();
    },
    rescanResult({ added = 0, removed = 0, changed = 0 } = {}) {
      if (!ready()) return;
      const t = now() + 0.02;
      if (added) {
        [31, 35, 38].slice(0, Math.min(3, added)).forEach((iv, k) => bell(ROOT + iv + 12, { t: t + k * 0.09, gain: 0.035, pan: -0.3 + k * 0.3, decay: 2.2 }));
        chip([ROOT + 43, ROOT + 48], { duty: 0.5, step: 0.07, hold: 0.06, decay: 0.3 }, { t: t + 0.05, gain: 0.02, rev: 0.4, del: 0.35, echo: 0.3 });
      }
      if (removed) {
        [19, 14, 12].slice(0, Math.min(3, removed)).forEach((iv, k) => pluck(ROOT + iv, { t: t + 0.05 + k * 0.12, gain: 0.14, bright: 0.25 }));
        chip([ROOT + 31, ROOT + 26, ROOT + 19], { wave: "tri", step: 0.07, hold: 0.05, decay: 0.2 }, { t: t + 0.05, gain: 0.05, rev: 0.4, del: 0.3 });
      }
      if (changed && !added && !removed) { glassTick(ROOT + 43, { t, gain: 0.03 }); glassTick(ROOT + 47, { t: t + 0.07, gain: 0.025 }); }
      if (!added && !removed && !changed) glassTick(ROOT + 36, { t, gain: 0.025, rev: 0.5 });
    },

    ui(on = true) {
      if (!ready()) return;
      glassTick(ROOT + (on ? 43 : 36), { gain: 0.028, rev: 0.25, del: 0.05 });
      chip(on ? [ROOT + 43, ROOT + 50] : [ROOT + 50, ROOT + 43], { duty: 0.25, step: 0.035, hold: 0.02, decay: 0.06 }, { gain: 0.024, rev: 0.3, del: 0.15 });
    },
    key() {
      if (!ready()) return;
      const t = now();
      if (t - lastKey < 0.025) return;
      lastKey = t;
      chip([ROOT + 48 + ((Math.random() * 12) | 0)], { wave: "noise", hold: 0.006, decay: 0.025 }, { t, gain: 0.03, pan: rand(-0.2, 0.2), dry: 0.8, rev: 0.15, del: 0 });
    },
    slider(v) {   // v in 0..1: a soft tick that climbs the scale as the slider moves
      if (!ready()) return;
      const t = now(), step = Math.round(clamp(v, 0, 1) * 14), midi = ROOT + 24 + 12 * Math.floor(step / 7) + SCALE[step % 7];
      if (midi === lastSliderNote && t - lastSlider < 0.3) return;
      if (t - lastSlider < 0.04) return;
      lastSliderNote = midi; lastSlider = t;
      glassTick(midi, { t, gain: 0.02, rev: 0.2, del: 0 });
    },
    panel(open) {
      if (!ready()) return;
      whoosh(now(), open ? 400 : 2200, open ? 2200 : 400, 0.28, 0.014);
    },
    error() {
      if (!ready()) return;
      const t = now();
      for (const m of [ROOT + 12, ROOT + 13]) bell(m, { t, gain: 0.03, decay: 1.4, index: 1.5, ratio: 1.41, rev: 0.5 });
    },

    // live level of the master bus over the last ~40 ms (for tuning; not used by the page)
    meter() {
      if (!ctx) return null;
      if (!api._an) { api._an = ctx.createAnalyser(); api._an.fftSize = 2048; master.connect(api._an); }
      const d = new Float32Array(api._an.fftSize); api._an.getFloatTimeDomainData(d);
      let peak = 0, ss = 0, nan = 0;
      for (const v of d) { if (!isFinite(v)) { nan++; continue; } peak = Math.max(peak, Math.abs(v)); ss += v * v; }
      return { peakDb: Math.round(20 * Math.log10(peak + 1e-9)), rmsDb: Math.round(10 * Math.log10(ss / d.length + 1e-12)), nan };
    },

    // renders a scripted minute of the room offline and reports levels (for tuning; not used live)
    async renderTest(seconds = 16, { sfx: withSfx = true, music: withMusic = true, boot: withBoot = false } = {}) {
      const sr = 48000, off = new OfflineAudioContext(2, sr * seconds, sr);
      const saved = { ctx, master, dry, revIn, delIn, echoIn, amb, sfx, wave, white, pink, pad, strings, started, enabled, sub, chordIx };
      build(off); started = true; enabled = true;
      master.gain.value = 0.9 * volume;
      startAmbient(0.01); amb.forEach((g) => g.gain.setValueAtTime(AMBIENT_LEVEL, 0));
      for (let t = 0.5; t < seconds; t += 3) { strings.forEach((s) => gust(s, t)); pad.forEach((v) => breathe(v, t)); }
      crystal(2); crystal(9); deepBreath(4);
      if (withMusic) { piano(6.5); chipPhrase(5); }
      if (withBoot) bootAt(0.3, null);
      if (withSfx) {
        // scripted events at fixed times (an offline context's clock doesn't run, so every time is explicit)
        glassTick(noteOf("gz/Win", 3), { t: 1, gain: 0.032 });
        const deps = ["rz/cRZString", "gz/cIGZUnknown", "sc4/Budget", "gz/StreamOps", "audio/HitMan", "rz/cRZFile", "sc4/Lot", "gz/GZCOM"];
        const t0 = 3;
        thump(t0, 0.23); whoosh(t0, 500, 2600, 0.38, 0.03); bell(noteOf("sc4/Disaster", 2), { t: t0, gain: 0.1, decay: 2.8 });
        deps.forEach((id, k) => pluck(noteOf(id, 2), { t: t0 + 0.15 + k * 0.075, gain: 0.2 * Math.pow(0.88, k), pan: (k % 2 ? 1 : -1) * 0.5 }));
        [0, 7, 12, 16, 19, 26].forEach((iv) => bell(ROOT + 36 + (iv % 12), { t: 8 + iv * 0.01, gain: 0.034, decay: 3.2 }));
        glassTick(ROOT + 43, { t: 12, gain: 0.028 }); glassTick(ROOT + 36, { t: 12.4, gain: 0.028 });
      }
      const buf = await off.startRendering();
      ({ ctx, master, dry, revIn, delIn, echoIn, amb, sfx, wave, white, pink, pad, strings, started, enabled, sub, chordIx } = saved);
      // report: overall peak / RMS and loudness per second
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      let peak = 0, sum = 0, nan = 0;
      const perSecond = [];
      for (let s = 0; s < seconds; s++) {
        let ss = 0;
        for (let i = s * sr; i < (s + 1) * sr; i++) {
          const l = L[i], r = R[i];
          if (!isFinite(l) || !isFinite(r)) { nan++; continue; }
          peak = Math.max(peak, Math.abs(l), Math.abs(r)); ss += l * l + r * r;
        }
        sum += ss; perSecond.push(Math.round(10 * Math.log10(ss / (2 * sr) + 1e-12)));
      }
      return { peakDb: Math.round(20 * Math.log10(peak + 1e-12) * 10) / 10, rmsDb: Math.round(10 * Math.log10(sum / (2 * sr * seconds) + 1e-12) * 10) / 10, nan, perSecondDb: perSecond, buffer: buf };
    },
  };
  window.CodeRoomSound = api;
})();
