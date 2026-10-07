// Active tests. Finger tapping runs on the screen; the other three are measured
// by the wristband (its gyroscope / tremor pipeline) and only displayed here.
import { TEST, TEST_STATE } from './protocol.js';

export const TESTS = [
  {
    id: 'tapping', name: 'Finger tapping', where: 'screen', seconds: 10,
    blurb: 'Speed & rhythm of finger movement (slowness)',
    steps: [
      'Put the phone/laptop on a table.',
      'Use the index finger of the hand wearing the band.',
      'Tap the two circles one after the other — left, right, left, right — as fast as you can.',
      'Keep going for 10 seconds.',
    ],
  },
  {
    id: 'pronsup', name: 'Hand turning', where: 'band', type: TEST.PRONSUP, seconds: 10,
    blurb: 'Palm up / palm down as fast and wide as possible',
    steps: [
      'Sit, hold the arm with the band out in front of you, elbow bent.',
      'Turn your hand palm-up, then palm-down, as fast and as fully as you can.',
      'Keep going for 10 seconds. The band measures every turn.',
    ],
  },
  {
    id: 'rest', name: 'Rest tremor check', where: 'band', type: TEST.REST, seconds: 30,
    blurb: '30 s with the hand relaxed in your lap',
    steps: [
      'Sit comfortably with both hands resting in your lap.',
      'Let the hands relax completely. Don\'t try to stop any shaking.',
      'Stay like this for 30 seconds.',
    ],
  },
  {
    id: 'postural', name: 'Arms-out tremor check', where: 'band', type: TEST.POSTURAL, seconds: 30,
    blurb: '30 s with arms held straight out',
    steps: [
      'Stretch both arms straight out in front of you, palms down.',
      'Spread your fingers slightly and hold the position.',
      'Stay like this for 30 seconds.',
    ],
  },
];

export const byId = (id) => TESTS.find((t) => t.id === id);

// Headline number for each test (used in history + trends).
export function headline(kind, r) {
  switch (kind) {
    case 'tapping': return { value: r.rate, unit: 'taps/s', text: `${r.rate.toFixed(1)} taps/s` };
    case 'pronsup': return { value: r.rateHz, unit: 'turns/s', text: r.tooFew ? 'too few turns' : `${r.rateHz.toFixed(2)} turns/s` };
    default: return { value: r.sevMean, unit: 'severity', text: `${r.tremorPct}% tremor · severity ${r.sevMax}` };
  }
}

export function detailRows(kind, r) {
  switch (kind) {
    case 'tapping': return [
      ['Correct taps', r.taps], ['Speed', `${r.rate.toFixed(1)} taps/s`],
      ['Rhythm variability', `${r.cvPct.toFixed(0)}%`, 'lower = more regular'],
      ['Slowing down (2nd half vs 1st)', `${r.fatiguePct.toFixed(0)}%`, 'positive = got slower'],
      ['Accuracy', `${r.accuracyPct.toFixed(0)}%`], ['Longest pause', `${r.longestPauseMs} ms`],
      ['Same-side repeats', r.alternationErrors],
    ];
    case 'pronsup': return [
      ['Half-turns', r.movements], ['Speed', `${r.rateHz.toFixed(2)} turns/s`],
      ['Rotation per turn', `${r.excursionDeg.toFixed(0)}°`], ['Peak turning speed', `${r.speedDps}°/s`],
      ['Getting smaller (decrement)', `${r.ampDecrementPct}%`, 'positive = turns shrank'],
      ['Getting slower', `${r.speedDecrementPct}%`], ['Rhythm variability', `${r.rhythmCvPct}%`],
      ['Hesitations', r.hesitations],
      ...(r.saturated ? [['Note', 'Sensor hit its limit — very fast turning']] : []),
    ];
    default: return [
      ['Time with tremor', `${r.tremorPct}%`], ['Severity (max)', r.sevMax], ['Severity (average)', r.sevMean.toFixed(1)],
      ['Frequency', r.freqHz ? `${r.freqHz.toFixed(1)} Hz` : '—'],
      ['Tremor size (avg / max)', r.ampMeanCm ? `${r.ampMeanCm.toFixed(1)} / ${r.ampMaxCm.toFixed(1)} cm` : '—'],
    ];
  }
}

// ---- finger tapping, measured on the screen ----
export function tappingMetrics(events, seconds) {
  const hits = events.filter((e) => e.target);
  const iti = [];
  let errors = 0;
  for (let i = 1; i < hits.length; i++) {
    iti.push(hits[i].t - hits[i - 1].t);
    if (hits[i].target === hits[i - 1].target) errors++;
  }
  const mean = iti.length ? iti.reduce((a, b) => a + b, 0) / iti.length : 0;
  const sd = iti.length ? Math.sqrt(iti.reduce((a, b) => a + (b - mean) ** 2, 0) / iti.length) : 0;
  const halfT = (seconds * 1000) / 2;
  const first = hits.filter((h) => h.t < halfT).length;
  const second = hits.length - first;
  return {
    taps: hits.length,
    rate: hits.length / seconds,
    cvPct: mean ? (100 * sd) / mean : 0,
    fatiguePct: first ? (100 * (first - second)) / first : 0,
    accuracyPct: events.length ? (100 * hits.length) / events.length : 0,
    longestPauseMs: Math.round(Math.max(0, ...iti)),
    alternationErrors: errors,
  };
}

// Runs one test inside the modal. band may be null for the tapping test.
export class TestRunner {
  constructor(modal, { getBand, onSaved, getContext }) {
    this.modal = modal;
    this.getBand = getBand;
    this.onSaved = onSaved;
    this.getContext = getContext;
  }

