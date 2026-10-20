// Reader for the binary trace written by mmdecode. See docs/trace-format.md.

function ascii(dv, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(off + i);
    if (c) s += String.fromCharCode(c);
  }
  return s.trim();
}

export function parseTrace(buf) {
  const dv = new DataView(buf);
  if (ascii(dv, 0, 8) !== 'MMTRACE1') throw new Error('not an mmdecode trace');
  const laneCount = dv.getUint32(12, true);
  const stageCount = dv.getUint32(16, true);
  const flags = dv.getUint32(20, true);
  const tscGhz = dv.getFloat64(24, true);
  const n = dv.getUint32(32, true);
  const nPackets = dv.getUint32(36, true);
  const nBook = dv.getUint32(40, true);
  const heroMessage = dv.getUint32(44, true);
  const heroSymbol = ascii(dv, 48, 8);
  const heroLocate = dv.getUint16(56, true);
  const symbolCount = dv.getUint32(60, true);
  const laneNames = [ascii(dv, 64, 16), ascii(dv, 80, 16)].slice(0, laneCount);
  const ringSlots = dv.getUint32(96, true);
  const timerNs = dv.getFloat32(100, true);

  let off = 128;
  const packetArrival = new Float64Array(nPackets);
  const packetFirst = new Uint32Array(nPackets);
  const packetCount = new Uint16Array(nPackets);
  const packetBytes = new Uint16Array(nPackets);
  for (let p = 0; p < nPackets; p++, off += 16) {
    packetArrival[p] = Number(dv.getBigUint64(off, true));
    packetFirst[p] = dv.getUint32(off + 8, true);
    packetCount[p] = dv.getUint16(off + 12, true);
    packetBytes[p] = dv.getUint16(off + 14, true);
  }

  const msgPacket = new Uint32Array(n);
  const msgType = new Uint8Array(n);
  const msgHero = new Uint8Array(n);
  const msgLocate = new Uint16Array(n);
  for (let i = 0; i < n; i++, off += 8) {
    msgPacket[i] = dv.getUint32(off, true);
    msgType[i] = dv.getUint8(off + 4);
    msgHero[i] = dv.getUint8(off + 5);
    msgLocate[i] = dv.getUint16(off + 6, true);
  }

  const counters = (flags & 1) !== 0;
  const lanes = [];
  for (let l = 0; l < laneCount; l++) {
    const ticks = new Uint32Array(buf, off, n * stageCount);
    off += 4 * n * stageCount;
    let counts = null;
    if (counters) {
      counts = new Uint16Array(buf, off, n * stageCount * 4);
      off += 2 * n * stageCount * 4;
    }
    const outcome = new Uint8Array(buf, off, n);
    off += n;
    off = (off + 3) & ~3;
    lanes.push({ name: laneNames[l], ticks, counts, outcome });
  }

  const book = {
    message: new Uint32Array(nBook),
    kind: new Uint8Array(nBook),
    side: new Uint8Array(nBook),
    price: new Uint32Array(nBook),
    qty: new Uint32Array(nBook),
  };
  for (let i = 0; i < nBook; i++, off += 16) {
    book.message[i] = dv.getUint32(off, true);
    book.kind[i] = dv.getUint8(off + 4);
    book.side[i] = dv.getUint8(off + 5);
    book.price[i] = dv.getUint32(off + 8, true);
    book.qty[i] = dv.getUint32(off + 12, true);
  }

  const symbols = new Map();
  for (let i = 0; i < symbolCount && off + 10 <= buf.byteLength; i++, off += 10) {
    symbols.set(dv.getUint16(off, true), ascii(dv, off + 2, 8));
  }

  return {
    source: 'decoder',
    flags,
    counters,
    rdpmc: (flags & 2) !== 0,
    tscGhz,
    stageCount,
    messageCount: n,
    packetTotal: nPackets,
    packetArrival, packetFirst, packetCount, packetBytes,
    msgPacket, msgType, msgHero, msgLocate,
    lanes,
    book,
    symbols,
    heroMessage: heroMessage === 0xffffffff ? -1 : heroMessage,
    heroSymbol,
    heroLocate,
    ringSlots,
    timerNs,
    averaged: (flags & 4) !== 0,
  };
}

export async function loadTrace(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return parseTrace(await res.arrayBuffer());
}
