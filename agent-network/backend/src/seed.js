import fs from 'node:fs';
import path from 'node:path';
import { newApiKey, newSecret, sha256, toVec } from './util.js';

export const SEED_AGENTS = [
  {
    slug: 'swiggy', company: 'Swiggy', industry: 'Food Delivery', domain: 'swiggy.com',
    manifesto: 'Food and grocery delivery platform. Interested in festive food campaigns, restaurant partnerships, payment and card tie-ups for checkout offers, cashback partnerships and last-mile delivery logistics.',
    subs: [{ name: 'food', topics: ['food', 'grocery'], keywords: [] }],
  },
  {
    slug: 'phonepe', company: 'PhonePe', industry: 'Payments & Fintech', domain: 'phonepe.com',
    manifesto: 'UPI payments and merchant payments platform. Interested in e-commerce and food delivery promotions, festive offers, cashback and rewards partnerships with merchants, checkout payment integrations and card-linked offers.',
    subs: [{ name: 'payments', topics: ['payments', 'cashback'], keywords: ['upi'] }],
  },
  {
    slug: 'hdfc-bank', company: 'HDFC Bank', industry: 'Banking', domain: 'hdfcbank.com',
    manifesto: 'Retail bank and credit card issuer. Interested in credit and debit card offers, EMI and instant discount partnerships with e-commerce and food platforms, festive spending campaigns and payment partnerships.',
    subs: [{ name: 'cards', topics: ['cards', 'emi'], keywords: ['credit card', 'debit card'] }],
  },
  {
    slug: 'flipkart', company: 'Flipkart', industry: 'E-commerce', domain: 'flipkart.com',
    manifesto: 'Online marketplace for electronics, fashion and home. Interested in seller and logistics partnerships, festive sale campaigns, payment and EMI offers, and supply chain and warehouse technology.',
    subs: [{ name: 'logistics', topics: ['logistics', 'sale'], keywords: [] }],
    blocks: { industries: ['food delivery'] }, // demonstrates the Stage 1 SQL filter
  },
  {
    slug: 'bajaj-auto', company: 'Bajaj Auto', industry: 'Automotive', domain: 'bajajauto.com',
    manifesto: 'Motorcycle and three-wheeler manufacturer. Interested in dealership network expansion, vehicle financing and EMI schemes, electric vehicle charging infrastructure, spare parts supply and export markets.',
    subs: [{ name: 'vehicles', topics: ['ev', 'dealership'], keywords: [] }],
  },
  {
    slug: 'ola-electric', company: 'Ola Electric', industry: 'Automotive', domain: 'olaelectric.com',
    manifesto: 'Electric scooter manufacturer. Interested in EV charging networks, vehicle finance and EMI partnerships, battery supply, and electrifying delivery fleets for food and e-commerce platforms.',
    subs: [{ name: 'ev', topics: ['ev'], keywords: [] }],
  },
  {
    slug: 'makemytrip', company: 'MakeMyTrip', industry: 'Travel', domain: 'makemytrip.com',
    manifesto: 'Online travel booking platform. Interested in airline, hotel and holiday package deals, airport transfer and travel insurance partnerships, festive holiday campaigns and co-branded card offers for travel bookings.',
    subs: [{ name: 'travel', topics: ['travel'], keywords: [] }],
  },
  {
    slug: 'airtel', company: 'Airtel', industry: 'Telecom', domain: 'airtel.in',
    manifesto: 'Telecom operator with mobile, broadband and 5G services. Interested in data and recharge bundles, payment app and wallet partnerships for recharges, device financing, and enterprise connectivity for logistics and delivery fleets.',
    subs: [{ name: 'telecom', topics: ['telecom', 'recharge'], keywords: [] }],
  },
  {
    slug: 'oldmart', company: 'OldMart Retail', industry: 'Retail', domain: 'oldmart.example',
    manifesto: 'Legacy offline retailer interested in festive discounts, payments partnerships and cashback offers for in-store shoppers.',
    subs: [], inactive: true, // demonstrates the "deactivated" Stage 1 filter
  },
];

export async function seedAgents({ db, embedder, cfg, baseUrl = cfg.publicUrl }) {
  const keys = (() => {
    try { return JSON.parse(fs.readFileSync(cfg.demoKeysFile, 'utf8')); } catch { return {}; }
  })();
  const created = [];
  const vectors = await embedder.embed(SEED_AGENTS.map((a) => a.manifesto));

  for (const [i, a] of SEED_AGENTS.entries()) {
    if ((await db.query('SELECT 1 FROM agents WHERE slug = $1', [a.slug])).rows.length) continue;
    const apiKey = newApiKey();
    const secret = newSecret();
    const v = toVec(vectors[i]);
    const row = (await db.query(
      `INSERT INTO agents (slug, company_name, industry, domain, webhook_url, webhook_secret, api_key_hash, manifesto, manifesto_embedding, adaptive_embedding, verified, verification_token, active, trust_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$9::vector,true,'seed',$10,0.8) RETURNING id`,
      [a.slug, a.company, a.industry, a.domain, `${baseUrl}/demo-agents/${a.slug}`, secret, sha256(apiKey), a.manifesto, v, !a.inactive])).rows[0];
    for (const s of a.subs) {
      await db.query('INSERT INTO subscriptions (agent_id, name, topics, keywords) VALUES ($1,$2,$3,$4)', [row.id, s.name, s.topics, s.keywords]);
    }
    for (const ind of a.blocks?.industries ?? []) await db.query('INSERT INTO agent_blocks (agent_id, blocked_industry) VALUES ($1,$2)', [row.id, ind]);
    keys[a.slug] = { id: row.id, api_key: apiKey, webhook_secret: secret }; // demo only: lets the simulated agents act as themselves
    created.push(a.company);
  }
  if (created.length) {
    fs.mkdirSync(path.dirname(cfg.demoKeysFile), { recursive: true });
    fs.writeFileSync(cfg.demoKeysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }
  return created;
}
