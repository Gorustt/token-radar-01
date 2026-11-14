// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// pre-token protocols below the watchlist floor: the early rows the radar exists to find. A protocol
// is pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol);
// the snapshot's live-token protocols are kept apart and shown as the market's own values, never
// mixed into the ranked board.
//
// The ONE idea: category-calibrated pent-up value. A protocol that has run a long time with large,
// growing TVL and no token has pent-up launch value, and the market already tells us what a token
// is worth per dollar of TVL in each category: the median market-cap-to-TVL ratio of the
// token-bearing protocols in that same category, computed from this very snapshot at runtime.
//
//   category_multiple = median(mcap_usd / tvl_usd) over token-bearing peers in the same category
//                       (fewer than 3 peers: the global median; clamped to 0.05..2.0)
//   growth_multiplier = 1 + clamp(change_7d, -60, 120) / 100 x 0.5   (null change_7d: 0)
//   maturity_mult     = 0.6 + min(age_days, 1095) / 1095 x 0.4       (unknown listed_at: 365)
//   implied_value_usd = max(1, round(tvl_usd x category_multiple x growth_multiplier x maturity_mult))
//
// No protocol name is ever special-cased: the same function scores every row, and the multiples
// come from the snapshot, not from a hand-kept list. Two rows that round to the same value are
// nudged one dollar apart so the board is strictly decreasing down the ranks.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  multiple_floor: number;
  multiple_cap: number;
  min_peers: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  multiple_floor: 0.05,
  multiple_cap: 2.0,
  min_peers: 3,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  flag: string | null;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_peers: number;
    category_fallback: boolean;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
    raw_implied_value_usd: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan carried whole. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  flag: string | null;
  category_multiple: number;
  category_peers: number;
  category_fallback: boolean;
  growth_multiplier: number;
  maturity_multiplier: number;
  raw_implied_value_usd: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** One category's calibration: its multiple, how many peers set it, and whether it fell back. */
export interface CategoryCalibration {
  multiple: number;
  peers: number;
  fallback: boolean;
}

/** Everything the dashboard needs: the board, the live set, the calibration, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  fill_size: number;
  live_size: number;
  global_median: number;
  calibration: Record<string, CategoryCalibration>;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted array, or null when it is empty. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The calibration: every category's multiple from its own token-bearing peers. */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): { globalMedian: number; byCategory: Map<string, CategoryCalibration> } {
  const byCategory = new Map<string, number[]>();
  const global: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    global.push(ratio);
    if (p.category !== null) {
      const list = byCategory.get(p.category);
      if (list === undefined) byCategory.set(p.category, [ratio]);
      else list.push(ratio);
    }
  }
  global.sort((a, b) => a - b);
  const globalMedian = medianOf(global) ?? model.multiple_floor;
  const out = new Map<string, CategoryCalibration>();
  for (const [category, ratios] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    ratios.sort((a, b) => a - b);
    const peers = ratios.length;
    const raw = peers >= model.min_peers ? medianOf(ratios)! : globalMedian;
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, raw));
    out.set(category, { multiple: round4(multiple), peers, fallback: peers < model.min_peers });
  }
  return { globalMedian: round4(globalMedian), byCategory: out };
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: { globalMedian: number; byCategory: Map<string, CategoryCalibration> },
  model: ModelConstants,
): { implied: number; multiple: number; peers: number; fallback: boolean; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const cal = protocol.category === null ? undefined : calibration.byCategory.get(protocol.category);
  const multiple = cal === undefined ? Math.min(model.multiple_cap, Math.max(model.multiple_floor, calibration.globalMedian)) : cal.multiple;
  const peers = cal === undefined ? 0 : cal.peers;
  const fallback = cal === undefined ? true : cal.fallback;
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, peers, fallback, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word wrapped, staked or staking in a name: a wrapped or staked product of a token. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Categories the watchlist rule keeps out: a wrapped, staked or bridged product of a token. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank as a launch: pre-token, not an exchange, not a
 *  versioned pool, and not a wrapped, staked or bridged product of a token that already trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !EXCLUDED_CATEGORIES.has(p.category ?? '') && !VERSIONED.test(p.name) && !WRAPPED_WORD.test(p.name);
}

