// Figures for everything outside our software. These are typical published values, not
// measurements, and the receipt marks them as such. Change them to match your own setup.
export const FIBRE_NS_PER_M = 4.9;

export const WIRE = {
  fibreMetres: 100,
  switchNs: 5,
  conventionalSwitchNs: 350,
  patchMetres: 3,
  opticPhyNs: 40,
  macNs: 60,
  pcieNs: 400,
  pollNs: 50,
  kernelPathNs: 5000,
  txNs: 600,
};

export const STAGES = ['frame', 'decode', 'book', 'signal', 'risk', 'encode'];
export const STAGE_TITLES = ['Frame', 'Decode', 'Book', 'Signal', 'Risk', 'Encode'];

// Load-to-use latency drawn for each level of the memory hierarchy, and the cost of a branch
// mispredict. Depth below the pipeline is proportional to these.
export const LEVELS = [
  { id: 'L2', ns: 4, color: 0x4f9dff },
  { id: 'L3', ns: 14, color: 0x8a6bff },
  { id: 'DRAM', ns: 90, color: 0xff4fd8 },
];
export const BRANCH_NS = 6;

export const TYPE_COLORS = {
  A: 0x3fd8ff, F: 0x3fd8ff,
  E: 0xffc44d, C: 0xffc44d,
  X: 0xff7a6b, D: 0xff3b5c,
  U: 0xb48cff,
  P: 0xff9f43,
  default: 0x7f93a8,
};

export const TYPE_NAMES = {
  A: 'Add Order', F: 'Add Order (MPID)', E: 'Order Executed', C: 'Executed with Price',
  X: 'Order Cancel', D: 'Order Delete', U: 'Order Replace', P: 'Trade', R: 'Stock Directory',
  S: 'System Event', Q: 'Cross Trade', H: 'Trading Action',
};

export const LANE_COLORS = [0xff4fa3, 0x3fffb0];
export const LANE_TITLES = ['Naive', 'Tuned'];
