// On-screen keyboard layouts, as data.
//
// This file describes WHAT a keyboard looks like. It never touches the
// transport and never resolves a key to a HID usage code: printable characters
// are carried as characters and resolved through keymap.js at press time, so
// the same preset is correct on US and on ABNT2. Baking usage codes in here
// would silently type the wrong glyph on one of the two layouts.
//
// The only usage codes that appear are NAMES of keys that have no character -
// Enter, arrows, F-keys - and even those are names, not numbers: the consumer
// looks them up in KEY from keymap.js. Nothing is imported here on purpose, so
// this file cannot break whoever consumes it.
//
// ---------------------------------------------------------------- key entries
// A row is an array of entries. Every entry has a `type`:
//
//   type 'char'   a printable character.
//     ch          the character (or short string) to type, via keymap.js
//     legend      what to draw
//     chShift     what to type while Shift is active; when absent, the
//                 consumer applies the Shift bit to `ch` instead
//     legendShift what to draw while Shift is active
//
//   type 'key'    a named key with no character of its own.
//     key         a name in KEY from keymap.js: 'ENTER', 'LEFT', 'F5', ...
//     mods        optional modifier bits to hold with it (e.g. Opt+Left)
//     legend      what to draw
//
//   type 'mod'    a modifier. The consumer owns sticky/latch behaviour.
//     mod         modifier bitmask: 1 Ctrl, 2 Shift, 4 Alt/Opt, 8 Cmd/Gui
//
//   type 'layer'  switches the visible layer of this preset.
//     layer       id of the target layer, a key of preset.layers
//     hold        true means momentary (active while held), else it toggles
//
//   type 'act'    asks the host app to do something; see OSK_ACTIONS.
//     act         one of the OSK_ACTIONS ids
//
//   type 'gap'    empty space. Occupies width, draws nothing, is not a key.
//
// Every entry also has:
//   w             width in units, default 1. A row's widths sum to the
//                 preset's `units`, so a stylesheet can size keys from
//                 `units` alone with no measuring.
//   repeat        true for keys that should auto-repeat while held
//                 (backspace, arrows) - advisory, the consumer decides.
//
//   type 'consumer'  a USB consumer-control key (media, volume, TV remote,
//     usage          browser and launch keys): the HID usage on page 0x0C.
//
// ------------------------------------------------------------- why these six
// The set covers the two axes that actually matter on a phone: how many keys
// fit across, and whether the hands are on the glass or on a thumb.
//
//   compact  40% style. 10 keys across, so a key is ~36px on a 390px phone -
//            the only preset with keys as big as the phone's own keyboard.
//            Digits and punctuation live on layers, which is what makes 10
//            across possible. This is the default for that reason.
//   60       the classic 60%: 15 units across, everything except the function
//            row, the navigation cluster and the numpad. Nothing is hidden on
//            a layer except F-keys, so shortcuts are one tap. Comfortable in
//            landscape or on a tablet.
//   65       60% plus arrows, plus the Del/Home/PgUp/PgDn column that arrows
//            are useless without. 16 units. The smallest layout that can edit
//            text without a layer switch.
//   full     function row, navigation cluster and arrows, 18.5 units. Too wide
//            for a phone in portrait and honestly so: it exists for landscape
//            and tablets, and for hosts where F-keys and PrtSc-adjacent keys
//            are needed in one place.
//   numpad   digits only, 4 units, big targets. For data entry and for
//            passcodes, one-handed. Includes a decimal comma, because pt-BR
//            spreadsheets need it.
//   nav      arrows, paging, and playback and volume, 3 units of huge keys.
//            The one-handed remote: it is what you want when the phone is in
//            one hand and the computer is across the room.
//
// Presets are data, not a hierarchy. Adding one means adding an entry to
// OSK_PRESETS and its id to OSK_PRESET_ORDER; the metrics below are derived.

export const OSK_SCHEMA_VERSION = 1;

// Modifier bits, repeated here so this file stays import-free. Same values as
// MOD in keymap.js.
export const OSK_MOD = { CTRL: 1, SHIFT: 2, ALT: 4, GUI: 8 };

