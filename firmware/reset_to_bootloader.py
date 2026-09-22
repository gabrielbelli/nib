# Once N.I.B.'s own firmware is running, the USB port is a TinyUSB CDC device
# that esptool cannot reset on its own, so uploads fail with "No serial data
# received" until someone holds BOOT. Opening the port at 1200 baud with DTR
# low asks the running firmware to jump to the bootloader.
#
# The dongle exposes more than one /dev/cu.usbmodem* node, and only one of them
# is the CDC console, so guessing by name does not work. Instead: touch every
# candidate, then wait for the port list to change and upload to whatever is
# new, which is the ROM bootloader.
Import("env")

import glob
import time

PATTERNS = ("/dev/cu.usbmodem*", "/dev/ttyACM*")


def ports():
    found = []
    for pattern in PATTERNS:
        found.extend(glob.glob(pattern))
    return set(found)


def touch(port):
    # The firmware only jumps to the bootloader when the line coding *changes*
    # to 1200 baud. A second touch at 1200 is therefore silently ignored, so
    # set a different rate first to guarantee the change is seen.
    try:
        import serial
    except ImportError:
        return False
    try:
        for baud in (115200, 1200):
            s = serial.Serial()
            s.port = port
            s.baudrate = baud
            s.dtr = False
            s.rts = False
            s.open()
            time.sleep(0.2)
            s.close()
            time.sleep(0.1)
        return True
    except Exception:
        return False


def wait_openable(port, timeout=8):
    try:
        import serial
    except ImportError:
        time.sleep(1.5)
        return True
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = serial.Serial(port)
            s.close()
            time.sleep(0.3)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def before_upload(source, target, env):
    before = ports()
    if not before:
        print("[nib] no serial ports found, plug the dongle in")
        return

    # An explicit --upload-port (or upload_port) names the one board to touch.
    # Without this, every attached board was reset, and with two plugged in
    # the wrong one could be flashed.
    explicit = env.subst("$UPLOAD_PORT").strip()
    if explicit:
        if explicit not in before:
            print(f"[nib] {explicit} is not attached")
            return
        touch(explicit)
        deadline = time.time() + 8
        while time.time() < deadline:
            time.sleep(0.25)
            fresh = ports() - before
            if fresh:
                port = sorted(fresh)[0]
                wait_openable(port)
                env.Replace(UPLOAD_PORT=port)
                print(f"[nib] bootloader came up on {port}")
                return
        # USB-Serial-JTAG boards (and boards already in the bootloader) keep
        # their port; esptool resets them itself.
        print(f"[nib] flashing {explicit} directly")
        return

    for port in sorted(before):
        touch(port)

    # The ROM bootloader enumerates as a brand new port. Wait for it rather
    # than sleeping a fixed amount, because enumeration time varies.
    deadline = time.time() + 8
    while time.time() < deadline:
        time.sleep(0.25)
        now = ports()
        fresh = now - before
        if fresh:
            port = sorted(fresh)[0]
            # macOS publishes the device node slightly before it can be
            # opened, so wait until it actually accepts a connection.
            if not wait_openable(port):
                print(f"[nib] {port} never became usable")
            env.Replace(UPLOAD_PORT=port)
            print(f"[nib] bootloader came up on {port}")
            return

    # No new port: the dongle may already be sitting in the bootloader.
    remaining = sorted(ports())
    if remaining:
        env.Replace(UPLOAD_PORT=remaining[-1])
        print(f"[nib] no new port appeared, trying {remaining[-1]}")


env.AddPreAction("upload", before_upload)