  open(id) {
    this.def = byId(id);
    this.cleanup?.();
    const d = this.def;
    this.render(`
      <h2>${d.name}</h2>
      <p class="muted">${d.where === 'band' ? 'Measured by the wristband' : 'Measured on this screen'} · ${d.seconds} seconds</p>
      <ol class="steps">${d.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <div class="modal-actions">
        <button class="btn" data-act="close">Cancel</button>
        <button class="btn primary" data-act="start">I'm ready — start</button>
      </div>`);
    this.modal.hidden = false;
    this.modal.querySelector('[data-act=start]').focus();
  }

  render(html) {
    const box = this.modal.querySelector('.modal-box');
    box.innerHTML = html;
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.action(b.dataset.act)));
  }

  action(act) {
    if (act === 'close') this.close();
    if (act === 'start') this.countdown();
    if (act === 'again') this.open(this.def.id);
  }

  close() {
    if (this.running && this.def.where === 'band') this.getBand()?.abortTest();
    this.running = false;
    this.cleanup?.();
    this.modal.hidden = true;
  }

  async countdown() {
    for (const n of [3, 2, 1]) {
      this.render(`<div class="countdown" aria-live="assertive">${n}</div><p class="muted center">${this.def.name}</p>`);
      await new Promise((r) => setTimeout(r, 800));
      if (this.modal.hidden) return;
    }
    this.def.where === 'band' ? this.runBand() : this.runTapping();
  }

  progressHtml(label) {
    return `<div class="progress"><div class="progress-bar" style="width:0%"></div></div>
      <p class="center big-timer" aria-live="polite">${label}</p>`;
  }

  setProgress(elapsed, total) {
    const bar = this.modal.querySelector('.progress-bar');
    const lab = this.modal.querySelector('.big-timer');
    if (bar) bar.style.width = `${Math.min(100, (100 * elapsed) / total)}%`;
    if (lab) lab.textContent = `${Math.max(0, Math.ceil(total - elapsed))} s`;
  }

  runTapping() {
    const d = this.def;
    this.render(`${this.progressHtml(`${d.seconds} s`)}
      <div class="tap-area" id="tapArea">
        <button class="tap-target" data-target="L" aria-label="Left target">L</button>
        <button class="tap-target" data-target="R" aria-label="Right target">R</button>
      </div>
      <p class="center"><span id="tapCount">0</span> taps · <span class="muted">the timer starts with your first tap</span></p>`);
    const area = this.modal.querySelector('#tapArea');
    const events = [];
    let start = null;
    const onDown = (e) => {
      e.preventDefault();
      const now = performance.now();
      if (start == null) start = now;  // the clock starts on the first tap
      const target = e.target.closest('[data-target]')?.dataset.target || null;
      events.push({ t: now - start, target });
      if (target) e.target.closest('[data-target]').classList.add('hit');
      setTimeout(() => area.querySelectorAll('.hit').forEach((b) => b.classList.remove('hit')), 80);
      this.modal.querySelector('#tapCount').textContent = events.filter((x) => x.target).length;
    };
    area.addEventListener('pointerdown', onDown);
    this.running = true;
    const tick = setInterval(() => {
      if (start == null) return;
      const el = (performance.now() - start) / 1000;
      this.setProgress(el, d.seconds);
      if (el >= d.seconds) {
        clearInterval(tick);
        area.removeEventListener('pointerdown', onDown);
        this.running = false;
        this.finish(tappingMetrics(events.filter((e) => e.t <= d.seconds * 1000), d.seconds));
      }
    }, 100);
    this.cleanup = () => clearInterval(tick);
  }

  runBand() {
    const band = this.getBand();
    const d = this.def;
    if (!band || band.state !== 'connected') {
      this.render(`<h2>Band not connected</h2><p>Connect the wristband (or start the demo) first.</p>
        <div class="modal-actions"><button class="btn" data-act="close">Close</button></div>`);
      return;
    }
    this.render(`<h2>${d.name}</h2>${this.progressHtml(`${d.seconds} s`)}
      <p class="center muted">${d.steps[d.steps.length - 2]}</p>
      <div class="modal-actions"><button class="btn" data-act="close">Stop</button></div>`);
    this.running = true;
    const onTest = (e) => {
      const r = e.detail;
      if (r.type !== d.type) return;
      if (r.state === TEST_STATE.RUNNING) this.setProgress(r.elapsedS, r.totalS);
      else {
        band.removeEventListener('test', onTest);
        this.running = false;
        if (r.state === TEST_STATE.DONE) this.finish(r);
        else this.render(`<h2>Test stopped</h2><p>The test didn't finish${r.state === TEST_STATE.ERROR ? ' (band reported an error)' : ''}.</p>
          <div class="modal-actions"><button class="btn" data-act="close">Close</button><button class="btn primary" data-act="again">Try again</button></div>`);
      }
    };
    band.addEventListener('test', onTest);
    this.cleanup = () => band.removeEventListener('test', onTest);
    band.startTest(d.type, d.seconds);
  }

  async finish(result) {
    const d = this.def;
    const saved = await this.onSaved({ t: Date.now(), kind: d.id, result, context: this.getContext() });
    const h = headline(d.id, result);
    this.render(`<h2>${d.name} — done</h2>
      <p class="result-headline">${h.text}</p>
      <table class="kv">${detailRows(d.id, result).map(([k, v, hint]) =>
        `<tr><th>${k}${hint ? `<small>${hint}</small>` : ''}</th><td>${v}</td></tr>`).join('')}</table>
      ${saved?.context?.severity != null ? `<p class="muted">Passive reading at the time: severity ${saved.context.severity}.</p>` : ''}
      <div class="modal-actions"><button class="btn" data-act="again">Do it again</button><button class="btn primary" data-act="close">Done</button></div>`);
  }
}
