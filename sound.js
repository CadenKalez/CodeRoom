// Code Room sound — real recorded instruments and places, played and processed live with Web Audio.
//
// Palette: a dark, reverberant void tuned to D Lydian, in the spirit of the PS2 system menu and the
// PS3 home screen. The sample pack (samples/, all CC0 / public domain, see samples/CREDITS.md) gives
// the room real material; everything also has a synthesized fallback, so the room never goes silent.
//   Beds:     a distant sea (slowed ocean waves), rain on glass as high static, a trickle of water,
//             real wind that both breathes and bows the aeolian strings.
//   Tonal:    singing wine glasses and bowed vibraphone gliding through a slow chord progression,
//             a sub drone on the root, hand chimes and glockenspiel drifting in on chord tones.
//   Music:    a felt Steinway now and then, and a far-off radio: openly licensed Amiga modules (played
//             by a ProTracker engine) and chiptune tracks (music/, see music/CREDITS.md), drifting in
//             every few minutes as if from another room, very quietly.
//   Events:   glockenspiel on hover, a bell + harp strands plucked one by one on select, a bowed
//             psaltery while dragging, timpani / cymbal / kalimba / gong as a repository blooms open.
// Pitch carries meaning: every module has its own note (a hash of its path), bigger modules lower.
//
// Mix: voices → per-voice sends → group faders → group duck stages → dry / hall / echo returns →
// master: volume → 24 Hz high-pass → glue compressor → peak limiter → soft clip.
(() => {
  const ROOT = 38;                         // MIDI D2 (73.4 Hz)
  const SCALE = [0, 2, 4, 6, 7, 9, 11];    // Lydian: D E F# G# A B C#
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dB = (v) => Math.pow(10, v / 20);

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const weight = (n) => (n.funcs > 150 ? 2 : n.funcs > 40 ? 1 : 0); // bigger module, lower octave
  const noteOf = (id, octave) => ROOT + 12 * Math.max(0, octave) + SCALE[hash(id) % SCALE.length];
  const into = (m, lo, hi) => { while (m < lo) m += 12; while (m > hi) m -= 12; return m; };   // fold a note into an instrument's range

  let ctx = null, master, dry, revIn, delIn, echoIn, wave, white, pink;
  let groups = {}, meters = {};
  const GROUP_LEVELS = { bed: 0.55, tonal: 0.55, music: 0.75, sfx: 1.6 };   // the room is a bed; interactions sit ~10 dB above it
  let enabled = true, volume = 0.7, started = false, ambientOn = false;
  let pad = [], strings = [], beds = [], timers = [], windSrc = null;
  const now = () => ctx.currentTime;

  // ---------- graph ----------
  function build(c) {
    ctx = c;
    master = ctx.createGain(); master.gain.value = 0;
    const hp1 = ctx.createBiquadFilter(), hp2 = ctx.createBiquadFilter();             // nothing below hearing reaches the speakers
    hp1.type = hp2.type = "highpass"; hp1.frequency.value = hp2.frequency.value = 24; hp1.Q.value = hp2.Q.value = 0.707;
    const glue = ctx.createDynamicsCompressor();                                     // slow and gentle: holds the room together
    glue.threshold.value = -20; glue.knee.value = 12; glue.ratio.value = 2.2; glue.attack.value = 0.03; glue.release.value = 0.35;
    const limit = ctx.createDynamicsCompressor();                                    // fast and hard: catches the peaks
    limit.threshold.value = -2.5; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.002; limit.release.value = 0.12;
    const trim = ctx.createGain(); trim.gain.value = dB(-4.3);                      // both compressors add make-up gain; give it back
    const clip = ctx.createWaveShaper(); clip.curve = softClip(); clip.oversample = "2x";
    master.connect(hp1).connect(hp2).connect(glue).connect(limit).connect(trim).connect(clip).connect(ctx.destination);

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
    // a darker, longer echo chamber for the wires and the chip music: two taps through a band of tone
    echoIn = ctx.createGain();
    const eL = ctx.createDelay(2), eR = ctx.createDelay(2), efb = ctx.createGain(), elp = ctx.createBiquadFilter(), ehp = ctx.createBiquadFilter();
    eL.delayTime.value = 0.29; eR.delayTime.value = 0.37; efb.gain.value = 0.52;
    elp.type = "lowpass"; elp.frequency.value = 2400; elp.Q.value = -3; ehp.type = "highpass"; ehp.frequency.value = 260;
    echoIn.connect(eL); eL.connect(eR); eR.connect(elp).connect(ehp).connect(efb).connect(eL);
    const eMerge = ctx.createChannelMerger(2), eOut = ctx.createGain(); eOut.gain.value = 0.6;
    eL.connect(eMerge, 0, 0); eR.connect(eMerge, 0, 1);
    eMerge.connect(eOut); eOut.connect(master); eOut.connect(revIn);

    // groups: each has a fader per send and, after it, a duck stage, so fades and ducks never fight
    groups = {};
    for (const [name, level] of Object.entries(GROUP_LEVELS)) {
      const sends = [], ducks = [];
      for (const target of [dry, revIn, delIn]) {
        const f = ctx.createGain(), d = ctx.createGain();
        f.gain.value = name === "bed" || name === "tonal" ? 0 : level;            // ambience fades in when the room starts
        f.connect(d).connect(target); sends.push(f); ducks.push(d);
      }
      groups[name] = { sends, ducks, level };
    }
    // meters: the lighting follows the music and the whole room; the kick meter finds the beat
    meters = {};
    for (const name of ["music", "all", "kick"]) {
      const an = ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0;
      if (name === "kick") {
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 160; lp.Q.value = 0.7;
        groups.music.sends[0].connect(lp).connect(an);
      } else (name === "all" ? master : groups.music.sends[0]).connect(an);
      meters[name] = { an, buf: new Float32Array(an.fftSize), level: 0, avg: 0, last: 0 };
    }

    wave = glassWave();
    white = noiseBuffer(false);
    pink = noiseBuffer(true);
  }

  function fadeGroup(name, level, time = 4) {
    const t = now();
    for (const g of groups[name].sends) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(level, t, time / 3); }
  }
  // dip a group by `db` for a moment (attack / hold / release in seconds), or hold it down (hold = Infinity)
  function duck(name, db, attack = 0.05, hold = 0.3, release = 1.2, t = now()) {
    for (const g of groups[name].ducks) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(dB(db), t, attack / 3);
      if (hold !== Infinity) g.gain.setTargetAtTime(1, t + attack + hold, release / 3);
    }
  }
  function unduck(name, release = 3) {
    const t = now();
    for (const g of groups[name].ducks) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(1, t, release / 3); }
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

  // route a voice: panner → dry / reverb / delay sends of its group
  function out(node, { pan = 0, dry: d = 1, rev = 0.3, del = 0, group = "sfx", ambient = false } = {}) {
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    node.connect(p);
    const targets = groups[ambient ? "tonal" : group].sends;
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

  // ---------- the sample pack ----------
  // Loaded once per page; decoded buffers outlive any AudioContext, so offline test renders reuse them.
  const bank = { one: {}, loops: {}, beds: {}, ready: false, loading: null };
  function onsetOf(buf) {      // skip the silence an encoder may have put in front
    const d = buf.getChannelData(0), n = Math.min(d.length, Math.floor(buf.sampleRate * 0.3));
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < n; i++) if (Math.abs(d[i]) > peak * 0.05) return Math.max(0, i - 32) / buf.sampleRate;
    return 0;
  }
  function reversed(buf) {
    const r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) r.getChannelData(ch).set(buf.getChannelData(ch).slice().reverse());
    return r;
  }
  function loadSamples() {
    if (bank.loading || !ctx || typeof fetch !== "function") return bank.loading;
    const base = new URL("samples/", document.baseURI).href;
    const get = (file) => fetch(base + file).then((r) => { if (!r.ok) throw new Error(file); return r.arrayBuffer(); })
                                            .then((a) => new Promise((ok, no) => ctx.decodeAudioData(a, ok, no)));
    bank.loading = fetch(base + "manifest.json").then((r) => r.json()).then(async (M) => {
      const jobs = [];
      for (const [name, b] of Object.entries(M.beds)) jobs.push([0, () => get(b.file).then((buf) => { bank.beds[name] = { buf }; })]);
      for (const [g, list] of Object.entries(M.loops)) list.forEach((e) => jobs.push([1, () => get(e.file).then((buf) => {
        (bank.loops[g] = bank.loops[g] || []).push({ buf, root: e.root });
      })]));
      for (const [g, list] of Object.entries(M.oneshots)) list.forEach((e) => jobs.push([2, () => get(e.file).then((buf) => {
        (bank.one[g] = bank.one[g] || []).push({ buf, root: e.root, off: onsetOf(buf) });
      })]));
      jobs.sort((a, b) => a[0] - b[0]);
      let i = 0;
      const worker = async () => { while (i < jobs.length) { const j = jobs[i++]; try { await j[1](); } catch (_) {} } };
      await Promise.all([worker(), worker(), worker(), worker()]);
      for (const list of [...Object.values(bank.one), ...Object.values(bank.loops)]) if (list[0].root !== undefined) list.sort((a, b) => a.root - b.root);
      if (bank.one.cymbal) bank.one.inhale = bank.one.cymbal.map((s) => ({ buf: reversed(s.buf), off: 0 }));
      bank.ready = true;
      if (started) upgradeAmbient(now() + 0.1);
    }).catch((err) => { console.warn("Code Room samples unavailable, staying synthesized:", err); });
    return bank.loading;
  }
  const has = (g) => !!(bank.one[g] && bank.one[g].length);
  function nearest(list, midi) {
    let best = list[0];
    for (const s of list) if (Math.abs(s.root - midi) < Math.abs(best.root - midi)) best = s;
    return best;
  }
  // a one-shot sample; pitched groups play `midi`, others take `rate` (and `pick` for a variation)
  function sample(g, { midi = null, rate = 1, pick = null, t = now(), gain = 0.2, pan = 0, dry: d = 0.7, rev = 0.4, del = 0, group = "sfx",
                       lp = 0, hp = 0, dur = 0, fade = 0.3, at = 0, dest = null } = {}) {
    const list = bank.one[g];
    if (!list || !list.length) return null;
    const s = midi !== null ? nearest(list, midi) : list[pick !== null ? pick % list.length : (Math.random() * list.length) | 0];
    const src = ctx.createBufferSource(); src.buffer = s.buf;
    src.playbackRate.value = midi !== null ? Math.pow(2, (midi - s.root) / 12) : rate;
    let node = src;
    if (hp) { const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp; node = node.connect(f); }
    if (lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; f.Q.value = 0.5; node = node.connect(f); }
    const g2 = ctx.createGain(); g2.gain.value = gain; node.connect(g2);
    const o = dest ? (g2.connect(dest), g2) : out(g2, { pan, dry: d, rev, del, group });
    src.start(t, (s.off || 0) + at);
    if (dur) { g2.gain.setValueAtTime(gain, t + dur); g2.gain.setTargetAtTime(0, t + dur, fade / 3); src.stop(t + dur + fade * 2); }
    src.onended = () => o.disconnect();
    return { src, gain: g2, out: o };
  }
  // a sustained, looping sample at a pitch; returns a voice whose pitch can glide
  function sustain(g, midi, { t = now(), gain = 0.1, lp = 0, group = "tonal", pan = 0, dry: d = 0.3, rev = 0.9, del = 0.1, attack = 3 } = {}) {
    const list = bank.loops[g];
    if (!list || !list.length) return null;
    const s = nearest(list, midi), src = ctx.createBufferSource();
    src.buffer = s.buf; src.loop = true;
    src.playbackRate.value = Math.pow(2, (midi - s.root) / 12);
    const filt = ctx.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = lp || 6000; filt.Q.value = 0.5;
    const amp = ctx.createGain(); amp.gain.value = 0;
    src.connect(filt).connect(amp);
    const o = out(amp, { pan, dry: d, rev, del, group });
    amp.gain.setTargetAtTime(gain, t, attack / 3);
    src.start(t, Math.random() * s.buf.duration);
    return {
      src, filt, amp, root: s.root,
      glide(m, at, time = 0.8) { src.playbackRate.setTargetAtTime(Math.pow(2, (m - s.root) / 12), at, time / 3); },
      stop(at = now(), release = 1.5) { amp.gain.cancelScheduledValues(at); amp.gain.setTargetAtTime(0, at, release / 3); src.stop(at + release * 2.5); src.onended = () => o.disconnect(); },
    };
  }
  // a bed: a long recording played as overlapping windows from random places, so it never loops audibly
  function bedLayer(name, { gain = 0.1, rate = 1, lp = 0, hp = 0, seg = 16, xf = 5, pan = 0, dry: d = 0.6, rev = 0.4, del = 0, group = "bed" } = {}) {
    const b = bank.beds[name];
    if (!b) return null;
    const fader = ctx.createGain(); fader.gain.value = 0;
    let head = fader;
    const lpf = ctx.createBiquadFilter(); lpf.type = "lowpass"; lpf.frequency.value = lp || 18000; lpf.Q.value = 0.4;
    const hpf = ctx.createBiquadFilter(); hpf.type = "highpass"; hpf.frequency.value = hp || 20; hpf.Q.value = 0.5;
    hpf.connect(lpf).connect(fader);
    const o = out(fader, { pan, dry: d, rev, del, group });
    const layer = {
      name, fader, lpf, hpf, out: o, next: 0, gain,
      ensure(until) {
        layer.next = Math.max(layer.next, now());
        const span = seg * rate, len = b.buf.duration;
        while (layer.next < until) {
          const t = layer.next, src = ctx.createBufferSource(), env = ctx.createGain();
          src.buffer = b.buf; src.playbackRate.value = rate;
          env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + xf);
          env.gain.setValueAtTime(1, t + seg - xf); env.gain.linearRampToValueAtTime(0, t + seg);
          src.connect(env).connect(hpf);
          src.start(t, rand(0, Math.max(0, len - span - 0.1)));
          src.stop(t + seg + 0.05);
          src.onended = () => env.disconnect();
          layer.next = t + seg - xf;
        }
      },
    };
    beds.push(layer);
    return layer;
  }

  // ---------- synthesized instruments (and fallbacks) ----------
  function bell(midi, { t = now(), gain = 0.05, pan = 0, dry: d = 0.55, rev = 0.6, del = 0.3, decay = 2.4, ratio = 3.5, index = 4, group = "sfx" } = {}) {
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
    const o = out(amp, { pan, dry: d, rev, del, group }); sg.connect(o);
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
  function pluck(midi, { t = now(), gain = 0.15, pan = 0, bright = 0.5, dry: d = 0.7, rev = 0.5, del = 0.18, group = "sfx" } = {}) {
    const src = ctx.createBufferSource(); src.buffer = pluckBuffer(midi, bright);
    const body = ctx.createBiquadFilter();                                     // a little wood in the body
    body.type = "peaking"; body.frequency.value = Math.min(4000, mtof(midi) * 2.5); body.Q.value = 1.1; body.gain.value = 4;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(body).connect(g);
    const o = out(g, { pan, dry: d, rev, del, group });
    src.start(t);
    src.onended = () => o.disconnect();
  }
  // a real harp string when the pack is here, the synthesized one otherwise
  function harp(midi, o = {}) {
    if (!sample("harp", { midi, ...o, gain: (o.gain || 0.15) * 1.6, lp: o.lp || 5200 })) pluck(midi, o);
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

  // ---------- chip: 8-bit voices ----------
  // Short UI blips are rendered once like an old sound chip (4-bit envelopes, LFSR noise) and cached.
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
  function chip(notes, opts = {}, { t = now(), gain = 0.03, pan = 0, dry: d = 0.6, rev = 0.45, del = 0.3, echo = 0, group = "sfx" } = {}) {
    const src = ctx.createBufferSource(); src.buffer = chipBuffer(notes, opts);
    const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 140;
    lp.type = "lowpass"; lp.frequency.value = 7000; lp.Q.value = -3;   // keep the edge, lose the fizz
    g.gain.value = gain;
    src.connect(hp).connect(lp).connect(g);
    const o = out(g, { pan, dry: d, rev, del, group });
    let e = null;
    if (echo) { e = ctx.createGain(); e.gain.value = echo; g.connect(e).connect(echoIn); }
    src.onended = () => { o.disconnect(); if (e) e.disconnect(); };
    src.start(t);
  }
  // ---------- harmony: the room's slow progression ----------
  // I – vi – IV – V in D, voiced with Lydian colour and smooth voice leading. Every 16 s the pad
  // glides to the next chord, the aeolian strings retune into it and the sub follows the root;
  // every melodic layer (crystals, piano, petals) takes its notes from the chord in force.
  const CHORDS = [
    { name: "Dmaj9#11", pad: [12, 19, 26, 28, 32, 35], root: 0, triad: [0, 4, 7], ext: [11, 14, 18], sub: -12, strings: [0, 7, 12, 16, 19] },
    { name: "Bm11", pad: [9, 16, 24, 26, 31, 35], root: 9, triad: [0, 3, 7], ext: [10, 14, 17], sub: -15, strings: [-3, 4, 9, 12, 16] },
    { name: "Gmaj9#11", pad: [5, 12, 21, 28, 31, 35], root: 5, triad: [0, 4, 7], ext: [11, 14, 18], sub: -7, strings: [5, 9, 12, 17, 21] },
    { name: "A6/9", pad: [7, 14, 21, 26, 28, 35], root: 7, triad: [0, 4, 7], ext: [9, 14], sub: -5, strings: [7, 11, 14, 19, 21] },
  ];
  const CHORD_SECONDS = 16;
  let chordIx = 0, sub = null, musicOn = true;
  const chord = () => CHORDS[chordIx];
  // chord tones from `low` upward, ascending: the ladder every melody climbs
  function ladder(low, count, c = chord()) {
    const pcs = [...new Set([...c.triad, ...c.ext].map((iv) => (c.root + iv) % 12))].sort((a, b) => a - b);
    const res = [];
    for (let m = low; res.length < count; m++) if (pcs.includes((((m - ROOT) % 12) + 12) % 12)) res.push(m);
    return res;
  }
  const chordNote = (low, span) => { const l = ladder(low, span); return l[(Math.random() * l.length) | 0]; };
  // pad voice i of chord c: the three low voices are bowed vibraphone, the three high ones singing glass an octave up
  const padMidi = (c, i) => ROOT + c.pad[i] + (i >= 3 ? 12 : 0);

  function changeChord(t) {
    if (radio.playing) return;                                               // the music holds the harmony
    chordIx = (chordIx + 1) % CHORDS.length;
    const c = chord();
    pad.forEach((v, i) => {
      v.oscs.forEach((o) => o.frequency.setTargetAtTime(mtof(ROOT + c.pad[i]), t, 0.7));
      if (v.real) v.real.glide(padMidi(c, i), t, 2.2);
    });
    strings.forEach((s, i) => s.dl.delayTime.setTargetAtTime(1 / mtof(ROOT + c.strings[i]), t, 0.9));
    if (sub) sub.frequency.setTargetAtTime(mtof(ROOT + c.sub), t, 1.2);
  }

  function chatter(t) {   // distant data packets crossing the void
    if (radio.playing) return;
    const n = 3 + ((Math.random() * 4) | 0), l = ladder(ROOT + 36 + ((Math.random() * 5) | 0), 7), notes = [];
    for (let k = 0; k < n; k++) notes.push(l[Math.min(l.length - 1, k + ((Math.random() * 2) | 0))]);
    chip(notes, { duty: [0.125, 0.25, 0.5][(Math.random() * 3) | 0], step: rand(0.035, 0.06), hold: 0.02, decay: 0.12 },
         { t, gain: 0.012, pan: rand(-0.9, 0.9), dry: 0.2, rev: 0.85, del: 0.6, echo: 0.45, group: "tonal" });
  }

  // ---------- ambience ----------
  let colorFilter = null, airGain = null, synthTide = [];
  function startAmbient(t) {
    const c = chord();
    // 1. sub pressure: the chord root down in the floor, with A1 and D2 above it, breathing slowly
    [[c.sub, 0.06], [ROOT - 5, 0.03], [ROOT, 0.03]].forEach(([m, g], i) => {
      const o = ctx.createOscillator(), a = ctx.createGain();
      o.frequency.value = mtof(ROOT + (i === 0 ? m : m - ROOT)); a.gain.value = g;
      lfo(rand(0.03, 0.07), g * 0.5, a.gain, t);
      o.connect(a); out(a, { group: "tonal", dry: 1, rev: 0.25 }); o.start(t);
      if (i === 0) sub = o;
    });
    // 2. glass pad: six voices spread wide; each drifts in and out on its own and glides with the chords
    //    (synthesized here; the real glass and vibes join it when the sample pack is in)
    pad = c.pad.map((iv, i) => {
      const f = mtof(ROOT + iv), filt = ctx.createBiquadFilter(), g = ctx.createGain(), syn = ctx.createGain();
      filt.type = "lowpass"; filt.Q.value = 0.6; filt.frequency.value = 900;
      lfo(rand(0.02, 0.05), 450, filt.frequency, t);
      const oscs = [-6, 7].map((det) => {
        const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = f; o.detune.value = det;
        lfo(rand(0.08, 0.2), 3, o.detune, t);                                  // slow chorus wobble
        o.connect(filt); o.start(t);
        return o;
      });
      g.gain.value = 0; syn.gain.value = 1; filt.connect(syn).connect(g);
      out(g, { group: "tonal", pan: (i / 5) * 1.5 - 0.75, dry: 0.22, rev: 0.95, del: 0.08 });
      return { g, syn, filt, oscs, level: 0.05 / (1 + iv / 24), pan: (i / 5) * 1.5 - 0.75, real: null };
    });
    pad.forEach((v) => v.g.gain.setTargetAtTime(v.level * rand(0.3, 1), t, 3));
    // 3. aeolian strings: wind through tuned feedback-comb strings (pink noise until the real wind arrives)
    windSrc = noise(true, t);
    colorFilter = ctx.createBiquadFilter();
    colorFilter.type = "bandpass"; colorFilter.frequency.value = 650; colorFilter.Q.value = 0.5;
    lfo(0.035, 380, colorFilter.frequency, t);
    windSrc.connect(colorFilter);
    const breath = ctx.createGain(); breath.gain.value = 0.02;                 // the wind itself, barely there
    colorFilter.connect(breath); out(breath, { group: "bed", dry: 0.3, rev: 0.7, pan: 0 });
    strings = c.strings.map((iv, i) => {
      const f = mtof(ROOT + iv), exc = ctx.createGain(), dl = ctx.createDelay(0.05), damp = ctx.createBiquadFilter(), fb = ctx.createGain();
      exc.gain.value = 0;
      dl.delayTime.value = 1 / f;
      damp.type = "lowpass"; damp.frequency.value = 2400 + f * 5;
      damp.Q.value = -6;      // no resonant bump: in a feedback loop any gain above 1 runs away
      fb.gain.value = 0.991;
      colorFilter.connect(exc); exc.connect(dl); dl.connect(damp).connect(fb).connect(dl);
      lfo(rand(0.08, 0.2), (1 / f) * 0.0009, dl.delayTime, t);               // the string breathes in pitch
      const o = ctx.createGain(); o.gain.value = 0.3; dl.connect(o);
      out(o, { group: "tonal", pan: [-0.6, 0.5, -0.2, 0.7, 0.1][i], dry: 0.3, rev: 0.9, del: 0.14 });
      return { exc, dl };
    });
    // 4. air: a high, slowly moving hiss — the size of the room
    const air = noise(false, t), hp = ctx.createBiquadFilter(), bp = ctx.createBiquadFilter();
    airGain = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 5000; bp.type = "bandpass"; bp.Q.value = 0.6; bp.frequency.value = 8000;
    lfo(0.05, 2000, bp.frequency, t);
    airGain.gain.value = 0.07;
    air.connect(hp).connect(bp).connect(airGain);
    const ap = out(airGain, { group: "bed", dry: 0.4, rev: 0.6 });
    lfo(0.03, 0.6, ap.pan, t);
    // 5. tide: two slow waves of filtered noise that swell and brighten together, out of step
    synthTide = [[0.071, -0.55], [0.053, 0.55]].map(([rate, pan]) => {
      const src = noise(true, t), lp = ctx.createBiquadFilter(), g = ctx.createGain(), fader = ctx.createGain();
      lp.type = "lowpass"; lp.Q.value = -3; lp.frequency.value = 650;
      lfo(rate, 520, lp.frequency, t);                                        // the wave brightens as it rises…
      g.gain.value = 0.022; lfo(rate, 0.02, g.gain, t);                       // …and swells at the same moment
      fader.gain.value = 1;
      src.connect(lp).connect(g).connect(fader);
      out(fader, { group: "bed", pan, dry: 0.5, rev: 0.65 });
      return fader;
    });
    if (bank.ready) upgradeAmbient(t);
  }

  // the sample pack arrived: real material fades in over the synthesized room and takes the lead
  let upgraded = false;
  function upgradeAmbient(t) {
    if (upgraded || !pad.length) return;
    upgraded = true;
    const c = chord(), fade = 6;
    // real pad voices: bowed vibraphone low, singing glass high, through each voice's breathing filter
    pad.forEach((v, i) => {
      const g = i < 3 ? "vibes" : "glass";
      v.real = sustain(g, padMidi(c, i), { t, gain: (i < 3 ? 0.55 : 0.32) / (1 + i * 0.15), lp: i < 3 ? 1400 : 2600, pan: v.pan, attack: fade * 1.5, dry: 0.25, rev: 0.95, del: 0.1 });
      if (v.real) { v.real.amp.disconnect(); v.real.filt.disconnect(); v.real.filt.connect(v.real.amp).connect(v.g); lfo(rand(0.02, 0.05), 700, v.real.filt.frequency, t); }
      v.syn.gain.setTargetAtTime(0.35, t, fade / 3);                          // the synth stays underneath for warmth
    });
    // real wind bows the aeolian strings and breathes on its own
    const wind = bedLayer("wind", { gain: 0.35, hp: 120, lp: 3500, seg: 18, xf: 6, dry: 0.6, rev: 0.6 });
    if (wind && colorFilter) {
      const toStrings = ctx.createGain(); toStrings.gain.value = 0; wind.lpf.connect(toStrings).connect(colorFilter);
      toStrings.gain.setTargetAtTime(2.2, t, fade / 3);
      windSrc.stop(t + fade * 2);
    }
    // the distant sea: ocean waves slowed and darkened into a tide, swelling slowly
    const sea = bedLayer("ocean", { gain: 0.5, rate: 0.72, lp: 900, hp: 40, seg: 20, xf: 7, dry: 0.65, rev: 0.5 });
    if (sea) { lfo(0.045, 380, sea.lpf.frequency, t); synthTide.forEach((f) => f.gain.setTargetAtTime(0, t, fade / 3)); }
    // rain on glass, high-passed into a fine static: the data in the air
    const rain = bedLayer("rain", { gain: 0.14, hp: 3200, lp: 11000, seg: 15, xf: 5, dry: 0.5, rev: 0.4 });
    if (rain && airGain) airGain.gain.setTargetAtTime(0.03, t, fade / 3);
    // a trickle of water, far and band-limited; it comes closer while a module is selected
    const water = bedLayer("water", { gain: 0.05, hp: 700, lp: 5200, seg: 14, xf: 5, dry: 0.4, rev: 0.7, del: 0.1, pan: -0.3 });
    if (water) lfo(0.021, 0.6, water.out.pan, t);
    for (const b of beds) { b.fader.gain.setTargetAtTime(b.gain, t, fade / 3); b.ensure(t + 10); }
  }

  function gust(s, t) { s.exc.gain.setTargetAtTime(Math.random() < 0.3 ? 0 : rand(0.01, 0.07), t, rand(1.5, 4)); }
  function breathe(v, t) { v.g.gain.setTargetAtTime(Math.random() < 0.2 ? 0 : v.level * rand(0.25, 1), t, rand(4, 9)); }
  function crystal(t) {
    if (radio.playing) return;
    const l = ladder(ROOT + 36, 10);
    const count = Math.random() < 0.3 ? 2 + ((Math.random() * 2) | 0) : 1;
    let k = (Math.random() * (l.length - 3)) | 0;
    for (let i = 0; i < count; i++) {
      const m = l[k], at = t + i * 0.19, pan = rand(-0.8, 0.8);
      const real = has("chime") && Math.random() < 0.6
        ? sample("chime", { midi: m, t: at, gain: 0.07, pan, dry: 0.25, rev: 0.9, del: 0.45, group: "tonal" })
        : sample("glock", { midi: m + 12, t: at, gain: 0.05, pan, dry: 0.2, rev: 0.9, del: 0.5, group: "tonal", lp: 7000 });
      if (!real) bell(l[k], { t: at, gain: 0.016, pan, dry: 0.25, rev: 0.9, del: 0.55, decay: 3.4, index: 2.5, group: "tonal" });
      k = Math.min(l.length - 1, k + 1 + ((Math.random() * 2) | 0));
    }
  }
  // felt piano: a soft, dark note now and then, sometimes with its fifth or octave
  function piano(t) {
    if (!musicOn || radio.playing) return;
    const m = chordNote(ROOT + 24, 8), pan = rand(-0.5, 0.5), other = m + (Math.random() < 0.5 ? 7 : 12), two = Math.random() < 0.35;
    if (sample("piano", { midi: m, t, gain: 0.22, pan, lp: 1700, dry: 0.5, rev: 0.75, del: 0.25, group: "music" })) {
      if (two) sample("piano", { midi: other, t: t + rand(0.08, 0.3), gain: 0.13, pan: -pan, lp: 1900, dry: 0.45, rev: 0.8, del: 0.25, group: "music" });
      return;
    }
    pluck(m, { t, gain: 0.08, pan, bright: 0.15, dry: 0.45, rev: 0.75, del: 0.3, group: "music" });
    if (two) pluck(other, { t: t + rand(0.08, 0.3), gain: 0.05, pan: -pan, bright: 0.15, dry: 0.4, rev: 0.8, del: 0.3, group: "music" });
  }
  function deepBreath(t) {                                                     // the room inhales, rarely
    if (sample("gong", { pick: 1 + ((Math.random() * 3) | 0), rate: rand(0.42, 0.55), t, gain: 0.3, lp: 900, dry: 0.5, rev: 0.8, group: "bed" })) return;
    const src = noise(true, t), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = "lowpass"; lp.frequency.value = 170;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 4); g.gain.linearRampToValueAtTime(0, t + 10);
    src.connect(lp).connect(g);
    const o = out(g, { group: "bed", dry: 0.7, rev: 0.6 });
    src.stop(t + 10.5); src.onended = () => o.disconnect();
  }
  function windChimes(t) {                                                     // somewhere far off, the chimes stir
    if (radio.playing) return;
    sample("windchime", { t, rate: rand(0.85, 1.05), gain: 0.09, pan: rand(-0.7, 0.7), hp: 1500, dry: 0.2, rev: 0.95, del: 0.3, group: "bed", dur: rand(5, 9), fade: 3 });
  }
  function seaSwell(t) {                                                       // the ocean drum rolls once, slowly
    sample("oceandrum", { t, rate: rand(0.6, 0.75), gain: 0.16, lp: 1400, pan: rand(-0.5, 0.5), dry: 0.5, rev: 0.7, group: "bed", dur: rand(8, 12), fade: 4 });
  }

  // ---------- the radio: real tracker and chiptune music, heard from another room ----------
  // Openly licensed Amiga modules and chiptune tracks (music/CREDITS.md). Every few minutes one
  // drifts in as if through a closed door: quiet, lowpassed, wet, never in front of the room.
  // Modules play on the ProTracker engine below (Paula's four voices, sample by sample); the mp3
  // tracks stream from disk. Nothing repeats until the whole list has had its turn.
  const radio = { list: null, order: [], playing: null, timer: 0, onTrack: null, notes: [], mods: new Map() };
  const RADIO_LEVEL = dB(-14);
  const PAL = 7093789.2, MOD_SR = 22050;
  const SINE = Array.from({ length: 32 }, (_, i) => Math.round(255 * Math.sin((Math.PI * i) / 32)));
  function parseMod(ab) {
    const u8 = new Uint8Array(ab), dv = new DataView(ab);
    const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n)).replace(/\0[\s\S]*$/, "").trim();
    const samples = [];
    for (let i = 0, o = 20; i < 31; i++, o += 30) {
      samples.push({ len: dv.getUint16(o + 22) * 2, fine: ((u8[o + 24] & 15) ^ 8) - 8, vol: Math.min(64, u8[o + 25]), rs: dv.getUint16(o + 26) * 2, rl: dv.getUint16(o + 28) * 2 });
    }
    const songLen = u8[950], order = [...u8.subarray(952, 1080)], nPat = Math.max(...order) + 1, patterns = [];
    let p = 1084;
    for (let k = 0; k < nPat; k++, p += 1024) patterns.push(u8.subarray(p, p + 1024));
    for (const s of samples) { const n = Math.max(0, Math.min(s.len, ab.byteLength - p)); s.data = new Int8Array(ab, Math.min(p, ab.byteLength), n); p += s.len; }
    return { title: str(0, 20), samples, songLen, order, patterns };
  }
  // Which samples carry melody and which are drums: across the whole song a drum hits one or two
  // pitches, an instrument moves around. Each melodic sample also gets an octave shift that puts it
  // in a good piano register (the lowest voice becomes the left hand), so a module can play on piano.
  function modVoices(mod) {
    if (mod.voices) return mod.voices;
    const use = mod.samples.map(() => ({ pers: new Map(), n: 0 }));
    for (let k = 0; k < mod.songLen; k++) {
      const pat = mod.patterns[mod.order[k]];
      if (!pat) continue;
      for (let o = 0; o < 1024; o += 4) {
        const smp = (pat[o] & 0xf0) | (pat[o + 2] >> 4), per = ((pat[o] & 0x0f) << 8) | pat[o + 1];
        if (smp && per && use[smp - 1]) { const u = use[smp - 1]; u.n++; u.pers.set(per, (u.pers.get(per) || 0) + 1); }
      }
    }
    const pitch = (per, fine) => 60 + 12 * Math.log2(428 / per) + fine / 8;          // C-2 (period 428) as middle C
    const mel = use.map((u, i) => {
      if (u.pers.size < 4 || u.n < 8) return null;
      const all = [];
      for (const [p, c] of u.pers) for (let j = 0; j < c; j++) all.push(pitch(p, mod.samples[i].fine));
      all.sort((a, b) => a - b);
      return { median: all[all.length >> 1] };
    });
    const meds = mel.filter(Boolean).map((m) => m.median).sort((a, b) => a - b);
    const bass = meds.length > 1 && meds[1] - meds[0] >= 7 ? meds[0] : null;
    for (const m of mel) if (m) m.shift = 12 * Math.round(((m.median === bass ? 46 : 67) - m.median) / 12);
    return (mod.voices = mel);
  }
  // one ProTracker song on four voices into `bus`, from t0; pump(until) schedules ticks ahead of time.
  // piano: play the melodic voices on the felt Steinway instead of the Amiga samples.
  function modPlayer(mod, bus, t0, { maxSeconds = 600, onNote = null, piano = false } = {}) {
    const voices = modVoices(mod);
    if (!mod.bufs) mod.bufs = mod.samples.map((s) => {           // decoded once; buffers outlive any AudioContext
      if (s.data.length < 4) return null;
      const b = ctx.createBuffer(1, s.data.length, MOD_SR), d = b.getChannelData(0);
      for (let i = 0; i < s.data.length; i++) d[i] = s.data[i] / 128;
      return b;
    });
    const S = mod.samples, bufs = mod.bufs;
    // Amiga channels are hard-panned L R R L; at 60 % they stay wide without hurting on headphones
    const chans = [-0.6, 0.6, 0.6, -0.6].map((pn) => {
      const pan = ctx.createStereoPanner(); pan.pan.value = pn; pan.connect(bus);
      return { pan, src: null, g: null, smp: 0, period: 0, vol: 0, lastVol: -1, fine: 0, target: 0, porta: 0, vibPos: 0, vibSpd: 0, vibDep: 0,
               tremPos: 0, tremSpd: 0, tremDep: 0, fx: 0, prm: 0, offMem: 0, loopRow: 0, loopCnt: 0, delayed: false, pendPer: 0 };
    });
    let speed = 6, bpm = 125, pos = 0, row = 0, tick = 0, rowDelay = 0, jump = null, next = t0, done = false;
    const end = t0 + maxSeconds;
    const rateOf = (c, per) => (PAL / (2 * Math.max(57, per))) / MOD_SR * Math.pow(2, c.fine / 96);
    const slide = (c) => clamp(c.vol + ((c.prm >> 4) ? (c.prm >> 4) : -(c.prm & 15)), 0, 64);
    function pianoNote(c, i, t) {
      const v = voices[c.smp];
      if (!v || !c.vol || !c.period) return;
      const base = pitch(c) + v.shift, notes = [base];
      if (c.fx === 0 && c.prm) notes.push(base + (c.prm >> 4), base + (c.prm & 15));   // an arpeggio becomes a chord
      if (c.keys) for (const h of c.keys) { h.gain.gain.cancelScheduledValues(t); h.gain.gain.setTargetAtTime(0, t + 0.05, 0.12); h.src.stop(t + 1); }  // the damper falls
      c.keys = notes.map((m, k) => sample("piano", { midi: m, t: t + k * 0.014, gain: 0.32 * (c.vol / 64) * (k ? 0.45 : 1), lp: 2000, dest: c.pan })).filter(Boolean);
      if (onNote) onNote(i, c.vol / 64, t, false);
    }
    const pitch = (c) => 60 + 12 * Math.log2(428 / c.period) + c.fine / 8;
    function trigger(c, i, t) {
      if (piano) { pianoNote(c, i, t); return; }
      if (c.src) { c.g.gain.setTargetAtTime(0, t, 0.004); c.src.stop(t + 0.04); c.src = null; }
      const s = S[c.smp], b = bufs[c.smp];
      if (!b || !c.period) return;
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = b;
      if (s.rl > 2 && s.rs < b.length) { src.loop = true; src.loopStart = s.rs / MOD_SR; src.loopEnd = Math.min(b.length, s.rs + s.rl) / MOD_SR; }
      src.playbackRate.setValueAtTime(rateOf(c, c.period), t);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(c.vol / 64, t + 0.003);
      src.connect(g).connect(c.pan);
      src.start(t, Math.min(c.fx === 9 ? c.offMem : 0, b.length - 1) / MOD_SR);
      src.onended = () => g.disconnect();
      c.src = src; c.g = g; c.lastVol = c.vol; c.vibPos = 0; c.tremPos = 0;
      if (onNote && c.vol) onNote(i, c.vol / 64, t, !voices[c.smp]);
    }
    function output(c, t, per, vol) {
      if (!c.src) return;
      c.src.playbackRate.setValueAtTime(rateOf(c, per), t);
      if (vol !== c.lastVol) { c.g.gain.setValueAtTime(vol / 64, t); c.lastVol = vol; }
    }
    function doRow(t) {
      const pat = mod.patterns[mod.order[pos]];
      if (!pat) { done = true; return; }
      for (let i = 0; i < 4; i++) {
        const c = chans[i], o = (row * 4 + i) * 4;
        const smp = (pat[o] & 0xf0) | (pat[o + 2] >> 4), per = ((pat[o] & 0x0f) << 8) | pat[o + 1], fx = pat[o + 2] & 0x0f, prm = pat[o + 3];
        c.fx = fx; c.prm = prm; c.delayed = false;
        if (smp && S[smp - 1]) { c.smp = smp - 1; c.vol = S[c.smp].vol; c.fine = S[c.smp].fine; }
        if (fx === 9 && prm) c.offMem = prm * 256;
        if (per) {
          if (fx === 3 || fx === 5) { c.target = per; if (piano) { c.period = per; pianoNote(c, i, t); } }   // a glide: the piano just plays where it lands
          else if (fx === 0xe && prm >> 4 === 0xd && (prm & 15)) { c.delayed = true; c.pendPer = per; }
          else { c.period = per; trigger(c, i, t); }
        }
        const x = prm & 15;
        switch (fx) {
          case 0x3: if (prm) c.porta = prm; break;
          case 0x4: if (prm >> 4) c.vibSpd = prm >> 4; if (x) c.vibDep = x; break;
          case 0x7: if (prm >> 4) c.tremSpd = prm >> 4; if (x) c.tremDep = x; break;
          case 0xb: jump = { pos: prm, row: 0 }; break;
          case 0xc: c.vol = Math.min(64, prm); break;
          case 0xd: jump = { pos: jump ? jump.pos : pos + 1, row: Math.min(63, (prm >> 4) * 10 + x) }; break;
          case 0xe:
            switch (prm >> 4) {
              case 0x1: c.period = Math.max(113, c.period - x); break;
              case 0x2: c.period = Math.min(856, c.period + x); break;
              case 0x6: if (!x) c.loopRow = row; else { c.loopCnt = c.loopCnt ? c.loopCnt - 1 : x; if (c.loopCnt) jump = { pos, row: c.loopRow, loop: true }; } break;
              case 0xa: c.vol = Math.min(64, c.vol + x); break;
              case 0xb: c.vol = Math.max(0, c.vol - x); break;
              case 0xc: if (!x) c.vol = 0; break;
              case 0xe: rowDelay = x; break;
            }
            break;
          case 0xf: if (prm) { if (prm < 32) speed = prm; else bpm = prm; } break;
        }
        output(c, t, c.period, c.vol);
      }
    }
    function doTick(t, k) {
      for (let i = 0; i < 4; i++) {
        const c = chans[i], x = c.prm >> 4, y = c.prm & 15;
        let per = c.period, vol = c.vol;
        switch (c.fx) {
          case 0x0: if (c.prm) per = c.period / Math.pow(2, (k % 3 === 1 ? x : k % 3 === 2 ? y : 0) / 12); break;
          case 0x1: per = c.period = Math.max(113, c.period - c.prm); break;
          case 0x2: per = c.period = Math.min(856, c.period + c.prm); break;
          case 0x3: case 0x5:
            if (c.target && c.period) { const d = c.target - c.period; c.period += Math.sign(d) * Math.min(c.porta, Math.abs(d)); per = c.period; }
            if (c.fx === 0x5) vol = c.vol = slide(c);
            break;
          case 0x4: case 0x6:
            per = c.period + ((c.vibPos & 32) ? -1 : 1) * (SINE[c.vibPos & 31] * c.vibDep) / 128;
            c.vibPos = (c.vibPos + c.vibSpd) & 63;
            if (c.fx === 0x6) vol = c.vol = slide(c);
            break;
          case 0x7:
            vol = clamp(c.vol + ((c.tremPos & 32) ? -1 : 1) * (SINE[c.tremPos & 31] * c.tremDep) / 64, 0, 64);
            c.tremPos = (c.tremPos + c.tremSpd) & 63;
            break;
          case 0xa: vol = c.vol = slide(c); break;
          case 0xe:
            if (x === 0x9 && y && k % y === 0 && !piano) trigger(c, i, t);
            else if (x === 0xc && k === y) vol = c.vol = 0;
            else if (x === 0xd && k === y && c.delayed) { c.delayed = false; c.period = c.pendPer; trigger(c, i, t); }
            break;
        }
        output(c, t, per, vol);
      }
    }
    return {
      get done() { return done; },
      pump(until) {
        while (!done && next < until) {
          if (tick === 0) doRow(next); else if (tick % speed) doTick(next, tick % speed);
          const t = next;
          next += 2.5 / bpm;
          if (++tick >= speed * (1 + rowDelay)) {
            tick = 0; rowDelay = 0;
            if (jump) { if (jump.pos <= pos && !jump.loop) done = true; pos = jump.pos; row = jump.row; jump = null; }
            else if (++row >= 64) { row = 0; pos++; }
            if (pos >= mod.songLen) done = true;                          // the song ended or looped: let it go
          }
          if (t > end) done = true;
        }
        return next;
      },
      stop(t, fade = 0.4) {
        for (const c of chans) {
          if (c.src) { c.g.gain.cancelScheduledValues(t); c.g.gain.setTargetAtTime(0, t, fade / 3); c.src.stop(t + fade * 3); c.src = null; }
          if (c.keys) for (const h of c.keys) { h.gain.gain.cancelScheduledValues(t); h.gain.gain.setTargetAtTime(0, t, fade); h.src.stop(t + fade * 4); }
        }
      },
    };
  }

  const musicBase = () => new URL("music/", document.baseURI).href;
  async function radioList() {
    if (!radio.list) radio.list = await fetch(musicBase() + "playlist.json").then((r) => r.json()).catch(() => []);
    return radio.list;
  }
  async function loadMod(file) {
    if (!radio.mods.has(file)) radio.mods.set(file, parseMod(await fetch(musicBase() + file).then((r) => r.arrayBuffer())));
    return radio.mods.get(file);
  }
  // the other room: a closed door (lowpass that breathes a little), the hall and the dark echo
  function farRoom(t0, seconds, gainDb = 0, fadeIn = 9, fadeOut = 10) {
    const level = RADIO_LEVEL * dB(gainDb);                                  // each track measured to sit ~10 dB under the room
    const input = ctx.createGain(), hp = ctx.createBiquadFilter(), door = ctx.createBiquadFilter(), env = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = 140; hp.Q.value = 0.5;
    door.type = "lowpass"; door.frequency.value = 2400; door.Q.value = 0.4;
    const sway = ctx.createOscillator(), swayAmt = ctx.createGain();
    sway.frequency.value = 0.031; swayAmt.gain.value = 700; sway.connect(swayAmt).connect(door.frequency); sway.start(t0); sway.stop(t0 + seconds + 2);
    env.gain.setValueAtTime(0, t0); env.gain.linearRampToValueAtTime(level, t0 + fadeIn);
    env.gain.setValueAtTime(level, t0 + seconds - fadeOut); env.gain.linearRampToValueAtTime(0, t0 + seconds);
    input.connect(hp).connect(door).connect(env);
    const o = out(env, { group: "music", dry: 0.35, rev: 0.85, del: 0.12 });
    const e = ctx.createGain(); e.gain.value = 0.12; env.connect(e).connect(echoIn);
    return {
      input, env,
      fadeNow(time = 6) { const t = now(); env.gain.cancelScheduledValues(t); env.gain.setValueAtTime(env.gain.value, t); env.gain.linearRampToValueAtTime(0, t + time); return t + time; },
      close(at) { setTimeout(() => { try { sway.stop(); } catch (_) {} o.disconnect(); e.disconnect(); }, Math.max(0, at - now() + 1) * 1000); },
    };
  }
  // play one entry of the playlist from t0 for about `seconds` (offline renders pass prefill)
  async function radioPlay(entry, t0, { seconds = rand(120, 210), prefill = false, piano = null } = {}) {
    const isMod = entry.file.endsWith(".mod");
    if (piano === null) piano = isMod && entry.piano !== false && Math.random() < 0.45;   // some modules come through on the felt piano
    piano = piano && isMod && has("piano");
    const room = farRoom(t0, seconds, piano ? entry.pianoGain || 0 : entry.gain || 0);
    const job = { entry, room, t0, end: t0 + seconds, player: null, el: null, piano };
    radio.playing = job;
    if (radio.onTrack && !prefill) radio.onTrack({ title: entry.title, artist: entry.artist, license: entry.license, piano });
    if (!prefill) { duck("tonal", -6, 5, Infinity); duck("bed", -1.5, 5, Infinity); }
    if (entry.file.endsWith(".mod")) {
      const mod = await loadMod(entry.file);
      job.player = modPlayer(mod, room.input, t0, { maxSeconds: seconds, piano, onNote: prefill ? null : (ch, v, t, drum) => radio.notes.push({ ch, v, t, drum }) });
      if (prefill) { job.player.pump(t0 + seconds); return job; }
      const tick = () => {
        if (radio.playing !== job) return;
        job.player.pump(now() + 0.3);
        if (job.player.done && now() < job.end - 10) { job.end = room.fadeNow(8); job.player.stop(job.end); }
        if (now() > job.end) { radioEnd(); return; }
        radio.timer = setTimeout(tick, 70);
      };
      tick();
    } else if (prefill) {
      const buf = await fetch(musicBase() + entry.file).then((r) => r.arrayBuffer()).then((a) => new Promise((ok, no) => ctx.decodeAudioData(a, ok, no)));
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(room.input); src.start(t0, Math.min(30, buf.duration / 4)); src.stop(t0 + seconds);
    } else {
      const el = new Audio(musicBase() + entry.file); el.preload = "auto"; job.el = el;
      const node = ctx.createMediaElementSource(el); node.connect(room.input);
      el.addEventListener("loadedmetadata", () => {
        el.currentTime = rand(0, Math.max(0, el.duration - seconds - 5));   // drift in somewhere in the middle
        el.play().catch(() => radioEnd());
      }, { once: true });
      el.addEventListener("ended", () => { if (radio.playing === job) { job.end = room.fadeNow(3); } }, { once: true });
      const tick = () => { if (radio.playing !== job) return; if (now() > job.end) { radioEnd(); return; } radio.timer = setTimeout(tick, 500); };
      tick();
    }
    return job;
  }
  function radioEnd(fade = 0) {
    const job = radio.playing;
    clearTimeout(radio.timer);
    radio.playing = null;
    if (job) {
      const until = fade ? job.room.fadeNow(fade) : now();
      if (job.player) job.player.stop(until);
      if (job.el) setTimeout(() => { job.el.pause(); job.el.removeAttribute("src"); job.el.load(); }, (until - now() + 0.5) * 1000);
      job.room.close(until + 1);
    }
    radio.notes.length = 0;
    if (ctx) { unduck("tonal", 8); unduck("bed", 8); }
    if (radio.onTrack) radio.onTrack(null);
    if (ambientOn && musicOn) scheduleRadio(rand(100, 260));
  }
  function scheduleRadio(seconds) {
    clearTimeout(radio.timer);
    radio.timer = setTimeout(async () => {
      if (!ambientOn || !musicOn || radio.playing || !ready()) { if (ambientOn && musicOn) scheduleRadio(30); return; }
      const list = await radioList();
      if (!list.length) return;
      if (!radio.order.length) radio.order = list.map((_, i) => i).sort(() => Math.random() - 0.5);
      radioPlay(list[radio.order.pop()], now() + 0.3).catch(() => radioEnd());
    }, seconds * 1000);
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
    every(45, 100, windChimes);
    every(30, 70, seaSwell);
    every(CHORD_SECONDS, CHORD_SECONDS, changeChord);                          // the harmony clock
    every(2.5, 2.5, () => beds.forEach((b) => b.ensure(now() + 9)));            // keep every bed's windows queued
    if (musicOn && !radio.playing) scheduleRadio(rand(70, 150));
  }
  function stopAmbientTimers() {
    ambientOn = false; timers.forEach(clearTimeout); timers = [];
    if (radio.playing) { const r = radio.onTrack; radio.onTrack = null; radioEnd(1.5); radio.onTrack = r; if (r) r(null); } clearTimeout(radio.timer);
  }

  function setFocus(on) {   // a selected module brightens the room a little and brings the water closer
    const t = now();
    pad.forEach((v) => { v.filt.frequency.setTargetAtTime(on ? 1700 : 900, t, 1.2); if (v.real) v.real.filt.frequency.setTargetAtTime(on ? 3200 : 1600, t, 1.2); });
    for (const b of beds) if (b.name === "water") b.fader.gain.setTargetAtTime(b.gain * (on ? 2.2 : 1), t, 1.5);
  }

  function bootAt(t, bloom) {
    const c = chord();
    const B = bloom || { start: 0.2, petals: Array.from({ length: 10 }, (_, k) => ({ at: 0.55 + k * 0.17, pan: Math.sin(k * 2.4) * 0.7 })), waves: [3, 3.95], end: 5.4 };
    const s0 = t + B.start, end = t + B.end;
    duck("bed", -5, 0.4, B.end, 3, t); duck("tonal", -4, 0.4, B.end, 3, t);
    for (const [m, peak] of [[ROOT + c.sub, 0.15], [ROOT, 0.06]]) {             // the sub swells as the rose opens
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = mtof(m);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, s0 + 1.6); g.gain.exponentialRampToValueAtTime(0.0001, end + 1.5);
      o.connect(g); const p = out(g, { dry: 1, rev: 0.3 });
      o.start(t); o.stop(end + 1.6); o.onended = () => p.disconnect();
    }
    // the ground trembles (timpani roll) and a cymbal swells as the bud parts
    sample("timpani", { t, gain: 0.16, rate: 0.85, lp: 1600, dry: 0.7, rev: 0.6, dur: B.end, fade: 2.5 });
    if (!sample("cymbal", { pick: 0, t: s0, rate: 1.5, gain: 0.09, hp: 400, dry: 0.4, rev: 0.8, dur: 3.2, fade: 1.6 })) whoosh(s0, 260, 3200, 1.8, 0.03, 0, 0.8);
    // the chord blooms open with the petals: bowed vibraphone if we have it, the glass synth otherwise
    c.pad.slice(0, 4).forEach((iv, i) => {
      const v = sustain("vibes", padMidi(c, i) + (i >= 3 ? -12 : 0), { t: s0, gain: 0.07 / (1 + i * 0.3), group: "sfx", lp: 2400, pan: (i / 3) * 1.4 - 0.7, attack: 1.6, dry: 0.35, rev: 0.9 });
      if (v) { v.stop(end + 0.5, 3); return; }
      const iv2 = iv - 12, filt = ctx.createBiquadFilter(), g = ctx.createGain();
      filt.type = "lowpass"; filt.Q.value = 0.8;
      filt.frequency.setValueAtTime(180, t); filt.frequency.exponentialRampToValueAtTime(2400, s0 + 1.9); filt.frequency.exponentialRampToValueAtTime(750, end + 1);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.032 / (1 + iv2 / 20), s0 + 1.9); g.gain.exponentialRampToValueAtTime(0.0001, end + 2.5);
      filt.connect(g);
      const oscs = [-8, 8].map((det) => {
        const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = mtof(ROOT + iv2); o.detune.value = det;
        o.connect(filt); o.start(t); o.stop(end + 2.6); return o;
      });
      const p = out(g, { pan: (i / 3) * 1.4 - 0.7, dry: 0.35, rev: 0.9, del: 0.1 });
      oscs[0].onended = () => p.disconnect();
    });
    // petal cascade: kalimba (or plucked strings) climbing the chord, one per sampled petal, panned where it opens
    const steps = ladder(ROOT + 31, B.petals.length + 2, c);
    B.petals.forEach((p, k) => {
      const at = t + p.at, x = k / Math.max(1, B.petals.length - 1);
      if (!sample("kalimba", { midi: steps[k], t: at, gain: 0.1 * (1 - 0.35 * x), pan: p.pan, dry: 0.5, rev: 0.75, del: 0.3 }))
        pluck(steps[k] - 12, { t: at, gain: 0.085 * (1 - 0.35 * x), pan: p.pan, bright: 0.25 + 0.3 * x, dry: 0.45, rev: 0.75, del: 0.3 });
      if (k % 3 === 2 && !sample("glock", { midi: into(steps[k] + 12, 79, 102), t: at + 0.02, gain: 0.045, pan: p.pan, rev: 0.7, del: 0.3 }))
        glassTick(steps[k] + 12, { t: at + 0.02, gain: 0.012, pan: p.pan, rev: 0.6, del: 0.3 });
    });
    // each inward wave: the room inhales (a reversed cymbal) and a chime lands on the centre
    B.waves.forEach((w, k) => {
      const at = t + w, g = k ? 0.6 : 1;
      const inhale = bank.one.inhale && bank.one.inhale[1];
      if (inhale) {
        const src = ctx.createBufferSource(), amp = ctx.createGain(), hp = ctx.createBiquadFilter();
        src.buffer = inhale.buf; hp.type = "highpass"; hp.frequency.value = 600; amp.gain.value = 0.16 * g;
        src.connect(hp).connect(amp); const o = out(amp, { pan: k ? 0.25 : -0.25, dry: 0.4, rev: 0.7 });
        const len = 1.2; src.start(at, Math.max(0, inhale.buf.duration - len)); src.onended = () => o.disconnect();
      } else whoosh(at, 4200, 320, 1.25, 0.04 * g, k ? 0.25 : -0.25, 0.9);
      if (!sample("chime", { midi: ROOT + c.root + 36, t: at + 1.15, gain: 0.12 * g, rev: 0.8, del: 0.2 }))
        bell(ROOT + c.root + 12, { t: at + 1.1, gain: 0.035 * g, decay: 2.6, index: 1.6, ratio: 2, rev: 0.75, del: 0.2 });
    });
    // settled: a gong far away, a low chime chord, a shimmer of bell tree, then the chip flourish
    sample("gong", { pick: 2, t: end, rate: 0.7, gain: 0.3, lp: 3000, rev: 0.9 });
    [0, 7, 16].forEach((iv, i) => {
      if (!sample("chime", { midi: into(ROOT + c.root + 24 + iv, 72, 92), t: end + i * 0.06, gain: 0.1 / (1 + i * 0.4), pan: (i - 1) * 0.4, rev: 0.85, del: 0.35 }))
        bell(ROOT + c.root + 12 + iv, { t: end + i * 0.06, gain: 0.04 / (1 + i * 0.4), pan: (i - 1) * 0.4, decay: 3.6, index: 2, ratio: 3.5, rev: 0.85, del: 0.35 });
    });
    sample("belltree", { pick: 0, t: end + 0.3, gain: 0.08, hp: 2000, rev: 0.9, del: 0.3 });
    const fl = ladder(ROOT + 36, 6, c);
    chip([...fl.slice(0, 5), ...fl.slice(0, 4).reverse()], { duty: 0.125, step: 0.045, hold: 0.025, decay: 0.25 },
         { t: end + 0.5, gain: 0.013, pan: 0.35, dry: 0.35, rev: 0.7, del: 0.5, echo: 0.4 });
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
    get samples() { return bank.ready ? "real" : bank.loading ? "loading" : "synth"; },
    get nowPlaying() { return radio.playing ? radio.playing.entry.title : null; },
    set onTrack(fn) { radio.onTrack = fn; },
    // note-ons from the Amiga modules that have reached the speakers (the lights pulse with them)
    notesDue() {
      if (!ctx || !radio.notes.length) return null;
      const t = now(), due = [];
      while (radio.notes.length && radio.notes[0].t <= t) due.push(radio.notes.shift());
      return due.length ? due : null;
    },

    // call from a user gesture (autoplay rules); safe to call again
    start() {
      if (!enabled) return;
      try {
        if (!ctx) { build(new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" })); loadSamples(); }
        if (ctx.state === "suspended") ctx.resume();
        if (!started) {
          started = true;
          startAmbient(now() + 0.05);
          fadeGroup("bed", GROUP_LEVELS.bed, 6); fadeGroup("tonal", GROUP_LEVELS.tonal, 6);
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
    // the musical layers (felt piano, the far-off radio); the room's ambience keeps playing either way
    setMusic(on) {
      musicOn = !!on;
      if (!ctx || !started) return;
      if (!musicOn && radio.playing) radioEnd(3);
      else if (!musicOn) clearTimeout(radio.timer);
      else if (ambientOn && !radio.playing) scheduleRadio(rand(20, 45));
    },
    // play a track now (title / file substring or index); for trying the radio out
    async play(which = null) {
      if (!ready()) return null;
      const list = await radioList();
      const i = typeof which === "number" ? which : which ? list.findIndex((e) => (e.title + " " + e.file).toLowerCase().includes(String(which).toLowerCase())) : (Math.random() * list.length) | 0;
      if (i < 0 || !list[i]) return null;
      if (radio.playing) { const r = radio.onTrack; radio.onTrack = null; radioEnd(0.5); radio.onTrack = r; }
      clearTimeout(radio.timer);
      radioPlay(list[i], now() + 0.6).catch(() => radioEnd());
      return list[i].title;
    },
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
    // smoothed loudness of the music and of the whole room, 0..1 (the lighting breathes with it), and
    // `beat` > 0 on the frame a kick lands in the music (energy jumping well above its running average)
    levels() {
      const res = { music: 0, all: 0, beat: 0 };
      if (!ctx || ctx.state !== "running") return res;
      for (const [k, m] of Object.entries(meters)) {
        m.an.getFloatTimeDomainData(m.buf);
        let ss = 0;
        for (let i = 0; i < m.buf.length; i += 2) ss += m.buf[i] * m.buf[i];
        const e = ss / (m.buf.length / 2);
        if (k === "kick") {
          const t = now();
          if (radio.playing && e > m.avg * 1.8 && e > 1e-6 && t - m.last > 0.22) { res.beat = clamp(Math.sqrt(e / (m.avg + 1e-9)) / 3, 0.2, 1); m.last = t; }
          m.avg += (e - m.avg) * 0.04;
          continue;
        }
        const v = clamp((10 * Math.log10(e + 1e-10) + 48) / 36, 0, 1);    // -48..-12 dB → 0..1
        m.level += (v - m.level) * (v > m.level ? 0.35 : 0.06);
        res[k] = m.level;
      }
      return res;
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
      const m = noteOf(n.id, 4 - weight(n));
      if (!sample("glock", { midi: into(m, 79, 102), t, gain: 0.045, pan: pan * 0.8, dry: 0.7, rev: 0.35, del: 0.1, lp: 9000, dur: 0.6, fade: 0.25 }))
        glassTick(m, { t, gain: 0.032, pan: pan * 0.8 });
    },

    // deps: [{ n, refs, pan }] strongest first
    select(n, deps = [], pan = 0) {
      if (!ready() || !n) return;
      const t = now() + 0.01, m = noteOf(n.id, 3 - weight(n));
      duck("bed", -3, 0.03, 0.4, 1.5, t); duck("tonal", -2, 0.03, 0.4, 1.5, t);
      thump(t, 0.16 + 0.07 * weight(n));
      whoosh(t, 500, 2600, 0.38, 0.03, pan);
      if (sample("chime", { midi: into(m, 72, 90), t, gain: 0.2, pan, rev: 0.6, del: 0.3 })) {
        sample("nbell", { pick: hash(n.id), rate: Math.pow(2, ((m % 12) - 6) / 24), t: t + 0.02, gain: 0.05, pan: -pan * 0.5, hp: 500, rev: 0.7, dur: 2.5, fade: 1 });
        bell(m, { t, gain: 0.035, pan, decay: 2.2, index: 3, rev: 0.6, del: 0.3 });
      } else {
        bell(m, { t, gain: 0.1, pan, decay: 2.8, index: 4, rev: 0.6, del: 0.3 });
        bell(m + 7, { t: t + 0.045, gain: 0.028, pan: pan * 0.5, decay: 2.2, index: 2.5 });
        bell(m + 14, { t: t + 0.09, gain: 0.018, pan: -pan * 0.5, decay: 2, index: 2 });
      }
      setFocus(true);
      chip([m + 24, m + 31], { duty: 0.25, step: 0.03, hold: 0.02, decay: 0.1 }, { t: t + 0.02, gain: 0.02, pan, rev: 0.5, del: 0.35 }); // lock-on
      // the strands ring out: each dependency's string is plucked in turn (a real harp when we have one)
      deps.slice(0, 10).forEach((d, k) => harp(noteOf(d.n.id, 2 - weight(d.n)), {
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
      sample("chime", { midi: ROOT + 43, t: t + 0.05, gain: 0.06, rev: 0.7, del: 0.2 });
      setFocus(false);
    },

    // Dragging a bubble pulls on its wires: each of its strongest strands becomes a taut metal
    // string tuned to the module at the other end, and a bowed psaltery sings over them. Moving
    // bows them, stretching raises their pitch, and letting go twangs them back down to rest.
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
      const strs = list.map((w, k) => {
        let midi = noteOf(w.id, 0);
        while (mtof(midi) < 98) midi += 12;          // keep every wire between ~G2 and ~A3 so it can bend up a fifth
        const f = mtof(midi), dl = ctx.createDelay(0.05), damp = ctx.createBiquadFilter(), fb = ctx.createGain(), g = ctx.createGain();
        dl.delayTime.value = 1 / f;
        damp.type = "lowpass"; damp.frequency.value = 7500; damp.Q.value = -6;  // bright and metallic, never resonant
        fb.gain.value = 0.996;
        const send = ctx.createGain(); send.gain.value = 0.9 * Math.pow(0.8, k);
        exc.connect(send).connect(dl); dl.connect(damp).connect(fb).connect(dl);
        g.gain.value = (bank.loops.psaltery ? 0.45 : 0.7) * Math.pow(0.85, k); dl.connect(g).connect(bus);
        return { dl, fb, f, midi };
      });
      // the bowed psaltery: its loudness follows the hand, its pitch the stretch
      const bm = 74 + (noteOf(n.id, 0) - ROOT) % 12;
      const sing = sustain("psaltery", bm, { t, gain: 0, lp: 3200, group: "sfx", pan, attack: 0.1, dry: 0.6, rev: 0.7, del: 0.2 });
      glassTick(noteOf(n.id, 3 - weight(n)), { t, gain: 0.03, pan, rev: 0.4, del: 0.2 });  // the grab
      bow = { src, exc, bus, p, strings: strs, pan, stretch: 0, sing, bm };
    },
    // speed in px/s, stretch 0..1 (how far the bubble has been pulled)
    dragMove(speed, stretch = 0) {
      if (!bow) return;
      const t = now();
      bow.exc.gain.setTargetAtTime(Math.min(0.28, speed * 0.00028), t, 0.05);
      bow.stretch = clamp(stretch, 0, 1);
      const ratio = Math.pow(2, (bow.stretch * 7) / 12);                       // up to a fifth of tension
      for (const s of bow.strings) s.dl.delayTime.setTargetAtTime(1 / (s.f * ratio), t, 0.08);
      if (bow.sing) {
        bow.sing.amp.gain.setTargetAtTime(Math.min(0.32, 0.03 + speed * 0.0005), t, 0.12);
        bow.sing.glide(bow.bm + bow.stretch * 7, t, 0.25);
      }
    },
    dragEnd() {
      if (!bow) return;
      const b = bow; bow = null;
      const t = now(), ratio = Math.pow(2, (b.stretch * 7) / 12);
      b.exc.gain.setTargetAtTime(0, t, 0.08);
      if (b.sing) { b.sing.glide(b.bm, t, 0.4); b.sing.stop(t + 0.1, 1.2); }
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
      const t = now();
      if (sample("windchime", { pick: 1, t, rate: 1.25, gain: 0.08, hp: 2500, rev: 0.6, dur: 1.4, fade: 0.6, pan: -0.2 })) return;
      const src = noise(false, t), bp = ctx.createBiquadFilter(), g = ctx.createGain(), trem = ctx.createGain();
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
        [31, 35, 38].slice(0, Math.min(3, added)).forEach((iv, k) => {
          if (!sample("chime", { midi: into(ROOT + iv + 24, 72, 90), t: t + k * 0.09, gain: 0.1, pan: -0.3 + k * 0.3, rev: 0.7, del: 0.2 }))
            bell(ROOT + iv + 12, { t: t + k * 0.09, gain: 0.035, pan: -0.3 + k * 0.3, decay: 2.2 });
        });
        chip([ROOT + 43, ROOT + 48], { duty: 0.5, step: 0.07, hold: 0.06, decay: 0.3 }, { t: t + 0.05, gain: 0.02, rev: 0.4, del: 0.35, echo: 0.3 });
      }
      if (removed) {
        [19, 14, 12].slice(0, Math.min(3, removed)).forEach((iv, k) => harp(ROOT + iv, { t: t + 0.05 + k * 0.12, gain: 0.14, bright: 0.25 }));
        chip([ROOT + 31, ROOT + 26, ROOT + 19], { wave: "tri", step: 0.07, hold: 0.05, decay: 0.2 }, { t: t + 0.05, gain: 0.05, rev: 0.4, del: 0.3 });
      }
      if (changed && !added && !removed) {
        if (!sample("glock", { midi: ROOT + 55, t, gain: 0.05, dur: 1, fade: 0.4 })) glassTick(ROOT + 43, { t, gain: 0.03 });
        if (!sample("glock", { midi: ROOT + 59, t: t + 0.07, gain: 0.04, dur: 1, fade: 0.4 })) glassTick(ROOT + 47, { t: t + 0.07, gain: 0.025 });
      }
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

    // renders a scripted stretch of the room offline and reports levels (for tuning; not used live).
    // track: a playlist title / file (or index) to render through the far room.
    async renderTest(seconds = 16, { sfx: withSfx = true, music: withMusic = true, boot: withBoot = false, ambience = true, track = null, piano: onPiano = false, real = true, only = null } = {}) {
      if (bank.loading) await bank.loading;
      const sr = 48000, off = new OfflineAudioContext(2, sr * seconds, sr);
      const saved = { ctx, master, dry, revIn, delIn, echoIn, wave, white, pink, groups, meters, pad, strings, beds, started, enabled, sub, chordIx, upgraded, colorFilter, airGain, synthTide, windSrc };
      const savedRadio = { playing: radio.playing, onTrack: radio.onTrack };
      beds = []; upgraded = !real; radio.onTrack = null;
      build(off); started = true; enabled = true;
      master.gain.value = 0.9 * volume;
      if (ambience) {
        startAmbient(0.01);
        for (const g of ["bed", "tonal"]) groups[g].sends.forEach((s) => s.gain.setValueAtTime(GROUP_LEVELS[g], 0));
        for (const b of beds) { b.fader.gain.setValueAtTime(only && only !== b.name ? 0 : b.gain, 0); b.ensure(seconds); }
        for (let t = 0.5; t < seconds; t += 3) { strings.forEach((s) => gust(s, t)); pad.forEach((v) => breathe(v, t)); }
        crystal(2); crystal(9); deepBreath(4);
      }
      if (track !== null) {
        const list = await radioList();
        const i = typeof track === "number" ? track : list.findIndex((e) => (e.title + " " + e.file).toLowerCase().includes(String(track).toLowerCase()));
        await radioPlay(list[Math.max(0, i)], 0.5, { seconds: seconds - 1, prefill: true, piano: onPiano });
      } else if (withMusic) { piano(6.5); }
      if (withBoot) bootAt(0.3, null);
      if (withSfx) {
        // scripted events at fixed times (an offline context's clock doesn't run, so every time is explicit)
        glassTick(noteOf("gz/Win", 3), { t: 1, gain: 0.032 });
        sample("glock", { midi: into(noteOf("gz/Win", 4), 79, 102), t: 1.5, gain: 0.045, dur: 0.6, fade: 0.25 });
        const deps = ["rz/cRZString", "gz/cIGZUnknown", "sc4/Budget", "gz/StreamOps", "audio/HitMan", "rz/cRZFile", "sc4/Lot", "gz/GZCOM"];
        const t0 = 3, m = noteOf("sc4/Disaster", 2);
        thump(t0, 0.23); whoosh(t0, 500, 2600, 0.38, 0.03);
        if (!sample("chime", { midi: into(m, 72, 90), t: t0, gain: 0.2, rev: 0.6, del: 0.3 })) bell(m, { t: t0, gain: 0.1, decay: 2.8 });
        deps.forEach((id, k) => harp(noteOf(id, 2), { t: t0 + 0.15 + k * 0.075, gain: 0.2 * Math.pow(0.88, k), pan: (k % 2 ? 1 : -1) * 0.5 }));
        [0, 7, 12, 16, 19, 26].forEach((iv) => bell(ROOT + 36 + (iv % 12), { t: 8 + iv * 0.01, gain: 0.034, decay: 3.2 }));
        glassTick(ROOT + 43, { t: 12, gain: 0.028 }); glassTick(ROOT + 36, { t: 12.4, gain: 0.028 });
      }
      const buf = await off.startRendering();
      ({ ctx, master, dry, revIn, delIn, echoIn, wave, white, pink, groups, meters, pad, strings, beds, started, enabled, sub, chordIx, upgraded, colorFilter, airGain, synthTide, windSrc } = saved);
      Object.assign(radio, savedRadio);
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