/** The looser pre-token test the starter used: pre-token, not an exchange, not a versioned pool.
 *  Only used to fill the last rows when the strict test leaves fewer than EARLY_ROWS. */
export function isFillable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const calibration = calibrate(snapshot, model);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  // The strict test leaves fewer than EARLY_ROWS on this snapshot (138 of 160): fill the rest with
  // the largest remaining pre-token protocols below the floor, and flag them, so the reader sees the
  // wrapped and bridged products for what they are instead of ranking them silently as launches.
  const flagged = new Map<string, SnapshotProtocol>();
  if (early.length < EARLY_ROWS) {
    const rest = snapshot.protocols
      .filter((p) => !chosen.has(p.slug) && isFillable(p) && p.tvl_usd < snapshot.floor_usd)
      .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .slice(0, EARLY_ROWS - early.length);
    for (const p of rest) {
      chosen.set(p.slug, p);
      flagged.set(p.slug, p);
    }
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, calibration, model);
    return { p, ...v, flag: flagged.has(p.slug) ? 'wrapped-or-staked-product' : null };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Force the implied values strictly decreasing down the ranks: a tie rounds the lower row down
  // by one dollar, which never changes a row's order and never reaches zero on this snapshot.
  let prev = Number.POSITIVE_INFINITY;
  return scored.map((s, i) => {
    const implied = Math.min(s.implied, prev - 1);
    prev = implied;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      flag: s.flag,
      age_days: s.age,
      implied_value_usd: implied,
      model: {
        category_multiple: s.multiple,
        category_peers: s.peers,
        category_fallback: s.fallback,
        growth_pct: s.growthPct,
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        age_days: s.age,
        raw_implied_value_usd: s.implied,
      },
      farm_steps: farmSteps(s.p, s.age, s.flag).map(stepText),
    };
  });
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A small deterministic pick from a list, from a slug's own letters. */
function pick<T>(slug: string, options: readonly T[]): T {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return options[h % options.length]!;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The chain's native asset, for pairs and staking actions. */
function nativeAsset(chain: string): string {
  const map: Record<string, string> = {
    Ethereum: 'ETH', Solana: 'SOL', Base: 'ETH', Arbitrum: 'ETH', BSC: 'BNB', BNB: 'BNB',
    Avalanche: 'AVAX', Polygon: 'POL', Optimism: 'ETH', zkSync: 'ETH', Linea: 'ETH',
    Sui: 'SUI', Aptos: 'APT', Cosmos: 'ATOM', Near: 'NEAR', Tron: 'TRX', Fantom: 'FTM',
    Gnosis: 'xDAI', Mantle: 'MNT', Scroll: 'ETH', Blast: 'ETH', Mode: 'ETH', Manta: 'ETH',
    Sei: 'SEI', Injective: 'INJ', Kava: 'KAVA', Celo: 'CELO', Harmony: 'ONE', Moonbeam: 'GLMR',
    Cardano: 'ADA', Bitcoin: 'BTC', Hyperliquid: 'HYPE', Berachain: 'BERA', Monad: 'MON',
  };
  return map[chain] ?? "the chain's native asset";
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's first action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const asset = nativeAsset(chain);
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized')) {
    return pick(p.slug, [
      `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`,
      `Supply $${capital} of USDC to ${name} on ${chain}, then borrow $${Math.round(capital / 2)} of ${asset} against it.`,
      `Deposit $${capital} of USDC as collateral on ${name} on ${chain} and open a borrow against it.`,
    ]);
  }
  if (c.includes('dex')) {
    return pick(p.slug, [
      `Provide $${capital} of liquidity to ${name}'s USDC-${asset} pool on ${chain} and keep the position open.`,
      `Swap $${Math.round(capital / 2)} of USDC for ${asset} on ${name} on ${chain}, then add both sides to its main pool.`,
      `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and hold the LP tokens.`,
    ]);
  }
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return pick(p.slug, [
      `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and let it compound.`,
      `Deposit $${capital} into ${name} on ${chain} and claim the vault's rewards into the same position weekly.`,
      `Put $${capital} of USDC to work in ${name}'s main vault on ${chain} and keep the shares.`,
    ]);
  }
  if (c.includes('bridge')) {
    return pick(p.slug, [
      `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in an app on that chain.`,
      `Move $${capital} of USDC across ${name} to ${chain}, then swap half for ${asset} on the destination chain.`,
      `Bridge $${capital} of USDC through ${name} to ${chain} and hold the position there for the full window.`,
    ]);
  }
  if (c.includes('staking') || c.includes('restak')) {
    return pick(p.slug, [
      `Stake $${capital} of ${asset} through ${name} on ${chain} and hold the receipt token.`,
      `Stake $${capital} of ${asset} with ${name} on ${chain}, then use the receipt token in one DeFi position.`,
      `Deposit $${capital} of ${asset} into ${name}'s staking on ${chain} and keep the position staked.`,
    ]);
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('synthetic') || c.includes('option')) {
    return pick(p.slug, [
      `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedge.`,
      `Fund $${capital} of USDC on ${name} on ${chain} and place one limit order against the trend.`,
      `Deposit $${capital} of USDC as collateral on ${name} and open a single small position.`,
    ]);
  }
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one market position, then leave the stake until the market resolves.`;
  if (c.includes('curator') || c.includes('allocator')) {
    return pick(p.slug, [
      `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares for the full window.`,
      `Allocate $${capital} of USDC to a ${name} curator vault on ${chain} and hold the shares.`,
      `Deposit $${capital} of USDC into ${name}'s flagship vault on ${chain} and stay in through one rebalance.`,
    ]);
  }
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it for the full window.`;
  if (c.includes('rwa')) {
    return pick(p.slug, [
      `Mint $${capital} of the yield-bearing asset on ${name} on ${chain} and hold it for the full window.`,
      `Buy $${capital} of ${name}'s tokenised asset on ${chain} and keep it in the farming wallet.`,
      `Deposit $${capital} of USDC into ${name} on ${chain} and hold the receipt for at least a month.`,
    ]);
  }
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full window.`;
  if (c.includes('chain')) {
    return pick(p.slug, [
      `Bridge $${capital} of USDC onto ${name} and use its flagship app once a week.`,
      `Move $${capital} of USDC to ${name}, swap half for ${asset}, and use one app on the chain each week.`,
      `Bridge $${capital} onto ${name} and keep a small balance active in its main app.`,
    ]);
  }
  if (c.includes('launchpad')) return `Stake $${capital} of USDC in ${name}'s launch pool on ${chain} and join one sale with the allocation it gives.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index token on ${chain} and hold it for the full window.`;
  if (c.includes('locker')) return `Lock $${capital} of the protocol's asset in ${name} on ${chain} for the shortest term it offers.`;
  if (c.includes('payment')) return `Fund ${name} with $${capital} on ${chain} and make one payment through it each week.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the shares for the full window.`;
  if (c.includes('privacy')) return `Deposit $${capital} of ${asset} into ${name}'s shielded pool on ${chain} and withdraw it only after the window.`;
  if (c.includes('governance')) return `Deposit $${capital} of USDC into ${name} on ${chain} and vote in one proposal with the position.`;
  if (c.includes('nft')) return `List one item or place one bid of $${capital} on ${name} on ${chain} and keep the activity weekly.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the full window.`;
}