// Vocabulary for type 'act'. The presets below use none of these; they exist
// so the host app can inject its own chrome into a row (a key that returns to
// the trackpad, for instance) without inventing a private shape.
export const OSK_ACTIONS = {
  TRACKPAD: 'trackpad',      // leave the keyboard, show the trackpad
  RELEASE_ALL: 'releaseAll', // panic: drop every held key and button
  NEXT_PRESET: 'nextPreset', // cycle to the next preset in OSK_PRESET_ORDER
  CLOSE: 'close',            // leave full-screen mode
};

// --------------------------------------------------------------- tiny builders
// These only shape literals. Everything they produce is frozen plain data.

const ch = (c, shift, w = 1) => {
  const up = c.length === 1 && c.toLowerCase() !== c.toUpperCase() ? c.toUpperCase() : null;
  const s = shift ?? up;
  const e = { type: 'char', ch: c, legend: c, w };
  if (s != null) { e.chShift = s; e.legendShift = s; }
  return e;
};

// A letter: drawn lowercase, drawn and typed uppercase under Shift.
const L = (c) => ch(c);

const key = (name, legend, w = 1, opts = {}) => {
  const e = { type: 'key', key: name, legend, w };
  if (opts.mods) e.mods = opts.mods;
  if (opts.repeat) e.repeat = true;
  return e;
};

const mod = (bit, legend, w = 1) => ({ type: 'mod', mod: bit, legend, w });

const layer = (id, legend, w = 1, hold = false) =>
  ({ type: 'layer', layer: id, legend, w, hold });

const gap = (w) => ({ type: 'gap', w });

// A consumer-control key (USB HID usage page 0x0C): real media and remote
// keys that computers and TV boxes act on, unlike F7-F12.
const cons = (usage, legend, w = 1, opts = {}) =>
  ({ type: 'consumer', usage, legend, w, ...(opts.repeat ? { repeat: true } : {}) });
const C = Object.freeze({
  PLAY: 0x00CD, NEXT: 0x00B5, PREV: 0x00B6, MUTE: 0x00E2,
  VOL_UP: 0x00E9, VOL_DOWN: 0x00EA, HOME: 0x0223, BACK: 0x0224,
  MENU: 0x0040, SEARCH: 0x0221,
  STOP: 0x00B7, REWIND: 0x00B4, FFWD: 0x00B3, EJECT: 0x00B8,
  BRIGHT_UP: 0x006F, BRIGHT_DOWN: 0x0070,
  WEB_BACK: 0x0224, WEB_FORWARD: 0x0225, WEB_REFRESH: 0x0227, WEB_HOME: 0x0223,
  CALC: 0x0192, MAIL: 0x018A, BROWSER: 0x0196, FILES: 0x0194,
});
// A char key with a word on its cap instead of the character (B -> "Black").
const label = (entry, legend) => ({ ...entry, legend, legendShift: legend });
const MEDIA = {
  prev: C.PREV, play: C.PLAY, next: C.NEXT,
  mute: C.MUTE, volDown: C.VOL_DOWN, volUp: C.VOL_UP,
};
// Fn-layer media keys, now real consumer keys instead of F7-F12.
const media = (id, _fkey, legend, w = 1) =>
  cons(MEDIA[id], legend, w, { repeat: id === 'volUp' || id === 'volDown' });

const M = OSK_MOD;

// ------------------------------------------------------------------ shared rows
// 60% and its descendants share their alphanumeric block. Built by function so
// each preset owns its own objects and nothing is aliased between presets.

const digitsRow = () => [
  ch('`', '~'),
  ch('1', '!'), ch('2', '@'), ch('3', '#'), ch('4', '$'), ch('5', '%'),
  ch('6', '^'), ch('7', '&'), ch('8', '*'), ch('9', '('), ch('0', ')'),
  ch('-', '_'), ch('=', '+'),
];

const qwertyRow = () => [
  L('q'), L('w'), L('e'), L('r'), L('t'), L('y'), L('u'), L('i'), L('o'), L('p'),
  ch('[', '{'), ch(']', '}'),
];

