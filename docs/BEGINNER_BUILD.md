# First-Time Build Guide (never done hardware before)

This builds the **desk prototype**: ESP32-S dev board + MPU-6050 sensor, powered by
your laptop's USB cable. Once this works, the wearable version (XIAO + LiPo) is the
same thing in a smaller package.

Take your time. Nothing here is dangerous **as long as the USB cable is unplugged
whenever you connect or move wires.**

---

## Step 1 — Identify the parts

Take everything out and lay it on a table. Match each item:

| Part | What it looks like |
|---|---|
| **ESP32 board** (the "brain") | Rectangle about 5 × 2.5 cm, usually black. A shiny **silver metal square** on it says `ESP32-WROOM-32` or `ESP-32S`. A **USB port** on one short end. Two tiny push buttons labelled **EN** and **BOOT** (or RST/IO0). Two long rows of **metal pins sticking out underneath**, each with a tiny printed label like `3V3`, `GND`, `D21`, `G22`. |
| **MPU-6050 sensor (GY-521)** | Small **blue or purple square**, about 2 × 1.6 cm. A tiny black square chip in the middle. Printed `GY-521`. Along one edge, **8 small holes** labelled `VCC GND SCL SDA XDA XCL AD0 INT`. Usually comes with a **loose strip of 8 metal pins** in the same bag. |
| **Jumper wires** | Coloured wires with plastic ends. An end with a **metal pin** is "male"; an end with a **hole/socket** is "female". |
| **USB cable** | Fits the ESP32's port (micro-USB or USB-C) on one end, your laptop on the other. |
| **Breadboard** (if you have one) | White plastic block covered in small holes. |
| **9V battery** | The rectangular battery with two snaps on top. **Not needed — put it aside** (see step 9). |
| **XIAO ESP32-S3 / flat silver LiPo battery** (if you have them) | Tiny board with USB-C; flat silver pouch with red & black wires. **Put aside** — that's for the wearable version later. |

> **Unsure about anything?** Take a photo, save it in the project folder
> (e.g. `parts.jpg`), and tell Claude the filename — it can look at it and tell you what's what.

**Check what wire ends you have:**
- **Female–female** wires (holes on both ends) → easiest; no breadboard needed.
- Only **male–male** (pins on both ends) → you'll need the breadboard (step 5B).
- **Male–female** → also fine with a breadboard.

---

## Step 2 — Set up the laptop (one time, ~10 min)

Open a terminal and run these one at a time:

```bash
# 1. Install PlatformIO (the tool that puts code onto the ESP32)
uv tool install platformio

# 2. Allow your user to talk to USB serial devices (Arch/CachyOS group is "uucp")
sudo usermod -aG uucp $USER

# 3. Turn on the laptop's Bluetooth service
sudo systemctl enable --now bluetooth
```

**Log out and log back in** (or reboot) so step 2 takes effect.

Then enable Bluetooth in Chrome: open `chrome://flags/#enable-experimental-web-platform-features`,
set it to **Enabled**, click **Relaunch**.

---

## Step 3 — First test: the board alone (no wiring yet)

This proves the board, cable and laptop all work before you touch any wires.

1. Plug the ESP32 into the laptop with the USB cable. A small red/blue light should come on.
2. Check the laptop sees it:
   ```bash
   ls /dev/ttyUSB* /dev/ttyACM*
   ```
   You should see something like `/dev/ttyUSB0`.
   **Nothing shows up?** The cable is probably "charge-only". Try a different USB cable (the one from a phone usually works).
3. Put the **simulator** firmware on it (it fakes a patient, so no sensor is needed yet):
   ```bash
   cd "/home/arhaansh/Projects/tremor detection/firmware"
   pio run -e esp32dev_sim -t upload
   ```
   The first run downloads tools (a few minutes). It ends with `SUCCESS`.
   **Stuck at `Connecting........_____`?** Press and **hold the BOOT button** on the board until uploading starts, then let go.
4. Watch the board's log:
   ```bash
   pio device monitor -b 115200
   ```
   Press the **EN** button once to restart it. You should see:
   ```
   [boot] tremor band fw 1, boot #1, lever 100 mm, SIMULATED IMU
   [ble] advertising as TremorBand-XXXX
   ```
   Press `Ctrl+C` to exit the log.
5. Open the dashboard at **http://localhost:8000** (start it with
   `python3 -m http.server 8000 -d dashboard` from the project folder if it isn't running) →
   **Connect band** → pick **TremorBand-XXXX** → **Pair/Connect**.
   The Live tab should start updating every second. 🎉

If this works, the hard part (software) is proven. Now the sensor.

---

## Step 4 — Attach pins to the sensor (soldering)

The sensor's 8 holes need the metal pin strip fixed into them so wires can connect.
This is done by **soldering** (melting a little metal to join them).

**If your GY-521 already has pins attached → skip to step 5.**

You need: a soldering iron, solder wire (thin, "rosin core"), and ideally a breadboard to hold things steady.
**No soldering iron?** Options: a cheap starter kit (~$15–20), a friend, a school lab/makerspace,
or buy a GY-521 that comes **pre-soldered**.

How to solder the pins (about 10 minutes):
1. Push the **long** ends of the pin strip into a breadboard so the strip stands upright.
   (No breadboard: use a lump of Blu-Tack to hold it.)
2. Lay the GY-521 over the short ends, **chip side facing up**, so each pin pokes through one hole.
3. Heat the iron to about 330–350 °C and wait a minute. **The tip is extremely hot — never touch the metal part, and rest it in its stand.**
4. For each pin: touch the iron tip so it touches **both the pin and the copper ring** around the hole. Count to 2.
   Then touch the solder wire to the **joint (not the iron)** — a small amount melts and flows around the pin. Remove the solder, then the iron.
