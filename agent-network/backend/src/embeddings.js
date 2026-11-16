import { normalize } from './util.js';

const STOP = new Set(
  'a an the and or of to in on for with at by from is are was were be been this that these those it its our we you your their as into over up per than then so such via not no yes can will may all any each more most about during after before between across within without also new get got just only very much many how what when where which who whom why'.split(' '),
);

export function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem).filter((t) => t.length > 1 && !STOP.has(t));
}

const LEXICON = {
  food_delivery: 'food restaurant meal grocery dining dine swiggy zomato instamart kitchen order delivery:0.6 takeaway cuisine',
  festive: 'diwali festive festival holi eid christmas navratri dussehra season celebration sale:0.7 deepavali onam pongal',
  offers: 'offer discount deal promo promotion coupon voucher cashback:0.7 reward off:0.6 flat',
  payments: 'payment pay upi wallet checkout transaction qr bhim phonepe gpay paytm cashback:0.7 settlement',
  banking: 'bank banking card credit debit emi loan hdfc account netbanking finance:0.7 lender',
  ecommerce: 'ecommerce commerce marketplace shopping retail seller catalog flipkart amazon product merchant',
  logistics: 'logistics shipping courier warehouse supply chain fulfilment lastmile delivery:0.5 fleet',
  automotive: 'motorcycle bike vehicle auto automotive scooter wheeler car dealer dealership showroom spare part bajaj engine',
  electric_mobility: 'ev electric charging charger battery e-vehicle range',
  auto_finance: 'finance:0.5 loan:0.5 emi:0.4 vehicle:0.4 financing',
  travel: 'travel flight airline hotel holiday vacation tour booking trip airport makemytrip tourism stay',
  telecom: 'telecom mobile broadband 5g sim recharge airtel network:0.5 data:0.4',
  fashion: 'fashion clothing apparel lifestyle footwear',
  electronics: 'electronics laptop smartphone phone gadget appliance',
  tech: 'ai software cloud api developer saas platform startup',
  health: 'health hospital pharmacy wellness fitness clinic',
};

const CONCEPTS = Object.keys(LEXICON);
const WORD_TO_CONCEPTS = new Map();
CONCEPTS.forEach((c, ci) => {
  for (const entry of LEXICON[c].split(' ')) {
    const [word, w] = entry.split(':');
    const key = stem(word);
    if (!WORD_TO_CONCEPTS.has(key)) WORD_TO_CONCEPTS.set(key, []);
    WORD_TO_CONCEPTS.get(key).push({ ci, w: w ? Number(w) : 1 });
  }
});

export const LITE_DIMS = 96;
const HASH_DIMS = LITE_DIMS - CONCEPTS.length;

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function liteEmbed(text) {
  const v = new Float64Array(LITE_DIMS);
  const concept = new Float64Array(CONCEPTS.length);
  for (const tok of tokenize(text)) {
    for (const { ci, w } of WORD_TO_CONCEPTS.get(tok) ?? []) concept[ci] += w;
    v[CONCEPTS.length + (fnv(tok) % HASH_DIMS)] += 1;
  }
  for (let i = 0; i < CONCEPTS.length; i++) v[i] = Math.sqrt(concept[i]);
  for (let i = CONCEPTS.length; i < LITE_DIMS; i++) v[i] = 0.3 * Math.sqrt(v[i]);
  return normalize(v);
}

export async function createEmbedder(cfg, fetchImpl = fetch) {
  if (cfg.provider === 'lite') {
    return { name: 'lite-concept-lexicon', dims: LITE_DIMS, calibrated: 'lite', async embed(texts) { return texts.map(liteEmbed); } };
  }
  const headers = { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) };
  const embed = async (texts) => {
    const res = await fetchImpl(`${cfg.baseUrl}/embeddings`, {
      method: 'POST', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: cfg.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Embedding request failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.data.map((d) => normalize(d.embedding));
  };
  const dims = (await embed(['dimension probe']))[0].length; // detect the model's dimension
  return { name: `${cfg.model} @ ${new URL(cfg.baseUrl).host}`, dims, calibrated: 'model', embed };
}