const homeRow = () => [
  L('a'), L('s'), L('d'), L('f'), L('g'), L('h'), L('j'), L('k'), L('l'),
  ch(';', ':'), ch("'", '"'),
];

const bottomRow = () => [
  L('z'), L('x'), L('c'), L('v'), L('b'), L('n'), L('m'),
  ch(',', '<'), ch('.', '>'), ch('/', '?'),
];

// The F-key and navigation layer that a 60% or 65% reaches through Fn.
const fnLayer = () => [
  [
    key('ESC', 'Esc'),
    key('F1', 'F1'), key('F2', 'F2'), key('F3', 'F3'), key('F4', 'F4'),
    key('F5', 'F5'), key('F6', 'F6'), key('F7', 'F7'), key('F8', 'F8'),
    key('F9', 'F9'), key('F10', 'F10'), key('F11', 'F11'), key('F12', 'F12'),
    key('DELETE', 'Del', 2, { repeat: true }),
  ],
  [
    key('INSERT', 'Ins', 1.5), key('HOME', 'Home'), key('PAGEUP', 'PgUp'),
    key('END', 'End'), key('PAGEDOWN', 'PgDn'),
    gap(1.5),
    media('prev', 'F7', 'Prev'), media('play', 'F8', 'Play'), media('next', 'F9', 'Next'),
    media('mute', 'F10', 'Mute'), media('volDown', 'F11', 'Vol-'), media('volUp', 'F12', 'Vol+'),
    gap(0.5),
    key('CAPSLOCK', 'Caps', 1.5),
  ],
  [
    key('PRINTSCREEN', 'PrtSc', 1.75),
    key('TAB', 'Tab'), key('ENTER', 'Enter', 2),
    key('SCROLLLOCK', 'ScrLk', 1.5),
    key('UP', '↑', 1, { repeat: true }),
    key('PAUSE', 'Pause', 1.5),
    key('BACKSPACE', 'Bksp', 2, { repeat: true }),
    key('MENU', 'Menu', 2.25),
    key('ISO_BACKSLASH', '\\ ISO'), key('INTL_RO', '/ ABNT'),
  ],
  [
    mod(M.CTRL, 'Ctrl', 1.25), mod(M.ALT, 'Opt', 1.25), mod(M.GUI, 'Cmd', 1.25),
    mod(M.SHIFT, 'Shift', 2.25),
    gap(4),
    layer('base', 'abc', 1.5),
    gap(0.5),
    key('LEFT', '←', 1, { repeat: true }),
    key('DOWN', '↓', 1, { repeat: true }),
    key('RIGHT', '→', 1, { repeat: true }),
  ],
];

// ------------------------------------------------------------------- presets

const PRESET_60 = {
  id: '60',
  label: '60%',
  hint: 'Standard, no function row.',
  units: 15,
  defaultLayer: 'base',
  layers: {
    base: [
      [...digitsRow(), key('BACKSPACE', 'Bksp', 2, { repeat: true })],
      [key('TAB', 'Tab', 1.5), ...qwertyRow(), ch('\\', '|', 1.5)],
      [key('CAPSLOCK', 'Caps', 1.75), ...homeRow(), key('ENTER', 'Enter', 2.25)],
      [mod(M.SHIFT, 'Shift', 2.25), ...bottomRow(), mod(M.SHIFT, 'Shift', 2.75)],
      [
        mod(M.CTRL, 'Ctrl', 1.25), mod(M.ALT, 'Opt', 1.25), mod(M.GUI, 'Cmd', 1.25),
        key('SPACE', 'space', 6.25),
        mod(M.GUI, 'Cmd', 1.25), mod(M.ALT, 'Opt', 1.25),
        layer('fn', 'Fn', 1.25), mod(M.CTRL, 'Ctrl', 1.25),
      ],
    ],
    fn: fnLayer(),
  },
};

