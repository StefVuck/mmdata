// Turns a caption into text a voice reads well, and gives each line a stable key. Used both by
// the viewer and by tools/narrate.mjs, so the recordings and the captions always match.

const SAY = [
  [/MoldUDP64/g, 'Mold U D P sixty-four'],
  [/\bPCIe\b/g, 'P C I express'],
  [/\bDRAM\b/g, 'D-RAM'],
  [/\bDIMMs\b/g, 'dims'],
  [/\bDMA\b/g, 'D M A'],
  [/\bUDP\b/g, 'U D P'],
  [/\bPHY\b/g, 'fy'],
  [/\bL1d?\b/g, 'L one'],
  [/\bL2\b/g, 'L two'],
  [/\bL3\b/g, 'L three'],
  [/\bITCH\b/g, 'itch'],
  [/\bOUCH\b/g, 'ouch'],
  [/(\d)\s?µs\b/g, '$1 microseconds'],
  [/(\d)\s?ns\b/g, '$1 nanoseconds'],
  [/(\d)\s?ms\b/g, '$1 milliseconds'],
  [/(\d)\s?m\/s\b/g, '$1 metres per second'],
  [/(\d)\s?MB\b/g, '$1 megabytes'],
  [/\s@\s/g, ' at '],
  [/~/g, 'about '],
  [/×/g, 'times '],
  [/→/g, ', then '],
];

export function speakable(html) {
  if (!html) return '';
  let s = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, 'and')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of SAY) s = s.replace(re, to);
  return s;
}

// FNV-1a, 32-bit, as hex: short, stable and good enough to name a file.
export function lineKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
