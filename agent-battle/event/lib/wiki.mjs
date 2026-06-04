// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0

// Minecraft wiki MCP — one tool, lookup(query) → fact.
//
// Node port of wiki_mcp.py so the event server is a single runtime.
// The facts and ranking behavior are kept identical; participants who
// attach MCP_MINECRAFT_WIKI get the same answers whether they point at
// a local wiki_mcp.py or the hosted /wiki/mcp endpoint.

export const FACTS = {
  'diamond depth': (
    'In Minecraft 1.18+, diamond ore generation peaks around y=-58. '
    + 'It generates between y=-64 and y=16, with frequency increasing '
    + "as you go deeper. Both 'diamond_ore' (in stone) and "
    + "'deepslate_diamond_ore' (in deepslate, below y=0) drop diamonds; "
    + 'search for both names.'
  ),
  'ore requirements': (
    'Diamond ore requires an iron_pickaxe or better to drop diamonds. '
    + 'Mining it with wood or stone yields nothing. A diamond_pickaxe '
    + 'is NOT required — iron is sufficient. Iron ore needs a '
    + 'stone_pickaxe or better; coal and stone need wooden or better.'
  ),
  'tech tree': (
    'From-scratch path to diamonds: punch logs → craft planks → '
    + 'crafting_table + sticks → wooden_pickaxe → mine cobblestone → '
    + 'stone_pickaxe → mine iron_ore → place furnace + fuel → smelt to '
    + 'iron_ingot → iron_pickaxe → descend below y=0 → mine diamond_ore.'
  ),
  'smelting fuel': (
    'Coal smelts 8 items per piece. A wooden plank or stick smelts '
    + '1.5 and 0.5 items respectively — they often burn out before '
    + 'iron finishes. Mine coal_ore before smelting iron.'
  ),
  'tool durability': (
    'Pickaxe durability: wooden 59, stone 131, iron 250, diamond 1561. '
    + 'An iron pickaxe will break partway through a long mining session; '
    + 'craft a spare or bring materials to craft one at depth.'
  ),
  'strip mining': (
    'After exhausting a diamond vein, move 30+ blocks horizontally '
    + 'before searching again — diamond veins do not cluster. Mining '
    + 'the same tunnel repeatedly wastes turns.'
  ),
  'underground supplies': (
    'There are no trees below y≈50. Bring spare logs and a '
    + 'crafting_table when descending so you can craft replacement '
    + 'tools without returning to the surface.'
  ),
  'crafting table': (
    '3×3 recipes (any pickaxe, furnace) require a placed '
    + 'crafting_table within reach. 2×2 recipes (planks, sticks, '
    + 'crafting_table itself) work from inventory.'
  ),
  'tuff': (
    'Tuff is a decorative deepslate-layer block. It drops only '
    + 'itself and has no crafting use for diamond mining. Tunnel '
    + "through it; don't farm it. Same for smooth_basalt and calcite "
    + '(amethyst-geode shells).'
  ),
  'go_near descent': (
    'To descend many y-levels quickly, call go_near with your '
    + 'current x/z and a deep y (e.g. y=-55). The pathfinder digs '
    + 'straight down in one action. Mining stone block-by-block to '
    + 'descend wastes turns and pickaxe durability.'
  ),
};

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'where', 'what',
  'how', 'in', 'of', 'for', 'to', 'i', 'my', 'me', 'and', 'or',
]);

function score(queryWords, topic, body) {
  // Topic-word hits dominate; body-word hits break ties. Prefix-match
  // so "smelt" hits "smelting", "break" hits "breaks", etc.
  const hits = (words) => {
    let n = 0;
    for (const q of queryWords) {
      for (const w of words) {
        if (q === w || (q.length > 3 && (q.startsWith(w) || w.startsWith(q)))) n++;
      }
    }
    return n;
  };
  return 10 * hits(topic.split(' ')) + hits([...new Set(body.toLowerCase().split(/\s+/))]);
}

export function lookup(query) {
  const qw = new Set(
    String(query || '').toLowerCase().split(/\s+/)
      .map((w) => w.replace(/[.,?!]+$/g, '').replace(/^[.,?!]+/g, ''))
      .filter((w) => w && !STOP.has(w)),
  );
  const topics = () => Object.keys(FACTS).sort().join(', ');
  if (qw.size === 0) return `Available topics: ${topics()}`;
  const ranked = Object.entries(FACTS)
    .map(([k, v]) => [score(qw, k, v), k, v])
    .sort((a, b) => b[0] - a[0]);
  const [bestScore, bestK, bestV] = ranked[0];
  if (bestScore > 0) return `[${bestK}] ${bestV}`;
  return `No entry for '${query}'. Available topics: ${topics()}`;
}

export const WIKI_TOOL = {
  name: 'lookup',
  description:
    'Look up a Minecraft fact. Pass a short question or topic like '
    + "'where do diamonds spawn', 'tool durability', 'smelting fuel', or "
    + "'tech tree'. Returns the best-matching wiki entry, or the list of "
    + 'available topics if nothing matches.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Question or topic to look up.' },
    },
    required: ['query'],
  },
};