const PRESET_65 = {
  id: '65',
  label: '65%',
  hint: 'Adds arrows and Del/Home.',
  units: 16,
  defaultLayer: 'base',
  layers: {
    base: [
      [
        ...digitsRow(), key('BACKSPACE', 'Bksp', 2, { repeat: true }),
        key('DELETE', 'Del', 1, { repeat: true }),
      ],
      [key('TAB', 'Tab', 1.5), ...qwertyRow(), ch('\\', '|', 1.5), key('HOME', 'Home')],
      [
        key('CAPSLOCK', 'Caps', 1.75), ...homeRow(), key('ENTER', 'Enter', 2.25),
        key('PAGEUP', 'PgUp'),
      ],
      [
        mod(M.SHIFT, 'Shift', 2.25), ...bottomRow(), mod(M.SHIFT, 'Shift', 1.75),
        key('UP', '↑', 1, { repeat: true }), key('PAGEDOWN', 'PgDn'),
      ],
      [
        mod(M.CTRL, 'Ctrl', 1.25), mod(M.ALT, 'Opt', 1.25), mod(M.GUI, 'Cmd', 1.25),
        key('SPACE', 'space', 6.75),
        mod(M.GUI, 'Cmd', 1.25), layer('fn', 'Fn', 1.25),
        key('LEFT', '←', 1, { repeat: true }),
        key('DOWN', '↓', 1, { repeat: true }),
        key('RIGHT', '→', 1, { repeat: true }),
      ],
    ],
    fn: (() => {
      // Same Fn layer, widened by one unit so rows still fill a 65% shell.
      const rows = fnLayer();
      rows.forEach((row) => row.push(gap(1)));
      return rows;
    })(),
  },
};

const PRESET_COMPACT = {
  id: 'compact',
  label: 'Compact',
  hint: 'Letters first, the rest on layers.',
  units: 10,
  defaultLayer: 'base',
  layers: {
    base: [
      qwertyRow().slice(0, 10),
      [gap(0.5), ...homeRow().slice(0, 9), gap(0.5)],
      [
        mod(M.SHIFT, 'Shift', 1.5),
        ...bottomRow().slice(0, 7),
        key('BACKSPACE', 'Bksp', 1.5, { repeat: true }),
      ],
      [
        layer('num', '?123', 1.5),
        mod(M.CTRL, 'Ctrl'), mod(M.ALT, 'Opt'), mod(M.GUI, 'Cmd'),
        key('SPACE', 'space', 3),
        ch('.', ','),
        key('ENTER', 'Enter', 1.5),
      ],
    ],
    num: [
      [
        ch('1', '!'), ch('2', '@'), ch('3', '#'), ch('4', '$'), ch('5', '%'),
        ch('6', '^'), ch('7', '&'), ch('8', '*'), ch('9', '('), ch('0', ')'),
      ],
      [
        ch('-', '_'), ch('/', '?'), ch(':'), ch(';'), ch('('), ch(')'),
        ch('$'), ch('&'), ch('@'), ch('"'),
      ],
      [
        layer('sym', '=\\<', 1.5),
        ch('.'), ch(','), ch('?'), ch('!'), ch("'"), ch('='), ch('+'),
        key('BACKSPACE', 'Bksp', 1.5, { repeat: true }),
      ],
      [
        layer('base', 'abc', 1.5),
        mod(M.CTRL, 'Ctrl'), mod(M.ALT, 'Opt'), mod(M.GUI, 'Cmd'),
        key('SPACE', 'space', 3),
        key('TAB', 'Tab'),
        key('ENTER', 'Enter', 1.5),
      ],
    ],
    sym: [
      [
        ch('['), ch(']'), ch('{'), ch('}'), ch('#'), ch('%'), ch('^'), ch('*'),
        ch('+'), ch('='),
      ],
      [
        ch('_'), ch('\\'), ch('|'), ch('~'), ch('`'), ch('<'), ch('>'),
        ch('$'), ch('@'), ch('&'),
      ],
      [
        layer('num', '?123', 1.5),
        ch('.'), ch(','), ch('?'), ch('!'), ch("'"), ch('"'), ch(':'),
        key('BACKSPACE', 'Bksp', 1.5, { repeat: true }),
      ],
      [
        layer('base', 'abc', 1.5),
        mod(M.CTRL, 'Ctrl'), mod(M.ALT, 'Opt'), mod(M.GUI, 'Cmd'),
        key('SPACE', 'space', 3),
        key('ESC', 'Esc'),
        key('ENTER', 'Enter', 1.5),
      ],
    ],
    // Arrows and paging, one switch away, so Compact can still edit text.
    nav: [
      [
        key('ESC', 'Esc'), key('TAB', 'Tab'), gap(3),
        key('HOME', 'Home'), key('UP', '↑', 1, { repeat: true }), key('PAGEUP', 'PgUp'),
        gap(1), key('DELETE', 'Del', 1, { repeat: true }),
      ],
      [
        key('F2', 'F2'), key('F5', 'F5'), gap(3),
        key('LEFT', '←', 1, { repeat: true }),
        key('DOWN', '↓', 1, { repeat: true }),
        key('RIGHT', '→', 1, { repeat: true }),
        gap(1), key('BACKSPACE', 'Bksp', 1, { repeat: true }),
      ],
      [
        media('prev', 'F7', 'Prev'), media('play', 'F8', 'Play'), media('next', 'F9', 'Next'),
        gap(1),
        media('mute', 'F10', 'Mute'), media('volDown', 'F11', 'Vol-'), media('volUp', 'F12', 'Vol+'),
        gap(1), key('END', 'End'), key('PAGEDOWN', 'PgDn'),
      ],
      [
        layer('base', 'abc', 1.5),
        mod(M.CTRL, 'Ctrl'), mod(M.ALT, 'Opt'), mod(M.GUI, 'Cmd'), mod(M.SHIFT, 'Shift'),
        key('SPACE', 'space', 3),
        key('ENTER', 'Enter', 1.5),
      ],
    ],
  },
};

