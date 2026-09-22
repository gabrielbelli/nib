// text -> USB HID usage codes.
//
// A HID keyboard sends physical key positions, not characters; the host OS
// applies the layout. So the table used here must match the layout selected on
// the computer receiving the keystrokes.
//
// Every character maps to a LIST of key presses, because ABNT2 reaches several
// characters through dead keys: a literal ~ is the tilde key followed by space,
// and an accented letter is the accent key followed by the letter.

export const MOD = { CTRL: 1, SHIFT: 2, ALT: 4, GUI: 8 };
const S = MOD.SHIFT;
const ALTGR = MOD.ALT | MOD.CTRL;   // macOS: right-alt behaves as AltGr

// Named keys, usable from buttons and shortcuts.
export const KEY = {
  ENTER: 0x28, ESC: 0x29, BACKSPACE: 0x2a, TAB: 0x2b, SPACE: 0x2c,
  CAPSLOCK: 0x39,
  F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,
  INSERT: 0x49, HOME: 0x4a, PAGEUP: 0x4b, DELETE: 0x4c, END: 0x4d, PAGEDOWN: 0x4e,
  RIGHT: 0x4f, LEFT: 0x50, DOWN: 0x51, UP: 0x52,
  PRINTSCREEN: 0x46, SCROLLLOCK: 0x47, PAUSE: 0x48, NUMLOCK: 0x53,
  MENU: 0x65,            // the context-menu key beside right Ctrl
  F13: 0x68, F14: 0x69, F15: 0x6a, F16: 0x6b, F17: 0x6c, F18: 0x6d,
  F19: 0x6e, F20: 0x6f, F21: 0x70, F22: 0x71, F23: 0x72, F24: 0x73,
  // ISO and Brazilian extras, absent from a US keyboard.
  ISO_BACKSLASH: 0x64,   // the key between left shift and Z
  INTL_RO: 0x87,         // the ABNT2 key between ? and right shift
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function letters(table) {
  for (let i = 0; i < 26; i++) {
    const usage = 0x04 + i;
    table.set(LETTERS[i], [[0, usage]]);
    table.set(LETTERS[i].toUpperCase(), [[S, usage]]);
  }
}

function digits(table) {
  '123456789'.split('').forEach((d, i) => table.set(d, [[0, 0x1e + i]]));
  table.set('0', [[0, 0x27]]);
}

function common(table) {
  table.set(' ', [[0, KEY.SPACE]]);
  table.set('\n', [[0, KEY.ENTER]]);
  table.set('\t', [[0, KEY.TAB]]);
}

// ---------------------------------------------------------------------- US
const US = new Map();
letters(US);
digits(US);
'!@#$%^&*('.split('').forEach((c, i) => US.set(c, [[S, 0x1e + i]]));
US.set(')', [[S, 0x27]]);
for (const [plain, shifted, usage] of [
  ['-',  '_', 0x2d], ['=', '+', 0x2e], ['[', '{', 0x2f], [']', '}', 0x30],
  ['\\', '|', 0x31], [';', ':', 0x33], ["'", '"', 0x34], ['`', '~', 0x35],
  [',',  '<', 0x36], ['.', '>', 0x37], ['/', '?', 0x38],
]) {
  US.set(plain, [[0, usage]]);
  US.set(shifted, [[S, usage]]);
}
common(US);

// ------------------------------------------------------------------- ABNT2
// Brazilian layout. Two keys have no US equivalent: the ISO key left of Z
// carries \ and |, and the key left of right-shift carries / and ?.
const ABNT2 = new Map();
letters(ABNT2);
digits(ABNT2);

// The digit row differs from US at 6, which is a dead diaeresis rather than ^.
[['!', 0x1e], ['@', 0x1f], ['#', 0x20], ['$', 0x21], ['%', 0x22],
 ['&', 0x24], ['*', 0x25], ['(', 0x26], [')', 0x27]].forEach(([c, u]) =>
  ABNT2.set(c, [[S, u]]));

for (const [plain, shifted, usage] of [
  ['-', '_', 0x2d], ['=', '+', 0x2e],
  ['[', '{', 0x30], [']', '}', 0x31],
  ['ç', 'Ç', 0x33],
  ["'", '"', 0x35],
  [',', '<', 0x36], ['.', '>', 0x37],
  [';', ':', 0x38],
  ['/', '?', KEY.INTL_RO],
  ['\\', '|', KEY.ISO_BACKSLASH],
]) {
  ABNT2.set(plain, [[0, usage]]);
  ABNT2.set(shifted, [[S, usage]]);
}
common(ABNT2);

// Dead keys. Pressing one produces nothing until the next keystroke decides
// what it becomes; following it with space yields the bare mark.
const ACUTE      = [0, 0x2f];
const GRAVE      = [S, 0x2f];
const TILDE      = [0, 0x34];
const CIRCUMFLEX = [S, 0x34];
const DIAERESIS  = [S, 0x23];   // shift+6

for (const [ch, dead] of [
  ['´', ACUTE], ['`', GRAVE], ['~', TILDE], ['^', CIRCUMFLEX], ['¨', DIAERESIS],
]) {
  ABNT2.set(ch, [dead, [0, KEY.SPACE]]);
}

// Accented letters: the dead key, then the plain letter.
for (const [mark, dead, bases] of [
  ['acute',      ACUTE,      'aeiouy'],
  ['grave',      GRAVE,      'aeiou'],
  ['tilde',      TILDE,      'ano'],
  ['circumflex', CIRCUMFLEX, 'aeiou'],
  ['diaeresis',  DIAERESIS,  'aeiou'],
]) {
  for (const base of bases) {
    const lower = base.normalize('NFC');
    const composed = {
      acute: '́', grave: '̀', tilde: '̃',
      circumflex: '̂', diaeresis: '̈',
    }[mark];
    const lo = (lower + composed).normalize('NFC');
    const hi = (lower.toUpperCase() + composed).normalize('NFC');
    if (lo.length === 1) ABNT2.set(lo, [dead, [0, 0x04 + LETTERS.indexOf(lower)]]);
    if (hi.length === 1) ABNT2.set(hi, [dead, [S, 0x04 + LETTERS.indexOf(lower)]]);
  }
}

// A few AltGr characters that turn up in passwords and prose.
ABNT2.set('²', [[ALTGR, 0x1f]]);
ABNT2.set('³', [[ALTGR, 0x20]]);
ABNT2.set('°', [[ALTGR, 0x1e]]);

export const LAYOUTS = {
  us:    { label: 'US',    table: US },
  abnt2: { label: 'ABNT2', table: ABNT2 },
};

export const DEFAULT_LAYOUT = 'us';

// Returns a flat [ [mods, usage], ... ] plus any characters with no key.
export function textToKeys(text, layout = DEFAULT_LAYOUT) {
  const table = (LAYOUTS[layout] ?? LAYOUTS[DEFAULT_LAYOUT]).table;
  const keys = [];
  const skipped = [];
  for (const ch of text) {
    const steps = table.get(ch) ?? table.get(ch.normalize('NFC'));
    if (steps) keys.push(...steps);
    else skipped.push(ch);
  }
  return { keys, skipped };
}