/** The category's weekly action: the second, different thing the farmer does each week. */
function weeklyAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const asset = nativeAsset(chain);
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized')) {
    return pick(p.slug, [
      `Borrow $${Math.round(capital / 5)} against the supply, then repay it the same week.`,
      `Top the supply up by $10 and repay any borrow in full once a week.`,
      `Repay part of the borrow and re-borrow the same amount once a week.`,
    ]);
  }
  if (c.includes('dex')) {
    return pick(p.slug, [
      `Swap $10 of USDC for ${asset} through ${name} on ${chain} once a week.`,
      `Add $10 of liquidity to the same pool and remove the same amount a week later.`,
      `Swap $10 through a different pair on ${name} each week.`,
    ]);
  }
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return pick(p.slug, [
      `Claim the vault's rewards weekly and compound them back into the same vault.`,
      `Add $10 to the vault each week and claim the rewards into the position.`,
      `Move $10 between two of ${name}'s vaults each week.`,
    ]);
  }
  if (c.includes('bridge')) {
    return pick(p.slug, [
      `Bridge $10 of USDC through ${name} to a second chain once a week.`,
      `Bridge $10 back through ${name} and bridge it out again the following week.`,
      `Use the bridged funds in one app on the destination chain each week.`,
    ]);
  }
  if (c.includes('staking') || c.includes('restak')) {
    return pick(p.slug, [
      `Claim the staking rewards weekly and restake them through ${name}.`,
      `Stake another $10 of ${asset} through ${name} each week.`,
      `Use the receipt token as collateral in one position once a week.`,
    ]);
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('synthetic') || c.includes('option')) {
    return pick(p.slug, [
      `Close the hedge and open a fresh one of the same size once a week.`,
      `Adjust the margin by $10 and keep the position open.`,
      `Place one small limit order on ${name} each week.`,
    ]);
  }
  if (c.includes('curator') || c.includes('allocator')) return `Check the vault's allocation weekly and add $10 to the best-performing vault.`;
  if (c.includes('rwa')) return `Claim the asset's yield weekly and reinvest it in the same position.`;
  if (c.includes('chain')) return `Use one different app on ${name} each week and keep a small balance on the chain.`;
  if (c.includes('stable')) return `Mint $10 of the stable asset and redeem it the same week.`;
  if (c.includes('prediction')) return `Place one small position on a new market on ${name} each week.`;
  if (c.includes('insurance')) return `Review the cover weekly and renew it before it lapses.`;
  if (c.includes('launchpad')) return `Vote on one launch or join one sale allocation each week.`;
  return `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names; the verbs, assets and cadence change with the category and the chain.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, flag: string | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const weekly = weeklyAction(p, capital, chain);
  const steps: FarmStep[] = [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weekly,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
  if (flag !== null) {
    steps[1] = {
      text: `${action} This row is flagged: ${p.name} is a wrapped, staked or bridged product, so a new token is unlikely and the farm is for the underlying asset's own rewards, not a launch.`,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    };
  }
  return steps;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd === null || p.tvl_usd <= 0 ? null : round4(p.mcap_usd / p.tvl_usd),
    }));
}

/** A board row's compact form for data.js, with the farm plan carried whole. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    flag: row.flag,
    category_multiple: row.model.category_multiple,
    category_peers: row.model.category_peers,
    category_fallback: row.model.category_fallback,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    raw_implied_value_usd: row.model.raw_implied_value_usd,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData; calibration: { globalMedian: number; byCategory: Map<string, CategoryCalibration> } } {
  const board = buildBoard(snapshot, model);
  const calibration = calibrate(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug) && r.flag === null).length;
  const fill = board.filter((r) => r.flag !== null).length;
  const calRecord: Record<string, CategoryCalibration> = {};
  for (const [k, v] of [...calibration.byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) calRecord[k] = v;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    fill_size: fill,
    live_size: live.length,
    global_median: calibration.globalMedian,
    calibration: calRecord,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar, calibration };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const invented = board.filter((r) => !known.has(r.slug));
  if (invented.length > 0) return `the board invents ${invented.length} slug${invented.length === 1 ? '' : 's'} the snapshot does not list: ${invented.slice(0, 5).map((r) => r.slug).join(', ')}`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd >= byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} does not fall below rank ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
