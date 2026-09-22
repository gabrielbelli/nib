#!/bin/sh
# Builds the host renderer from the firmware's own display and saver sources.
set -e
cd "$(dirname "$0")"
GFX="../../firmware/.pio/libdeps/pocket-dongle-s3/Adafruit GFX Library"
clang++ -std=c++17 -O1 -w -DNIB_LCDSIM -DARDUINO=100 \
  -Ishim -I"$GFX" -I../../firmware/src \
  sim.cpp ../../firmware/src/display.cpp ../../firmware/src/screensaver.cpp "$GFX/Adafruit_GFX.cpp" \
  -o lcdsim