const PRESET_FULL = {
  id: 'full',
  label: 'Full',
  hint: 'Function row and navigation.',
  units: 18.5,
  defaultLayer: 'base',
  layers: {
    base: [
      [
        key('ESC', 'Esc'),
        key('F1', 'F1'), key('F2', 'F2'), key('F3', 'F3'), key('F4', 'F4'),
        key('F5', 'F5'), key('F6', 'F6'), key('F7', 'F7'), key('F8', 'F8'),
        key('F9', 'F9'), key('F10', 'F10'), key('F11', 'F11'), key('F12', 'F12'),
        gap(2.5),
        key('INSERT', 'Ins'), key('HOME', 'Home'), key('PAGEUP', 'PgUp'),
      ],
      [
        ...digitsRow(), key('BACKSPACE', 'Bksp', 2, { repeat: true }),
        gap(0.5),
        key('DELETE', 'Del', 1, { repeat: true }), key('END', 'End'), key('PAGEDOWN', 'PgDn'),
      ],
      [
        key('TAB', 'Tab', 1.5), ...qwertyRow(), ch('\\', '|', 1.5),
        gap(3.5),
      ],
      [
        key('CAPSLOCK', 'Caps', 1.75), ...homeRow(), key('ENTER', 'Enter', 2.25),
        gap(3.5),
      ],
      [
        mod(M.SHIFT, 'Shift', 2.25), ...bottomRow(), mod(M.SHIFT, 'Shift', 2.75),
        gap(1.5), key('UP', '↑', 1, { repeat: true }), gap(1),
      ],
      [
        mod(M.CTRL, 'Ctrl', 1.25), mod(M.ALT, 'Opt', 1.25), mod(M.GUI, 'Cmd', 1.25),
        key('SPACE', 'space', 6.25),
        mod(M.GUI, 'Cmd', 1.25), mod(M.ALT, 'Opt', 1.25),
        layer('media', 'Media', 1.25), mod(M.CTRL, 'Ctrl', 1.25),
        gap(0.5),
        key('LEFT', '←', 1, { repeat: true }),
        key('DOWN', '↓', 1, { repeat: true }),
        key('RIGHT', '→', 1, { repeat: true }),
      ],
    ],
    // Playback, volume, and the two keys a US keyboard does not have.
    media: [
      [
        media('prev', 'F7', 'Prev', 2), media('play', 'F8', 'Play', 2),
        media('next', 'F9', 'Next', 2),
        gap(0.5),
        media('mute', 'F10', 'Mute', 2), media('volDown', 'F11', 'Vol-', 2),
        media('volUp', 'F12', 'Vol+', 2),
        gap(6),
      ],
      [
        key('ISO_BACKSLASH', '\\ ISO', 2), key('INTL_RO', '/ ABNT', 2),
        gap(0.5),
        ch('~', null, 2), ch('^', null, 2), ch('`', null, 2),
        gap(8),
      ],
      [
        layer('base', 'Back', 2),
        gap(16.5),
      ],
    ],
  },
};

