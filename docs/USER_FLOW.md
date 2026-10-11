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

## 3. Taking medication — and the wearing-off warning
- Tap **I took my medicine** in the app (it asks to confirm), *or* press the button on the band (3 quick LED blinks = noted).
  Either way the band knows the dose time.
- Forgot? Day tab → "Forgot to log one?" → pick the time.
- After about 4 doses with the band on, the app has learned how long a dose usually lasts *for this patient*
  (separately for morning, midday, afternoon and evening doses once there's enough data).
- The **Medicine** card on the Live tab then shows the dose cycle — starting to work → working → may wear off →
  usually worn off — with a marker for now, and the reminder time.
- **Warning:** about 20 min before tremor usually comes back, or as soon as the band sees tremor return earlier
  than usual, the band double-blinks its light (and buzzes, if a motor is fitted) and the app shows a calm banner:
  *"Your medicine usually starts wearing off about now — check your medication plan"*. **OK** dismisses it;
  **I took my medicine** logs the dose. Settings → *Also show notifications* adds a system notification.
  The app never tells the patient to take medicine — it points them to their plan.

## 4. Active tests (prompted around each dose)
About **1 hour after a dose** ("is it working?") and **just before it usually wears off**, the Live tab offers a
quick check-in with buttons for a 10–30 s test (or *Not now*). Any test can also be run from the Tests tab →
pick a test → read the instructions → **I'm ready** → 3-2-1 → do it → results.

| Test | Where | What the patient does | What it measures |
|---|---|---|---|
| Finger tapping | screen | alternate two circles as fast as possible, 10 s | taps/s, rhythm, slowing down, accuracy |
| Tapping, each hand | screen | one circle, right hand 10 s then left hand 10 s | taps/s per hand, left–right difference |
| Spiral drawing | screen | trace a spiral outward with a finger | wobble in the line (and its Hz), distance from the line |
| Follow the dot | screen | keep a finger on a slowly moving dot, 20 s | % time on the dot, how far behind |
| Reaction time | screen | tap when the panel changes colour, 10 rounds | median reaction time, variability, too-early taps |
| Hand turning | band | palm up/down fast and wide, 10 s | turns/s, rotation angle, speed, decrement, hesitations |
| Rest tremor check | band | hands relaxed in lap, 30 s | % time with tremor, severity, Hz, cm |
| Arms-out tremor check | band | arms held out, 30 s | same |

Each result is saved with the band's passive reading at that moment **and the minutes since the last dose**,
and is plotted on the Trend chart. Tapping outside the test window doesn't cancel a test that's running.

## 5. Evening — review the day
**Day** tab: time monitored, tremor-free time (and %), average and worst severity; a bar chart of the whole day
(10-minute bars, dashed lines = doses) and a table "How each dose worked": *started working after 39 min,
tremor came back after 3 h 01 m*. ‹ › to browse previous days.

## 6. Before the neurologist appointment
**Report** tab → last 7/14/30 days: hours monitored, tremor-free hours per day (with a chart), average severity,
how long a dose typically lasts, a "typical day" curve by hour, a day-by-day table, medication response
("tremor came back before the next dose in 27 of 28 doses" = wearing-off), the learned dose timing for each time
of day, **how well the warning would have worked** on past doses (vs a fixed 3-hour rule), test averages, and
test scores by time since the dose. **Print / save PDF** for the doctor, or export CSVs.

## 7. Night
Take the band off and charge it over USB-C (switch ON to charge). Records stay in flash until the app has them.

## Demo mode
"Try the demo" on the welcome card runs a simulated band with a week of history and a live patient whose
tremor returns ~3 h after the last dose — log a dose and watch it settle over the next 30 min. The demo band
runs the same wearing-off rules as the real firmware, so the reminder and the Medicine card work too.
