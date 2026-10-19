// Content for Act VI: each stage of the two builds, explained. Per-line costs are typical
// figures for the kind of access a line makes (an L2 hit is about 4 ns, an L3 hit about 14 ns,
// a trip to DRAM about 90 ns, a heap allocation 20 to 60 ns). They are not measurements of these
// lines; the measured numbers on each page are per stage.

export const ACCESS = {
  hit: { label: 'L1 hit', color: '#3fd8ff' },
  near: { label: 'one load, usually L1/L2', color: '#4f9dff' },
  chase: { label: 'pointer chase', color: '#ff4fd8' },
  alloc: { label: 'heap allocation', color: '#ffb02e' },
  copy: { label: 'copy', color: '#b48cff' },
  branch: { label: 'hard-to-predict branches', color: '#ff6b5b' },
  ddio: { label: 'first touch of packet, in L3', color: '#8a6bff' },
};

export const PAGES = [
  {
    stage: 0,
    title: 'Frame: finding the next message in the packet',
    body: [
      'Both builds start by reading the MoldUDP64 header and the two-byte length in front of each message. The packet bytes were written by the network card straight into L3, so the first read of them is an L3 hit, about 14 ns, in either build. Nothing in software can avoid that, only hide it.',
      'The naive build then constructs a std::string just to look at the session name, assembles the sequence number one byte at a time, and copies every message into a std::vector before anything else happens. The copy is small, but it touches a second buffer and adds work to every single message.',
      'The tuned build reads the header in place, with one load and a byte swap per field, and hands the next stage a pointer into the packet. Nothing is copied.',
    ],
    naive: [
      { match: /std::string session/, kind: 'copy', cost: [3, 8], note: 'builds a string to read 10 bytes' },
      { match: /seq = \(seq << 8\)/, kind: 'branch', cost: [2, 6], note: 'byte-by-byte loop' },
      { match: /current_\.assign/, kind: 'copy', cost: [4, 15], note: 'copies the whole message' },
      { match: /c\.packet\[c\.pos\] << 8/, kind: 'ddio', cost: [14, 14], note: 'packet bytes arrive in L3' },
    ],
    tuned: [
      { match: /be64\(c\.packet \+ 10\)/, kind: 'ddio', cost: [14, 14], note: 'packet bytes arrive in L3' },
      { match: /be16\(c\.packet \+ c\.pos\)/, kind: 'hit', cost: [1, 1], note: 'same cache line, now hot' },
    ],
  },
  {
    stage: 1,
    title: 'Decode: turning bytes into fields',
    body: [
      'The naive build allocates a new object on the heap for every message, picks its class with a switch, then reads each field a byte at a time through the bounds-checked std::vector::at(), building the stock symbol as a std::string character by character. A heap allocation costs 20 to 60 ns on its own, and the freshly allocated memory is often cold.',
      'The tuned build decodes into one plain struct that lives in the lane for its whole life, so it is always in L1. Each field is a single load from a fixed offset followed by a byte swap: two instructions, no branches beyond the switch on the message type.',
    ],
    naive: [
      { match: /std::make_unique</, kind: 'alloc', cost: [20, 60], note: 'new heap object per message' },
      { match: /read_be\(11, 8\)/, kind: 'branch', cost: [4, 10], note: '8 bounds-checked byte reads' },
      { match: /s \+= ch/, kind: 'copy', cost: [5, 15], note: 'symbol built char by char' },
    ],
    tuned: [
      { match: /be64\(p \+ off::kRef\)/, kind: 'hit', cost: [1, 1], note: 'one load + byte swap' },
      { match: /be32\(p \+ off::kAddShares\)/, kind: 'hit', cost: [1, 1], note: 'one load + byte swap' },
    ],
  },
  {
    stage: 2,
    title: 'Book: where the cache misses live',
    body: [
      'This is the stage that decides the race. To apply a message, both builds must find the order it refers to and then the price level that order sits on.',
      'The naive build finds its order in a std::unordered_map: hash the reference, load the bucket, then follow a pointer to a node allocated somewhere else on the heap. It finds the book through a second hash map keyed by the symbol string, and then walks a std::map, a red-black tree, to the price level: one node per step, about six steps deep. Every step is a load whose address depends on the previous load, so the core cannot start the next one until the last has arrived. If each node is in L2 that is a few nanoseconds per step; if they have been pushed out of cache it is 14 or 90 ns per step, one after another.',
      'The tuned build indexes a flat table directly by the order reference. ITCH issues references in sequence and most orders are cancelled soon after they are added, so the slots being touched sit close together and stay hot. Price levels are a small array kept best-first, so finding a level is a short scan over one or two cache lines that the prefetcher has already pulled in.',
      'Tuned is not immune. An order added long ago has a slot that may have fallen out of cache, and then even tuned waits on L3 or DRAM, as the featured message shows. The difference is that it pays for one load where naive pays for a chain of five or more.',
    ],
    naive: [
      { match: /dynamic_cast<AddOrder\*>/, kind: 'branch', cost: [5, 20], note: 'type tests, one after another' },
      { match: /orders_\[a->ref\] = Order/, kind: 'alloc', cost: [30, 150], note: 'hash, bucket, new node' },
      { match: /Book& b = books_\[stock\]/, kind: 'chase', cost: [10, 200], note: 'string hash, then 2 to 3 dependent loads' },
      { match: /b\.bids\[price\] \+=/, kind: 'chase', cost: [20, 300], note: 'tree walk, about 6 dependent loads' },
      { match: /b\.asks\[price\] \+=/, kind: 'chase', cost: [20, 300], note: 'tree walk, about 6 dependent loads' },
      { match: /auto it = orders_\.find\(u->ref\)/, kind: 'chase', cost: [10, 200], note: 'bucket, then node' },
    ],
    tuned: [
      { match: /Order\* o = insert\(m_\.ref\)/, kind: 'near', cost: [1, 14], note: 'one slot, neighbours hot' },
      { match: /Order\* old = find\(m_\.ref\)/, kind: 'near', cost: [1, 90], note: 'old orders can miss' },
      { match: /Order\* o = &table_\[i\]/, kind: 'near', cost: [1, 90], note: 'one load into a flat table' },
      { match: /Book& b = books_\[locate\]/, kind: 'near', cost: [1, 14], note: 'array indexed by stock' },
      { match: /while \(i < n && lv\[i\]\.price/, kind: 'hit', cost: [1, 4], note: 'short scan, prefetched' },
    ],
  },
  {
    stage: 3,
    title: 'Signal: deciding whether to trade',
    body: [
      'The strategy here is deliberately simple: if a trade has just emptied the best price level, send an order at the next one. Both builds make exactly the same decision.',
      'The naive build looks the book up again by symbol string, then copies every level on both sides out of the trees into two freshly allocated vectors, walking every node to do it, so that it can compute an imbalance figure it barely uses. That is where its occasional several-hundred-nanosecond signal stages come from: the cost grows with the depth of the book.',
      'The tuned build checks one flag that the Book stage already set and reads the best level from an array it touched a moment ago. Both loads are L1 hits.',
    ],
    naive: [
      { match: /books_\.at\(last_\.stock\)/, kind: 'chase', cost: [10, 200], note: 'string hash lookup again' },
      { match: /bids\(b\.bids\.begin\(\)/, kind: 'alloc', cost: [50, 600], note: 'allocates, walks every bid' },
      { match: /asks\(b\.asks\.begin\(\)/, kind: 'alloc', cost: [50, 600], note: 'allocates, walks every ask' },
    ],
    tuned: [
      { match: /if \(!exec_cleared_\)/, kind: 'hit', cost: [1, 1], note: 'flag set by Book' },
      { match: /const Book& b = books_\[exec_locate_\]/, kind: 'hit', cost: [1, 4], note: 'touched a moment ago' },
    ],
  },
  {
    stage: 4,
    title: 'Risk: checking the position limit',
    body: [
      'Before an order goes out, both builds check that it would not take the position in that stock past a limit.',
      'The naive build keeps positions in a std::map keyed by the symbol string, so every check is a tree walk with a string comparison at each node. The tuned build keeps them in an array indexed by the stock\'s number from the feed: one load.',
    ],
    naive: [
      { match: /positions_\[intent_stock_\]/, kind: 'chase', cost: [10, 150], note: 'tree walk, string compares' },
    ],
    tuned: [
      { match: /positions_\[intent_\.locate\]/, kind: 'near', cost: [1, 4], note: 'array index' },
    ],
  },
  {
    stage: 5,
    title: 'Encode: writing the order',
    body: [
      'The order is a fixed-layout OUCH message of 49 bytes. Most of it never changes between orders.',
      'The naive build assembles it one append at a time into a std::string that outgrows its small-string buffer and reallocates as it goes, formats the order number with std::to_string, pads fields by building temporary strings, and finally pushes the result into a growing vector.',
      'The tuned build keeps a ring of pre-filled order templates and patches only the fields that change: the order number, side, size, symbol and price. It writes a few dozen bytes into memory that is already in cache.',
    ],
    naive: [
      { match: /std::string out;/, kind: 'alloc', cost: [20, 60], note: 'grows past 15 bytes, reallocates' },
      { match: /std::to_string/, kind: 'alloc', cost: [10, 40], note: 'temporary strings' },
      { match: /sent_\.push_back/, kind: 'alloc', cost: [5, 60], note: 'vector growth' },
    ],
    tuned: [
      { match: /uint8_t\* o = outbox_\.data\(\)/, kind: 'hit', cost: [1, 4], note: 'template already in cache' },
      { match: /std::memcpy\(o \+ 20/, kind: 'hit', cost: [1, 1], note: '8-byte copy' },
    ],
  },
];

export const INTRO = {
  title: 'The code, one stage at a time',
  body: [
    'Both builds are written for this toy example and do exactly the same job: frame, decode, update the book, decide, check risk and encode an order. They agree on every decision for every message in the trace. The only difference is how they use memory.',
    'On each page, the stage\'s code from both builds sits side by side. Lines that touch memory are marked with the kind of access they make and a bar for what that kind of access typically costs, from about 1 ns for an L1 hit to about 90 ns for a trip to DRAM. Those bars are typical figures, not measurements of the individual lines. Above the code are the measured times for the stage, for the featured message and across the whole trace.',
  ],
};

export const OUTRO = {
  title: 'The pattern',
  body: [
    'Almost all of the difference comes from three habits. The naive build allocates as it goes, so it keeps touching memory nobody has touched recently. It chases pointers, so each load waits for the one before it. And it copies data it then barely uses.',
    'The tuned build allocates nothing on the hot path, keeps related data next to each other in flat arrays, and touches as few cache lines as it can. It still misses sometimes, but each miss is a single load, not a chain of them.',
    'None of this is exotic, and real systems go much further. The point is how quickly ordinary, readable code turns into hundreds of nanoseconds once memory is involved.',
  ],
};