const PRESET_NUMPAD = {
  id: 'numpad',
  label: 'Numpad',
  hint: 'Digits, big keys.',
  // keymap.js has no keypad usages, so these are the digit-row characters.
  // They type the same text; they are not the keypad keys, so Alt+numpad
  // tricks and a few spreadsheet bindings will not fire.
  units: 4,
  defaultLayer: 'base',
  layers: {
    base: [
      [
        key('ESC', 'Esc'), key('BACKSPACE', 'Bksp', 1, { repeat: true }),
        key('DELETE', 'Del', 1, { repeat: true }), key('TAB', 'Tab'),
      ],
      [ch('7', '&'), ch('8', '*'), ch('9', '('), ch('/', '?')],
      [ch('4', '$'), ch('5', '%'), ch('6', '^'), ch('*')],
      [ch('1', '!'), ch('2', '@'), ch('3', '#'), ch('-', '_')],
      [ch('0', ')'), ch('.', '>'), ch('=', '+'), ch('+')],
      [ch(','), ch('%'), key('ENTER', 'Enter', 2)],
    ],
  },
};

const PRESET_NAV = {
  id: 'nav',
  label: 'Nav',
  hint: 'Arrows and paging, one-handed.',
  units: 3,
  defaultLayer: 'base',
  layers: {
    base: [
      [key('HOME', 'Home'), key('UP', '↑', 1, { repeat: true }), key('PAGEUP', 'PgUp')],
      [
        key('LEFT', '←', 1, { repeat: true }),
        key('DOWN', '↓', 1, { repeat: true }),
        key('RIGHT', '→', 1, { repeat: true }),
      ],
      [key('END', 'End'), key('BACKSPACE', 'Bksp', 1, { repeat: true }), key('PAGEDOWN', 'PgDn')],
      [key('ESC', 'Esc'), key('SPACE', 'space'), key('ENTER', 'Enter')],
      [cons(C.PREV, 'Prev'), cons(C.PLAY, 'Play'), cons(C.NEXT, 'Next')],
      [cons(C.MUTE, 'Mute'), cons(C.VOL_DOWN, 'Vol-', 1, { repeat: true }), cons(C.VOL_UP, 'Vol+', 1, { repeat: true })],
      [
        mod(M.CTRL, 'Ctrl', 0.75), mod(M.ALT, 'Opt', 0.75),
        mod(M.GUI, 'Cmd', 0.75), mod(M.SHIFT, 'Shift', 0.75),
      ],
    ],
  },
};

// A slide clicker. The common shortcuts work in PowerPoint, Keynote and Google
// Slides: arrows step, B and W blank the screen black or white, Home and End
// jump. F5 starts PowerPoint and Slides; Keynote plays with Cmd+Opt+P.
const PRESET_SLIDES = {
  id: 'slides',
  label: 'Slides',
  hint: 'A clicker for presentations.',
  units: 4,
  defaultLayer: 'base',
  layers: {
    base: [
      [key('F5', 'Start'), key('F5', 'From here', 1, { mods: M.SHIFT }), key('ESC', 'End show', 2)],
      [key('LEFT', '← Prev', 1.5, { repeat: true }), key('RIGHT', 'Next →', 2.5, { repeat: true })],
      [key('HOME', 'First'), key('END', 'Last'), label(ch('b'), 'Black'), label(ch('w'), 'White')],
      [cons(C.MUTE, 'Mute'), cons(C.VOL_DOWN, 'Vol-', 1, { repeat: true }),
       cons(C.VOL_UP, 'Vol+', 1, { repeat: true }), cons(C.PLAY, 'Play')],
    ],
  },
};

