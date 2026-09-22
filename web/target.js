// Which kind of computer the dongle is typing into, and which kind of device
// is doing the controlling. The dongle sends key positions, so the same HID
// report means Win on Windows and Cmd on a Mac; only labels, key order and the
// Cmd/Ctrl swap depend on this.
//
//   choice    'auto' | 'win' | 'mac' | 'linux', saved on this device
//   detected  what the dongle guessed from USB enumeration: 'mac' | 'pc' | null
//   target()  the effective answer; Windows when nothing is known

const KEY = 'nib.target';
export const events = new EventTarget();

let choice = 'auto';
try { choice = localStorage.getItem(KEY) || 'auto'; } catch { /* private mode */ }
let detected = null;

export function getChoice() { return choice; }
export function getDetected() { return detected; }

export function target() {
  if (choice !== 'auto') return choice;
  if (detected === 'mac') return 'mac';
  return 'win';          // 'pc' means Windows or Linux; Windows is the common case
}

export function setChoice(c) {
  choice = ['win', 'mac', 'linux'].includes(c) ? c : 'auto';
  try { localStorage.setItem(KEY, choice); } catch { /* ignore */ }
  events.dispatchEvent(new Event('change'));
}

export function setDetected(d) {
  const next = d === 'mac' || d === 'pc' ? d : null;
  if (next === detected) return;
  detected = next;
  events.dispatchEvent(new Event('change'));
}

/** The controlling device: the one running this page. */
export function controller() {
  const p = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(p)) return 'mac';
  if (/win/.test(p)) return 'win';
  return 'other';
}

export const isApple = () => target() === 'mac';

/** Names for the two modifiers that differ between platforms. */
export function modLabel(bit) {
  const t = target();
  if (bit === 8) return t === 'mac' ? 'Cmd' : t === 'linux' ? 'Super' : 'Win';
  if (bit === 4) return t === 'mac' ? 'Opt' : 'Alt';
  if (bit === 1) return 'Ctrl';
  if (bit === 2) return 'Shift';
  return '';
}

// ---- modifier mapping in capture --------------------------------------------
// Three physical modifier families besides Shift: ctrl, alt (Option) and meta
// (Cmd, Win, Super). A mapping says which family each physical key is sent as.
//
//   position   by where the key sits beside the space bar. A Mac's Ctrl, Opt,
//              Cmd land on a PC's Ctrl, Win, Alt, and back. The default: the
//              fingers find what the other computer's labels say.
//   shortcuts  Cmd is sent as Ctrl (and Ctrl as Win/Cmd), so Cmd+C still
//              copies on Windows and Ctrl+C still copies on a Mac.
//   labels     every key is sent as what it is called; no translation.
//   custom     the user's own table.
// Same platform on both ends means no translation, whatever the choice.

const MAP_KEY = 'nib.modmap';
const CUSTOM_KEY = 'nib.modmap.custom';
const FAMILIES = ['ctrl', 'alt', 'meta'];
const PRESETS = {
  position:  { mac2pc: { ctrl: 'ctrl', alt: 'meta', meta: 'alt' },
               pc2mac: { ctrl: 'ctrl', meta: 'alt', alt: 'meta' } },
  shortcuts: { mac2pc: { ctrl: 'meta', alt: 'alt', meta: 'ctrl' },
               pc2mac: { ctrl: 'meta', alt: 'alt', meta: 'ctrl' } },
  labels:    { mac2pc: { ctrl: 'ctrl', alt: 'alt', meta: 'meta' },
               pc2mac: { ctrl: 'ctrl', alt: 'alt', meta: 'meta' } },
};

let mapChoice = 'position';
let custom = { ctrl: 'ctrl', alt: 'meta', meta: 'alt' };
try {
  mapChoice = localStorage.getItem(MAP_KEY) || 'position';
  const c = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null');
  if (c && FAMILIES.every((f) => FAMILIES.includes(c[f]))) custom = c;
} catch { /* private mode */ }

export const getMapChoice = () => mapChoice;
export const getCustomMap = () => ({ ...custom });

export function setMapChoice(c) {
  mapChoice = c in PRESETS || c === 'custom' ? c : 'position';
  try { localStorage.setItem(MAP_KEY, mapChoice); } catch { /* ignore */ }
  events.dispatchEvent(new Event('change'));
}

export function setCustomMap(m) {
  if (!FAMILIES.every((f) => FAMILIES.includes(m[f]))) return;
  custom = { ...m };
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom)); } catch { /* ignore */ }
  events.dispatchEvent(new Event('change'));
}

/** True when the two ends are different platforms, so a mapping applies. */
export function crossPlatform() {
  const c = controller(), t = target();
  return c !== 'other' && (c === 'mac') !== (t === 'mac');
}

/** family -> family, for the current controller, target and choice. */
export function familyMap() {
  if (!crossPlatform()) return { ctrl: 'ctrl', alt: 'alt', meta: 'meta' };
  if (mapChoice === 'custom') return { ...custom };
  const dir = controller() === 'mac' ? 'mac2pc' : 'pc2mac';
  return { ...(PRESETS[mapChoice] || PRESETS.position)[dir] };
}

const CODES = { ctrl: 'Control', alt: 'Alt', meta: 'Meta' };
/** KeyboardEvent.code -> the code to send instead, for capture. */
export function modMap() {
  const fm = familyMap();
  const out = {};
  for (const f of FAMILIES) {
    for (const side of ['Left', 'Right']) out[CODES[f] + side] = CODES[fm[f]] + side;
  }
  return out;
}

/** Names on each end, for showing a translation: ctrl/alt/meta -> label. */
export function familyName(family, platform) {
  if (family === 'ctrl') return platform === 'mac' ? '⌃ Ctrl' : 'Ctrl';
  if (family === 'alt') return platform === 'mac' ? '⌥ Opt' : 'Alt';
  return platform === 'mac' ? '⌘ Cmd' : platform === 'linux' ? 'Super' : 'Win';
}