5. A good joint looks like a small **shiny cone** hugging the pin. Make sure no solder joins two neighbouring pins together.
   If two pins are joined, reheat and drag the iron between them.
6. Do all 8 pins. Let it cool for a minute. Wash your hands (solder may contain lead).

---

## Step 5 — Connect the sensor to the board (4 wires)

### ⚠️ Unplug the USB cable first.

You're making these 4 connections. Use these colours if you can, so it's easy to check:

| Wire colour | ESP32 board pin (look for this label) | GY-521 pin |
|---|---|---|
| 🔴 Red | **3V3** (sometimes `3.3V`) — *not* `5V` or `VIN` | **VCC** |
| ⚫ Black | **GND** (any of them) | **GND** |
| 🟡 Yellow | **D21** (or `G21`, `21`, `GPIO21`) | **SDA** |
| 🟢 Green | **D22** (or `G22`, `22`, `GPIO22`) | **SCL** |

Leave the GY-521's other 4 pins (XDA, XCL, AD0, INT) **empty**.

The labels on the ESP32 can be tiny — use your phone camera's zoom. Some boards print them on the **underside**.

### 5A — With female–female wires (no breadboard)
Push one end of each wire onto the ESP32 pin and the other end onto the GY-521 pin, as in the table. Done.

### 5B — With male wires and a breadboard
How a breadboard works: in each **short row of 5 holes**, the holes are connected to each other inside.
The gap down the middle separates the two halves.
1. Push the GY-521 (by its pins) into the breadboard so each of its 8 pins is in a **different row**.
2. For each connection, put one end of the wire in the **same row** as the GY-521 pin, and the other end
   onto the ESP32 pin (male–female wire) — or put the ESP32 in the breadboard too, and connect row to row.

### Double-check before plugging in
Trace every wire with your finger: red goes 3V3→VCC, black GND→GND, yellow 21→SDA, green 22→SCL.
**The one mistake that can damage things is mixing up power and ground (red/black).**

---

## Step 6 — Put the real firmware on

1. Plug the USB cable back in. A small light on the GY-521 should turn on too.
2. Upload:
   ```bash
   cd "/home/arhaansh/Projects/tremor detection/firmware"
   pio run -e esp32dev -t upload
   pio device monitor -b 115200
   ```
3. Press **EN**. You want to see:
   ```
   [imu] MPU-6050 WHO_AM_I=0x68 OK
   ```
   - `WARNING: WHO_AM_I=0x70 (clone)` → also fine, it's a compatible copy of the chip.
   - `MPU-6050 NOT FOUND` → unplug USB and check: are SDA/SCL swapped? Is each wire pushed all the way on?
     Are the solder joints shiny and not touching each other? Is the GY-521 light on (if not, check red/black)?

---

## Step 7 — Test that it detects tremor

Keep the log open (`pio device monitor`) and the dashboard Live tab open side by side.

1. **Still test:** leave the sensor flat on the table for 10 s → severity **0**, "Hand is steady".
2. **Fake tremor:** tape the **sensor** (not the ESP32 board) firmly to the back of your wrist with
   tape — it must not wobble. Rest your forearm on the table and **shake your wrist quickly, about
   5 times per second** (like a fast "no-no" wag), for 5 seconds.
   Within ~3 s the log shows `[tremor] sev 2  5.1 Hz ...` and the Live tab jumps to 1–3.
3. **Normal movement:** wave slowly, pretend to pick up a cup → severity stays **0**.
4. **Out-of-range test:** in the dashboard click **Disconnect**, wait 2 minutes, reconnect →
   the top bar says "Syncing…" and the Day tab fills in the gap.
5. Try the **Tests** tab: hand turning, rest tremor check.
6. Press the board's **BOOT** button once (not while uploading) → the light blinks 3 times = "dose logged";
   it appears in the Day tab after the next sync.

---

## Step 8 — Moving around without the laptop

**Easiest and safest:** plug the board into a **USB power bank** (phone battery pack) with the
same cable. The firmware is already on the board; it starts by itself. Connect from the dashboard as usual.

---

## Step 9 — About the 9V battery

Not recommended — it's heavy, not rechargeable, and wiring it to the wrong pin can damage the
board's USB chip. Use a USB power bank for now, and a LiPo with the XIAO for the real wristband.

---

## Step 10 — Next: the wearable version

When the prototype works, the wristband version uses the **XIAO ESP32-S3** + **LiPo** + switch
(see [HARDWARE.md](HARDWARE.md)). It needs soldering wires to the battery pads, which is more delicate,
so do it with someone experienced or ask Claude for a separate walkthrough with photos of your parts.

## Quick troubleshooting

| Problem | Fix |
|---|---|
| `ls /dev/ttyUSB*` shows nothing | Different USB cable (data, not charge-only); try another USB port |
| `Permission denied: /dev/ttyUSB0` | You didn't log out/in after `usermod`, or reboot |
| Upload stuck at `Connecting...` | Hold **BOOT** while it connects |
| Dashboard can't find the band | Chrome flag enabled? Laptop Bluetooth on (`bluetoothctl power on`)? Press **EN** to restart the board and try again |
| `MPU-6050 NOT FOUND` | Check wiring table, swap SDA/SCL, re-check solder joints |
| Severity jumps around when still | Sensor isn't fixed firmly — tape it down |