// A TV box remote (Android TV, Fire TV, Google TV). Arrows and OK drive the
// focus; Home, Back and Menu are the remote's own consumer keys.
const PRESET_TV = {
  id: 'tv',
  label: 'TV remote',
  hint: 'A remote for TV boxes.',
  units: 3,
  defaultLayer: 'base',
  layers: {
    base: [
      [cons(C.BACK, 'Back'), cons(C.HOME, 'Home'), cons(C.MENU, 'Menu')],
      [cons(C.VOL_DOWN, 'Vol-', 1, { repeat: true }), key('UP', '↑', 1, { repeat: true }), cons(C.VOL_UP, 'Vol+', 1, { repeat: true })],
      [key('LEFT', '←', 1, { repeat: true }), key('ENTER', 'OK'), key('RIGHT', '→', 1, { repeat: true })],
      [cons(C.MUTE, 'Mute'), key('DOWN', '↓', 1, { repeat: true }), cons(C.SEARCH, 'Search')],
      [cons(C.REWIND, 'Rew', 1, { repeat: true }), cons(C.PLAY, 'Play'), cons(C.FFWD, 'FF', 1, { repeat: true })],
      [cons(C.PREV, 'Prev'), cons(C.STOP, 'Stop'), cons(C.NEXT, 'Next')],
    ],
  },
};

// Every consumer-control key a computer commonly acts on: playback, volume,
// screen brightness, the browser's own keys, and the launch keys. They go on
// the dongle's consumer interface, so they work at the OS level, not per app.
const PRESET_MEDIA = {
  id: 'media',
  label: 'Media',
  hint: 'Playback, volume, brightness.',
  units: 4,
  defaultLayer: 'base',
  layers: {
    base: [
      [cons(C.PREV, 'Prev'), cons(C.PLAY, 'Play'), cons(C.NEXT, 'Next'), cons(C.STOP, 'Stop')],
      [cons(C.REWIND, 'Rew', 1, { repeat: true }), cons(C.FFWD, 'FF', 1, { repeat: true }),
       cons(C.MUTE, 'Mute'), cons(C.EJECT, 'Eject')],
      [cons(C.VOL_DOWN, 'Vol-', 1, { repeat: true }), cons(C.VOL_UP, 'Vol+', 1, { repeat: true }),
       cons(C.BRIGHT_DOWN, 'Dim', 1, { repeat: true }), cons(C.BRIGHT_UP, 'Bright', 1, { repeat: true })],
      [cons(C.WEB_BACK, 'Back'), cons(C.WEB_FORWARD, 'Fwd'), cons(C.WEB_REFRESH, 'Reload'), cons(C.WEB_HOME, 'Home')],
      [cons(C.SEARCH, 'Search'), cons(C.BROWSER, 'Browser'), cons(C.MAIL, 'Mail'), cons(C.CALC, 'Calc')],
    ],
  },
};

// A game controller. The grid below is only a fallback: pads.js draws the
// real one (two sticks, a D-pad, face buttons, shoulders and triggers), sent
// over the dongle's USB gamepad interface.
const PRESET_GAMEPAD = {
  id: 'gamepad',
  label: 'Gamepad',
  hint: 'Two sticks, triggers, A B X Y.',
  units: 3,
  defaultLayer: 'base',
  layers: { base: [[key('UP', '↑'), key('ENTER', 'OK'), key('DOWN', '↓')]] },
};

const PRESET_GP_CLASSIC = {
  id: 'gpclassic',
  label: 'Classic pad',
  hint: 'D-pad, A B X Y, L R.',
  units: 3,
  defaultLayer: 'base',
  layers: { base: [[key('UP', '↑'), key('ENTER', 'OK'), key('DOWN', '↓')]] },
};
const PRESET_GP_STICK = {
  id: 'gpstick',
  label: 'Classic stick',
  hint: 'Joystick, A B X Y, L R.',
  units: 3,
  defaultLayer: 'base',
  layers: { base: [[key('UP', '↑'), key('ENTER', 'OK'), key('DOWN', '↓')]] },
};

