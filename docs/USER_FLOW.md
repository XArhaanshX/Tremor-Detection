# User Flow

## 0. One-time setup (caregiver / you)
1. Build the band ([HARDWARE.md](HARDWARE.md)) and flash it: `pio run -d firmware -t upload`.
2. Open the dashboard in Chrome/Edge (laptop or Android) — GitHub Pages URL, or locally
   `python3 -m http.server -d dashboard 8000` → http://localhost:8000. iPhone: use the Bluefy browser.
3. Optional: "Install app" from the browser menu. After the first load it works with no internet.
4. Settings → set **hand size** (wrist to middle of the palm) and which wrist.

## 1. Morning — put it on
- Switch the band on, strap it on the more-affected wrist. LED blinks every 2 s = recording, waiting for a phone.
- Open the app → **Connect band** → pick `TremorBand-XXXX` in the browser's Bluetooth picker (first time only — later it reconnects by itself).
- On connect the app silently: sets the band's clock, sends the hand size, and downloads everything recorded since last time (top bar: "Syncing… N records" → "Synced 08:02").

## 2. All day — passive monitoring (no action needed)
- Every second the band runs the FFT and the **Live** tab shows: the 0–4 score with its word (Normal → Severe),
  shake rate (Hz), shake size (cm), beat strength, arm movement, and a 3-minute graph.
  Messages explain what it sees: "Steady 5.1 Hz shake, about 2 cm" / "Hand is moving — normal movement isn't counted" /
  "Possible tremor — checking that the beat is steady…".
- Every 30 s the band saves a summary record to its flash memory.
- **Walk away from the phone?** The pill turns amber "Out of range — reconnecting". The band keeps recording
  (up to ~11 days). When back in range the app reconnects and back-fills the gap automatically.

## 3. Taking medication
- Tap **💊 Took my dose** in the app, *or* press the button on the band (3 quick LED blinks = noted).
- Forgot? Day tab → "Forgot to log one?" → pick the time.

## 4. Active tests (a few times a day, e.g. just before a dose and an hour after)
Tests tab → pick a test → read the instructions → **I'm ready** → 3-2-1 → do it → results.
- **Finger tapping (10 s, on screen):** alternate L/R circles as fast as possible → taps/s, rhythm, slowing down, accuracy.
- **Hand turning (10 s, band):** palm up/down fast and wide → turns/s, rotation angle, speed, decrement, hesitations.
- **Rest tremor check (30 s, band):** hands in lap → % time with tremor, severity, Hz, cm.
- **Arms-out tremor check (30 s, band):** arms held out → same metrics.
Each result is saved with the band's passive reading at that moment (passive + active side by side) and plotted on the Trend chart.

## 5. Evening — review the day
**Day** tab: time monitored, % time with tremor, average and worst severity; a bar chart of the whole day
(10-minute bars, dashed lines = doses) and a table "How each dose worked": *started working after 39 min,
tremor came back after 3 h 01 m*. ‹ › to browse previous days.

## 6. Before the neurologist appointment
**Report** tab → last 7/14/30 days: hours monitored, % time with tremor, average severity, how long a dose lasts,
a "typical day" curve by hour, a day-by-day table, medication response ("tremor came back before the next dose
in 27 of 28 doses" = wearing-off), and test averages. **Print / save PDF** for the doctor, or export CSVs.

## 7. Night
Take the band off and charge it over USB-C (switch ON to charge). Records stay in flash until the app has them.

## Demo mode
"Try the demo" on the welcome card runs a simulated band with a week of history and a live patient whose
tremor returns ~2.5 h after the last dose — log a dose and watch it settle over the next 30 min.
