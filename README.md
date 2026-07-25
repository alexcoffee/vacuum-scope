# Terranova 934 Pressure Monitor

A dependency-free web app for plotting live pressure data from a Terranova Model 934 / 934-UHV vacuum gauge controller.

## Run

Web Serial requires a secure context. Serve the folder locally:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in Chrome or Edge.

## Connect

1. Connect the controller's RS-232 port through a USB-to-RS-232 adapter.
2. Click **Connect device** and select the adapter.
3. The app opens the port at 9600 baud, 8 data bits, no parity, and 1 stop bit.
4. It polls the `F`, `G`, and `H` pressure commands in sequence, no faster than the controller's documented limit.

The controller may be configured internally for 1200, 2400, 4800, or 9600 baud; this app currently uses the 9600 baud factory default.

## Protocol notes

The controller returns pressure as `xy × 10^z` Torr. For example, `23-6` means `23 × 10^-6`, or `2.3 × 10^-5` Torr. The app also recognizes:

- `0`: ion gauge is off
- `-900`: low-vacuum gauge is not connected
- `-999`: low-vacuum gauge has not been zeroed
- `999x`: invalid command response

Use the built-in demo mode to explore the interface without connected hardware. CSV export includes all readings retained in the one-hour in-browser buffer.

Reference: [Terranova 934 Instruction & Installation Manual](https://www.duniway.com/sites/default/files/images/_pg/Terranova934-Manual.pdf)