// --------------------------------------------------------------------- exports

export const OSK_PRESETS = {
  compact: PRESET_COMPACT,
  60: PRESET_60,
  65: PRESET_65,
  full: PRESET_FULL,
  numpad: PRESET_NUMPAD,
  nav: PRESET_NAV,
  slides: PRESET_SLIDES,
  tv: PRESET_TV,
  media: PRESET_MEDIA,
  gamepad: PRESET_GAMEPAD,
  gpclassic: PRESET_GP_CLASSIC,
  gpstick: PRESET_GP_STICK,
};

// Menu order: smallest keyboard first, because that is what fits a phone.
export const OSK_PRESET_ORDER = ['compact', '60', '65', 'full', 'numpad', 'nav', 'media', 'slides', 'tv', 'gpclassic', 'gpstick', 'gamepad'];

export const OSK_DEFAULT_PRESET = 'compact';

// ------------------------------------------------------------------- metrics
// Derived so a stylesheet can size keys without measuring anything:
//   rows           row count of the widest-in-rows layer
//   maxKeysInRow   most keys in any one row, gaps excluded
//   units          nominal row width in units, from the preset
//   widestRow      widest row actually built, in units - equals `units` unless
//                  a row was mis-built, which makes this a cheap self-check
//   layers         the same three numbers per layer id

const rowUnits = (row) => row.reduce((sum, e) => sum + (e.w ?? 1), 0);
const rowKeys = (row) => row.filter((e) => e.type !== 'gap').length;

function measure(preset) {
  const layers = {};
  let rows = 0;
  let maxKeysInRow = 0;
  let widestRow = 0;

  for (const [id, layerRows] of Object.entries(preset.layers)) {
    const keysInRow = Math.max(...layerRows.map(rowKeys));
    const widest = Math.max(...layerRows.map(rowUnits));
    layers[id] = {
      rows: layerRows.length,
      maxKeysInRow: keysInRow,
      widestRow: Math.round(widest * 100) / 100,
      keyCount: layerRows.reduce((n, row) => n + rowKeys(row), 0),
    };
    rows = Math.max(rows, layerRows.length);
    maxKeysInRow = Math.max(maxKeysInRow, keysInRow);
    widestRow = Math.max(widestRow, widest);
  }

  return {
    rows,
    maxKeysInRow,
    units: preset.units,
    widestRow: Math.round(widestRow * 100) / 100,
    layers,
  };
}

export const OSK_METRICS = Object.fromEntries(
  OSK_PRESET_ORDER.map((id) => [id, measure(OSK_PRESETS[id])])
);

// For a menu: [{ id, label, hint, rows, maxKeysInRow, units }, ...]
export const OSK_PRESET_LIST = OSK_PRESET_ORDER.map((id) => {
  const p = OSK_PRESETS[id];
  const m = OSK_METRICS[id];
  return {
    id,
    label: p.label,
    hint: p.hint,
    rows: m.rows,
    maxKeysInRow: m.maxKeysInRow,
    units: m.units,
    layers: Object.keys(p.layers),
  };
});

// Never returns undefined: an unknown id falls back to the default, so a stale
// value in localStorage cannot leave the keyboard blank.
export function getPreset(id) {
  return OSK_PRESETS[id] ?? OSK_PRESETS[OSK_DEFAULT_PRESET];
}

export function getLayer(id, layerId) {
  const p = getPreset(id);
  return p.layers[layerId] ?? p.layers[p.defaultLayer];
}

// Frozen because presets are shared: a consumer that mutates a row would
// corrupt every other view of the same keyboard.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

deepFreeze(OSK_PRESETS);
deepFreeze(OSK_METRICS);
deepFreeze(OSK_PRESET_LIST);
deepFreeze(OSK_PRESET_ORDER);
deepFreeze(OSK_ACTIONS);
deepFreeze(OSK_MOD);
