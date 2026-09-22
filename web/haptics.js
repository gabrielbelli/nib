// One haptic tap, on every phone that can give one.
//
// Android: the Vibration API. iOS never shipped it, in Safari or in any
// WKWebView browser such as Bluefy, so navigator.vibrate is absent there.
// iOS 18 and later do play the system haptic when a switch-style checkbox
// (<input type="checkbox" switch>) is toggled through its label, and that
// works from script inside a user gesture. So on iOS a hidden switch is
// flipped instead. Older iOS has neither and stays silent.

let iosSwitch = null;

function ensureSwitch() {
  if (iosSwitch) return iosSwitch;
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.append(input);
  document.body.append(label);
  iosSwitch = label;
  return label;
}

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

/** A short tap. Call it from inside a pointer, touch or click handler. */
export function tap(ms = 8) {
  try {
    if (canVibrate) { navigator.vibrate(ms); return; }
    ensureSwitch().click();
  } catch { /* no haptics on this device */ }
}

export default tap;
