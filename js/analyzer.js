// Port of the Flask app's analyzer.py. Pure functions, no DOM, so it runs under
// Node for tests as well as in the browser.
//
// Stored transactions keep only what the bank file said (date, description,
// amount, balance, the card's own category). Merchant and category are derived
// on every load, so a rule added today recategorizes last year's uploads too.

import { parseCsv } from './csv.js';
import { Categorizer } from './categorizer.js';

// ── Category mapping ───────────────────────────────────────────────────────────

export const CC_CATEGORY_MAP = {
  'merchandise':         'Shopping',
  'other services':      'Other', // barbers, museums, parks, Prime: the names decide (BRAND_RULES)
  'phone/cable':         'Utilities & Bills',
  'internet':            'Subscriptions', // where a card files Steam, a domain, a streaming app
  'dining/restaurant':   'Dining',
  'automotive':          'Transportation',
  'other travel':        'Transportation', // the card's word for rides, tolls, parking
  'car rental':          'Travel',
  'groceries':           'Groceries',
  'grocery':             'Groceries',
  'supermarkets':        'Groceries',
  'gas/automotive':      'Transportation',
  'health care':         'Health',
  'entertainment':       'Entertainment',
  'education':           'Education',
  'travel':              'Travel',
  'payment/credit':      'Payment',
  'fees/interest':       'Fees',
  'lodging':             'Travel',
  'airfare':             'Travel',
  'utilities':           'Utilities & Bills',
  'fee/interest charge': 'Fees',
  'dining':              'Dining',
  'gas':                 'Transportation',
  'insurance':           'Insurance',
  'professional services': 'Other',
};

// Trips: lodging, rental cars, flights and the sites that book them. Matched on
// every row, card and bank, CSV and Plaid, ahead of the category the card or
// Plaid gave it: a card files a rental car under its own heading, Plaid may
// file a stay as a general service, and a booking through Capital One Travel
// is a trip whatever the card calls it. Names that could be something else
// carry a second word: 'delta air' (Delta Dental), 'alamo rent' (the Alamo
// Drafthouse), 'avis rent' (Avista, a utility), 'hopper.com' (grasshopper).
export const TRAVEL_KEYWORDS = [
  // stays
  'airbnb', 'vrbo', 'homeaway', 'booking.com', 'hotels.com', 'expedia', 'priceline', 'hotwire',
  'kayak.com', 'hopper.com', 'travelocity', 'orbitz', 'agoda', 'trivago', 'marriott', 'hilton', 'hyatt',
  'westin', 'sheraton', 'courtyard by', 'residence inn', 'fairfield inn', 'springhill suites',
  'holiday inn', 'hampton inn', 'embassy suites', 'doubletree', 'best western', 'wyndham',
  'la quinta', 'motel 6', 'red roof', 'comfort inn', 'ihg', 'hotel', 'resort', 'hostel',
  // cars
  'sixt', 'enterprise rent', 'enterprise car', 'enterprise.com', 'hertz', 'avis rent', 'avis car', 'avis.com', 'avis budget', 'budget rent',
  'budget car', 'national car', 'alamo rent', 'alamo car', 'goalamo', 'thrifty car', 'dollar rent', 'turo', 'zipcar', 'car rental',
  'rent-a-car', 'rent a car',
  // flights and trains
  'delta air', 'united air', 'united.com', 'american air', 'southwest air', 'jetblue', 'spirit air',
  'frontier air', 'alaska air', 'allegiant', 'sun country', 'breeze air', 'air canada',
  'british airways', 'lufthansa', 'air france', 'klm', 'airline', 'airways', 'amtrak',
  'global entry', 'tsa precheck',
  // Capital One Travel: flights (COTFLT), hotels (COTHTL), cars and the rest
  // (COT*FLT, COT*HTL, COT*LCH on a card export; COTFLT where the * is stripped)
  'capital one travel', 'capitalone travel', 'cap one travel', 'c1 travel', 'capital 1 lounge',
  'cotflt', 'cothtl', 'cotcar', 'cotrnt', /(^|[^a-z0-9])cot\*/,
];
export const isTravel = text => {
  const d = String(text || '').toLowerCase();
  return TRAVEL_KEYWORDS.some(k => hasKeyword(d, k));
};

// Grocery stores and grocery delivery, by name, on every row like travel above:
// a card can file a supermarket under Merchandise, and a bank account has no
// category at all. Stores that sell everything (Target, Walmart, Costco) stay
// Shopping. The pump or pharmacy at a grocery store is not groceries
// (NOT_GROCERY), and is left to the other rules.
export const GROCERY_KEYWORDS = [
  'trader joe', 'whole foods', 'wholefds', 'safeway', 'kroger', 'aldi', 'lidl', 'publix',
  /(^|[^a-z0-9])h ?-?mart\b/, 'fred-meyer', 'new seasons', 'manzanita fresh', 'harvest foods',
  'migros', /(^|[^a-z0-9])coop(\b|-)/, 'carrefour', 'crf mkt', 'esselunga', 'conad', 'rewe',
  'edeka', 'tesco', 'sainsbury', 'loblaws', 'save-on-foods', 'no frills',
  'giant', 'harris teeter', 'wegmans', 'food lion', 'sprouts', 'h-e-b', 'heb ', 'meijer', 'hy-vee',
  'stop & shop', 'stop and shop', 'shoprite', 'albertsons', 'vons', 'ralphs', 'fred meyer',
  'winco', 'piggly wiggly', 'weis market', 'market basket', 'hannaford', 'the fresh market',
  'fresh thyme', 'earth fare', 'natural grocers', 'mom s organic', 'moms organic',
  'lotte plaza', 'patel brothers', '99 ranch', 'grocery outlet', 'save a lot', 'food 4 less',
  'smart & final', 'winn-dixie', 'winn dixie', 'ingles market', 'bi-lo', 'shoppers food', 'amazon fresh',
  'instacart', 'shipt', 'grocery', 'supermarket',
];
const NOT_GROCERY = /fuel|gasoline|\bgas\b|pharmacy|\brx\b/i;
export const isGrocery = text => {
  const d = String(text || '').toLowerCase();
  return !NOT_GROCERY.test(d) && GROCERY_KEYWORDS.some(k => hasKeyword(d, k));
};

// Brands whose name says what they are, whichever account paid them. They
// decide on card rows too (see baseCategory), where otherwise the card's own
// category would: a card files a streaming service under "Other Services" or
// "Entertainment", a pharmacy under "Merchandise", and Plaid and a CSV export
// disagree about the same charge. Only names that cannot be much else are
// here; the generic words ('coffee', 'parking') stay in the bank-only rules
// below. Stores that sell everything are left out on purpose: a card that says
// a Walmart trip was groceries knows better than the name.
// [keywords, category, unless]
export const BRAND_RULES = [
  [['uber eats', 'ubereats', 'uber *eats', 'doordash', 'dd *doordash', 'grubhub', 'seamless',
    'postmates', 'tst*', 'starbucks', 'dunkin', 'chipotle', 'mcdonald', 'chick-fil-a', 'panera',
    'sweetgreen', 'cava ', 'five guys', 'shake shack', 'wendy s', 'wendys', 'taco bell', 'burger king',
    'popeyes', 'kfc', 'domino s', 'dominos', 'papa john', 'pizza hut', 'jersey mike', 'jimmy john',
    'firehouse sub', 'wingstop', 'panda express', 'qdoba', 'potbelly', 'dutch bros', 'tim hortons',
    'buffalo wild', 'olive garden', 'applebee', 'chili s', 'ihop', 'denny s', 'waffle house',
    'cracker barrel', 'texas roadhouse', 'cheesecake factory', 'in-n-out', 'whataburger',
    'arby s', 'zaxby', 'raising cane', 'bojangles', 'cook out', 'pret a manger', 'blue bottle',
    'peet s coffee', 'caribou coffee'], 'Dining'],
  [['netflix', 'spotify', 'hulu', 'disneyplus', 'disney plus', 'hbo max', 'max.com', 'peacock',
    'paramount+', 'paramountplus', 'youtube premium', 'youtubepremium', 'youtube tv', 'apple.com/bill',
    'itunes', 'icloud', 'apple music', 'amazon prime', 'prime video', 'primevideo', 'audible',
    'kindle unl', 'sling.com', 'sling tv', 'crunchyroll', 'siriusxm', 'sirius xm', 'nytimes',
    'ny times', 'wsj', 'washpost', 'washington post', 'patreon', 'dropbox', 'adobe', 'microsoft 365',
    'google storage', 'google one', 'openai', 'chatgpt', 'claude.ai', 'anthropic', 'github',
    'notion.so', '1password', 'lastpass', 'nordvpn', 'expressvpn', 'duolingo', 'headspace',
    'calm.com', 'nba league pass', 'porkbun', 'tidal.com', 'fox one', 'foxone', 'linkedinpre',
    'linkedin premium', 'playstation', 'nintendo', 'xbox', 'steamgames',
    'steampowered', 'steam purchase'], 'Subscriptions'],
  [['uber trip', 'uber *trip', 'lyft', 'wmata', 'smartrip', 'ez pass', 'e-zpass', 'ezpass',
    'e zpass', 'parkmobile', 'spothero', 'laz parking', 'shell oil', 'shell service', 'exxon',
    'mobil ', 'chevron', 'sunoco', 'valero', 'citgo', 'marathon petro', 'bp#', 'costco gas',
    'sams club fuel', 'sam s club fuel', 'bjs gas', 'bj s gas', 'tesla supercharger', 'chargepoint',
    'electrify america', 'evgo', 'jiffy lube', 'valvoline', 'pep boys', 'autozone', 'advance auto',
    'o reilly auto', 'discount tire', 'dmv', 'dept of motor'], 'Transportation'],
  [['dominion energy', 'dominion va', 'pepco', 'bge', 'novec', 'washington gas', 'comcast',
    'xfinity', 'verizon', 'fios', 'at&t', 'att*', 't-mobile', 'tmobile', 'spectrum', 'cox comm',
    'google fi', 'mint mobile', 'visible service', 'visible wireless', 'cricket wireless',
    'metropcs', 'metro by t', 'fairfax water', 'loudoun water', 'dc water', 'waste management',
    'republic services'], 'Utilities & Bills'],
  [['geico', 'allstate', 'state farm', 'progressive', 'prog universal', 'liberty mutual',
    'nationwide', 'travelers ins', 'farmers ins', 'lemonade', 'root insurance', 'metlife', 'aflac',
    'ins prem', 'insurance'], 'Insurance'],
  [['cvs', 'walgreens', 'rite aid', 'pharmacy', 'quest diag', 'labcorp', 'urgent care', 'kaiser',
    'one medical', 'zocdoc', 'minuteclinic', 'lenscrafters', 'warby parker', 'planet fitness',
    'orangetheory', 'equinox', 'la fitness', 'crunch fitness', 'gold s gym', 'lifetime fitness',
    'f45', 'solidcore', 'classpass', 'peloton', 'dental', 'dentist', 'orthodont', 'dermatolog',
    'pediatric', 'hospital', 'medical', 'fitness', /(^|[^a-z0-9])gym\b/], 'Health'],
  [['amc theatre', 'amc theater', 'regal cinema', 'cinemark', 'alamo drafthouse', 'fandango',
    'ticketmaster', 'stubhub', 'seatgeek', 'eventbrite', 'live nation', 'topgolf', 'bowlero',
    'dave & buster', 'dave and buster', 'museum', 'imax', 'planetarium', 'japanese gard',
    'botanical gard', 'arboretum', 'aquarium'], 'Entertainment'],
  [['tuition', 'coursera', 'udemy', 'chegg', 'masterclass'], 'Education'],
];
export function brandCategory(text) {
  const d = String(text || '').toLowerCase();
  for (const [kws, cat, unless] of BRAND_RULES) if (kws.some(k => hasKeyword(d, k)) && !unless?.test(d)) return cat;
  return null;
}

// Card categories too broad to trust over a merchant's name. A Capital One card
// files supermarkets as Merchandise, streaming as Phone/Cable or Internet,
// barbers and museums as Other Services, gyms as Entertainment.
const VAGUE_CARD = new Set(['Shopping', 'Other', 'Subscriptions', 'Utilities & Bills', 'Entertainment']);
// A café or bakery the card calls Merchandise.
const CARD_FOOD = ['coffee', 'bakery', 'cafe', 'caffe', 'restaurant', 'ristorante', 'trattoria',
  'pizza', 'sushi', 'bistro', 'brewing', 'tavern', 'doughnut', 'donut'];
const cardFood = text => (CARD_FOOD.some(k => hasKeyword(String(text).toLowerCase(), k)) ? 'Dining' : null);

// A keyword is matched anywhere in the text when it is long, or at the start of
// a word when short (see hasKeyword); a RegExp is used as it is.
// [keywords, category, is_transfer, unless]
export const CHECKING_KEYWORD_RULES = [
  [['payroll', 'salary', 'direct dep', 'federal home loa', 'biweekly'], 'Income', false],
  [['venmo cashout', 'zelle deposit', 'zelle money received', 'zelle from', 'cashapp deposit',
    'cash app cashout'], 'Income', false],
  // A tax refund is withholding coming back: it counts as income, as the pay did.
  [['irs treas', 'tax ref', 'taxrfd'], 'Income', false],
  // 360 Checking pays interest too.
  [['monthly interest paid', 'interest paid'], 'Interest Income', false],

  [['360 performance savings', '360 savings', '360 money market', '360 checking',
    'transfer to savings', 'transfer from savings'], 'Savings Transfer', true],
  // Money moved to your own investment or retirement accounts is kept, not
  // spent, and money taken out of them is not earned.
  [['vanguard', 'fidelity', 'schwab', 'robinhood', 'coinbase', 'betterment', 'wealthfront',
    'acorns', 'm1 finance', 'etrade', 'e*trade', 'webull', 'merrill', 'stash invest', 'public.com',
    'empower retirement', 'tiaa', 'fundrise', 'treasurydirect', 'treasury direct', 'ally invest',
    'sofi invest', 'interactive brokers', 'ibkr'], 'Investment Transfer', true],
  [['capital one mobile pmt', 'capital one crcardpmt', 'bk of amer', 'bank of amer', 'bofa',
    'chase pmt', 'chase credit crd', 'credit card pmt', 'citi card', 'citi autopay', 'discover pmt',
    'discover e-payment', 'amex epayment', 'american express', 'applecard', 'apple card',
    'gs bank', 'synchrony', 'barclaycard', 'wells fargo card', 'usaa credit', 'usaa cc'], 'Credit Card Payment', true],
  [['student loan', 'loan pmt', 'sallie mae', 'navient', 'nelnet', 'mohela', 'aidvantage',
    'first community credit', 'community credit union', 'auto loan', 'car loan', 'toyota financial',
    'toyota motor cr', 'honda finance', 'american honda', 'ally auto', 'tesla finance',
    'preauthorized withdrawal to first'], 'Loan Payment', true],
  // PayPal alone is usually a purchase ("PAYPAL *NETFLIX"), filed by the rules
  // below; only a transfer to or from a person is a P2P move.
  [['venmo payment', 'zelle payment', 'zelle money sent', 'zelle to', 'cashapp pay', 'cash app*',
    'apple cash', 'paypal inst xfer', 'paypal transfer', 'paypal xfer'], 'P2P Transfer', true],

  // Ahead of the rest: 'rent' (Housing) is in "RENT-A-CAR", 'amazon' could be
  // a booking, and Uber or parking on a trip is still a ride.
  [TRAVEL_KEYWORDS, 'Travel', false],
  // Before Shopping, which would take "AMAZON FRESH".
  [GROCERY_KEYWORDS, 'Groceries', false, NOT_GROCERY],
  // Before Shopping too: "AMAZON PRIME" is a subscription, "COSTCO GAS" fuel.
  ...BRAND_RULES.map(([kws, cat, unless]) => [kws, cat, false, unless]),

  // Pay-later plans: the payments are the only trace of what was bought.
  [['amazon', 'ebay', 'etsy', 'walmart', 'target', 'best buy', 'costco', 'oregon kicks',
    'apple store', 'apple online', 'home depot', 'lowe s', 'lowes', 'ikea', 'tj maxx', 'tjmaxx',
    'marshalls', 'homegoods', 'old navy', 'kohl s', 'macy s', 'nordstrom', 'sephora', 'ulta',
    'rent the runway', 'renttherunway',
    'affirm', 'klarna', 'afterpay', 'sezzle', 'paypal'], 'Shopping', false],
  [['uber', 'metro', 'transit', 'parking', 'shell', 'bp ', 'wawa gas', 'marathon', 'sheetz',
    'speedway', 'circle k', 'royal farms', 'gas station'], 'Transportation', false],
  [['coffee', 'restaurant', 'pizza', 'sushi', 'burger', 'taco', 'subway', 'grill', 'bistro',
    'cafe', 'kitchen', 'diner', 'bakery', 'brewing', 'tavern', 'pub '], 'Dining', false],
  [['dominion', 'electric', 'water bill', 'gas bill', 'billpay', 'fairfax va coun', 'pp-echeck'], 'Utilities & Bills', false],
  [[/\brent\b/, 'mortgage', 'hoa', 'property', 'rentcafe', 'bilt rent', 'bilt rewards', 'yardi', 'appfolio', 'entrata',
    'clickpay', 'apartment'], 'Housing', false],
  [['usaa'], 'Insurance', false],
  [['doctor', 'health', 'gym', 'fitness'], 'Health', false],
  [['overdraft', 'nsf fee', 'atm fee', 'foreign transaction fee', 'service fee', 'late fee',
    'annual fee'], 'Fees', false],
  // Cash is spent, on what nobody knows.
  [['atm withdrawal', 'atm cash', 'cash withdrawal'], 'Other', false],
];

export const SAVINGS_KEYWORD_RULES = [
  [['monthly interest', 'interest paid', 'apy interest'], 'Interest Income', false],
  [['360 checking', '360 performance savings', '360 savings', '360 money market'], 'Savings Transfer', true],
  [['dept education', 'student ln', 'dept of education', 'student loan',
    'sallie mae', 'navient'], 'Loan Payment', true],
];

export const TRANSFER_CATEGORIES = new Set([
  'Savings Transfer', 'Investment Transfer', 'Credit Card Payment', 'Loan Payment', 'P2P Transfer', 'Payment',
]);

// A deposit filed under one of these is money coming back, not money earned.
const NOT_SPENDING = new Set(['Income', 'Interest Income', 'Other']);
const REFUND_RE = /refund|reversal|return|rebate|credit adj/i;

const CARD_PAYMENT_RE = /\bpayment\b|\bpymt\b|\bpmt\b|auto ?pay|thank you/i;

// Short keywords must start a word: 'rent' is not in "CURRENT", 'hoa' not in "WHOA".
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = new Map();
function hasKeyword(text, kw) {
  if (kw instanceof RegExp) return kw.test(text);
  if (kw.trim().length > 4) return text.includes(kw);
  let re = matchers.get(kw);
  if (!re) matchers.set(kw, re = new RegExp('(^|[^a-z0-9])' + escRe(kw)));
  return re.test(text);
}

export const ALL_CATS = [
  'Income', 'Shopping', 'Subscriptions', 'Transportation', 'Groceries',
  'Dining', 'Utilities & Bills', 'Housing', 'Insurance', 'Health',
  'Travel', 'Entertainment', 'Education', 'Fees', 'Interest Income', 'Other',
];

export function seedExamples() {
  const ex = [];
  for (const [kws, cat] of CHECKING_KEYWORD_RULES) for (const k of kws) if (typeof k === 'string') ex.push([k, cat]);
  for (const [kws, cat] of SAVINGS_KEYWORD_RULES) for (const k of kws) ex.push([k, cat]);
  for (const [raw, cat] of Object.entries(CC_CATEGORY_MAP)) ex.push([raw, cat]);
  return ex;
}

// Plaid files every transaction under a "personal finance category": a primary
// group and a detailed one. Stored as "PRIMARY|DETAILED"; the detailed entry
// wins where it is listed here.
export const PLAID_CATEGORY_MAP = {
  INCOME: 'Income',
  INCOME_INTEREST_EARNED: 'Interest Income',
  TRANSFER_IN: 'P2P Transfer',
  TRANSFER_IN_DEPOSIT: 'Income',
  TRANSFER_IN_ACCOUNT_TRANSFER: 'Savings Transfer',
  TRANSFER_IN_SAVINGS: 'Savings Transfer',
  TRANSFER_OUT: 'P2P Transfer',
  TRANSFER_OUT_ACCOUNT_TRANSFER: 'Savings Transfer',
  TRANSFER_OUT_SAVINGS: 'Savings Transfer',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'Investment Transfer',
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'Investment Transfer',
  TRANSFER_OUT_WITHDRAWAL: 'Other', // cash from an ATM is spent, on what nobody knows
  LOAN_PAYMENTS: 'Loan Payment',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Credit Card Payment',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'Housing',
  BANK_FEES: 'Fees',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Dining',
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Shopping',
  MEDICAL: 'Health',
  PERSONAL_CARE: 'Health',
  GENERAL_SERVICES: 'Other',
  GENERAL_SERVICES_INSURANCE: 'Insurance',
  GENERAL_SERVICES_EDUCATION: 'Education',
  GENERAL_SERVICES_AUTOMOTIVE: 'Transportation',
  GOVERNMENT_AND_NON_PROFIT: 'Other',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Utilities & Bills',
  RENT_AND_UTILITIES_RENT: 'Housing',
};

export function plaidCategory(raw) {
  const [primary, detailed] = String(raw || '').split('|');
  return PLAID_CATEGORY_MAP[detailed] || PLAID_CATEGORY_MAP[primary] || null;
}

// ── Merchant normalisation ─────────────────────────────────────────────────────

const PREFIX_RE  = /^(withdrawal from|deposit from|withdrawal to|deposit to|transfer to|transfer from)\s+/i;
const CLEANUP_RE = /[X]+\d+|\d{6,}|[*#@]/gi;

export function normalizeMerchant(description) {
  let s = String(description).trim().replace(PREFIX_RE, '');
  s = s.replace(CLEANUP_RE, '').trim();
  return s.split(/\s+/).filter(Boolean).slice(0, 4).join(' ').trim();
}

// Python's str.title(): capitalise each run of letters, lowercase the rest.
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

export function categorizeCC(raw) {
  const r = raw.trim();
  return CC_CATEGORY_MAP[r.toLowerCase()] || titleCase(r);
}

// ── Parsing ────────────────────────────────────────────────────────────────────

export function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return iso(y, +m[1], +m[2]);
  }
  const d = new Date(s);
  return isNaN(d) ? null : iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseAmount(v) {
  if (v == null) return NaN;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '') return NaN;
  return Number(s);
}

export function detectFormat(headers) {
  const cols = new Set(headers.map(h => h.trim().toLowerCase()));
  if (cols.has('transaction type') && cols.has('transaction amount')) return 'bank';
  if (cols.has('debit') && cols.has('credit') && cols.has('card no.')) return 'credit_card';
  return 'unknown';
}

// Checking and savings exports have the same columns. In order of trust: what
// this account was last time (`known`, last four digits -> kind), the file name,
// then the text of the rows. The first matters most: a short savings export may
// hold nothing but an interest line, and filing it as a second checking account
// would count its balance twice.
function bankKind(rows, last4, { known = {}, name = '' } = {}, single = true) {
  if (known[last4]) return known[last4];
  if (single && /sav|money ?market/i.test(name)) return 'savings';
  if (single && /check/i.test(name)) return 'checking';
  const text = rows.map(r => (r['Transaction Description'] || '').toLowerCase()).join(' ');
  // Savings receives deposits FROM checking; checking only sends TO savings.
  if (text.includes('from 360 checking') || text.includes('to 360 checking')) return 'savings';
  return 'checking';
}

// The accounts already stored, as last four digits -> kind.
export function knownAccounts(stored) {
  const known = {};
  for (const t of stored) {
    if (t.kind !== 'checking' && t.kind !== 'savings') continue;
    const k = t.account.slice(-4);
    if (known[k] !== 'savings') known[k] = t.kind;
  }
  return known;
}

// One file -> stored transactions. `ord` orders rows within a day (bank exports
// list newest first). Accounts and cards are read per row: one card export can
// hold several card numbers, and which comes first changes between exports.
export function parseFile(text, hints = {}) {
  const { headers, rows } = parseCsv(text);
  let format = detectFormat(headers);
  const out = [];
  if (format === 'bank') {
    const byAcct = new Map();
    for (const r of rows) {
      const k = String(r['Account Number'] || '').trim().slice(-4);
      if (!byAcct.has(k)) byAcct.set(k, []);
      byAcct.get(k).push(r);
    }
    const kinds = new Map([...byAcct].map(([k, list]) => [k, bankKind(list, k, hints, byAcct.size === 1)]));
    format = kinds.values().next().value || 'checking';
    rows.forEach((r, i) => {
      const date = parseDate(r['Transaction Date']);
      const amount = parseAmount(r['Transaction Amount']);
      if (!date || isNaN(amount)) return;
      const bal = parseAmount(r['Balance']);
      const last4 = String(r['Account Number'] || '').trim().slice(-4);
      const kind = kinds.get(last4);
      const credit = String(r['Transaction Type']).trim().toLowerCase() === 'credit';
      out.push({
        date,
        description: String(r['Transaction Description'] || '').trim(),
        kind,
        account: `${kind === 'savings' ? 'Savings' : 'Checking'} ...${last4}`,
        amount: round2(credit ? amount : -amount),
        balance: isNaN(bal) ? null : bal,
        raw_category: '',
        ord: rows.length - i,
      });
    });
  } else if (format === 'credit_card') {
    rows.forEach((r, i) => {
      const date = parseDate(r['Transaction Date']) || parseDate(r['Posted Date']);
      if (!date) return;
      const debit = parseAmount(r['Debit']);
      const credit = parseAmount(r['Credit']);
      if (isNaN(debit) && isNaN(credit)) return;
      out.push({
        date,
        description: String(r['Description'] || '').trim(),
        kind: 'credit_card',
        account: `Credit Card ...${String(r['Card No.'] || '').trim().slice(-4)}`,
        amount: round2((isNaN(credit) ? 0 : credit) - (isNaN(debit) ? 0 : debit)),
        balance: null,
        raw_category: String(r['Category'] || '').trim(),
        ord: rows.length - i,
      });
    });
  }
  assignIds(out);
  return { format, transactions: out };
}

// Heals data saved before accounts were remembered: if the same four digits are
// stored as both a checking and a savings account, they are one savings account.
// Returns the same array when there is nothing to fix.
export function repairStored(stored) {
  const kinds = new Map();
  for (const t of stored) {
    if (t.kind !== 'checking' && t.kind !== 'savings') continue;
    const k = t.account.slice(-4);
    if (!kinds.has(k)) kinds.set(k, new Set());
    kinds.get(k).add(t.kind);
  }
  const both = new Set([...kinds].filter(([, v]) => v.size > 1).map(([k]) => k));
  if (!both.size) return stored;
  const seen = new Set(), out = [];
  for (let t of stored) {
    if (t.kind === 'checking' && both.has(t.account.slice(-4))) {
      const account = `Savings ...${t.account.slice(-4)}`;
      // A CSV row's id starts with its account name; a Plaid row's id is Plaid's own.
      t = { ...t, kind: 'savings', account, id: t.source === 'plaid' ? t.id : account + t.id.slice(t.account.length) };
    }
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

// A transaction's id is its content plus which occurrence of that content it is
// within the file, so overlapping exports dedupe while two genuinely identical
// purchases on one day both survive.
function assignIds(txns) {
  const seen = new Map();
  for (const t of txns) {
    const base = [t.account, t.date, t.amount.toFixed(2), t.description, t.balance ?? ''].join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    t.id = `${base}#${n}`;
  }
}

export function mergeTransactions(existing, incoming) {
  const ids = new Set(existing.map(t => t.id));
  const added = incoming.filter(t => !ids.has(t.id));
  return { merged: existing.concat(added), added: added.length, skipped: incoming.length - added.length };
}

// ── Categorisation ─────────────────────────────────────────────────────────────

export function buildCategorizer(rules, training) {
  const corpus = seedExamples();
  for (const [m, c] of Object.entries(rules.merchant || {})) corpus.push([m, c]);
  for (const ex of training || []) corpus.push([ex.text, ex.category]);
  return new Categorizer(corpus);
}

// -> [category, is_transfer, guessed]. `guessed` is true when nothing but the
// similarity matcher chose the category.
function baseCategory(t, ml) {
  // A row that came through Plaid carries Plaid's category, not the card's.
  const viaPlaid = t.source === 'plaid';
  const plaidCat = viaPlaid ? plaidCategory(t.raw_category) : null;
  if (t.kind === 'credit_card') {
    let cat = viaPlaid ? plaidCat || 'Other' : t.raw_category ? categorizeCC(t.raw_category) : 'Other';
    // Money arriving on a card that calls itself a payment is the bill being
    // paid, whatever category Plaid gave it. Left as a refund it would come
    // off spending, and a month's card bill would vanish from the totals.
    if (viaPlaid && t.amount > 0 && !TRANSFER_CATEGORIES.has(cat) && CARD_PAYMENT_RE.test(t.description)) cat = 'Credit Card Payment';
    // A travel credit (Capital One Travel's yearly one, say) is filed as a
    // payment by the card, but it is money back on a trip, not the bill paid.
    const paidBill = TRANSFER_CATEGORIES.has(cat) && (cat !== 'Payment' || CARD_PAYMENT_RE.test(t.description));
    // A trip is a trip whatever the card says, unless it says a meal (the
    // restaurant in a hotel). Other names only replace a vague category: a
    // card that says fuel, a pharmacy or a meal knows better than the name.
    if (!paidBill && cat !== 'Dining' && isTravel(t.description)) cat = 'Travel';
    else if (VAGUE_CARD.has(cat) || !ALL_CATS.includes(cat) && !TRANSFER_CATEGORIES.has(cat)) {
      cat = (isGrocery(t.description) && 'Groceries') || brandCategory(t.description) || cardFood(t.description) || cat;
    }
    return [cat, TRANSFER_CATEGORIES.has(cat), false];
  }
  const d = t.description.toLowerCase();
  const table = t.kind === 'savings' ? SAVINGS_KEYWORD_RULES : CHECKING_KEYWORD_RULES;
  for (const [kws, cat, isXfr, unless] of table) {
    if (kws.some(k => hasKeyword(d, k)) && !unless?.test(d)) {
      return [cat, t.kind === 'savings' ? isXfr : TRANSFER_CATEGORIES.has(cat), false];
    }
  }

  // The keyword rules above know this bank's own wording (what a card payment
  // or a move to savings looks like); Plaid's category covers the rest.
  if (plaidCat) return [plaidCat, TRANSFER_CATEGORIES.has(plaidCat), false];
  const cat = ml.predict(t.description) || 'Other';
  return [cat, t.kind === 'savings' ? false : TRANSFER_CATEGORIES.has(cat), true];
}

export function amountRuleMatches(rule, merchant, absAmount) {
  const allowed = rule.tolerance_pct > 0 ? rule.amount * rule.tolerance_pct / 100 : 0.01;
  return rule.merchant === merchant && Math.abs(absAmount - rule.amount) <= allowed;
}

// Stored transactions -> display transactions, newest first.
export function categorize(stored, rules, training, ml = buildCategorizer(rules, training)) {
  const merchantRules = rules.merchant || {};
  const amountRules = rules.amount_rules || [];
  const ruled = new Set(); // ids whose category you chose yourself
  const out = stored.map(t => {
    const merchant = normalizeMerchant(t.description);
    let [category, isTransfer, guessed] = baseCategory(t, ml);
    if (Object.prototype.hasOwnProperty.call(merchantRules, merchant)) {
      category = merchantRules[merchant];
      isTransfer = TRANSFER_CATEGORIES.has(category);
      guessed = false;
      ruled.add(t.id);
    }
    const absAmt = Math.abs(t.amount);
    for (const r of amountRules) {
      if (amountRuleMatches(r, merchant, absAmt)) {
        category = r.category;
        isTransfer = TRANSFER_CATEGORIES.has(category);
        guessed = false;
        ruled.add(t.id);
      }
    }
    // Money coming back is not income. Every credit on a card that is not a
    // payment is a refund. A bank deposit is one only when it is filed under a
    // spending category and either says so or was filed there by your own rule:
    // a paycheck the matcher mislabelled must not vanish from income.
    const refund = t.amount > 0 && !isTransfer && (
      t.kind === 'credit_card'
      || (!NOT_SPENDING.has(category) && (REFUND_RE.test(t.description) || (!guessed && fromRule(merchantRules, amountRules, merchant, absAmt)))));
    return {
      id: t.id,
      kind: t.kind,
      ts: localTs(t.date),
      date_iso: t.date,
      date_fmt: fmtDate(t.date),
      description: t.description,
      merchant,
      category,
      amount: t.amount,
      account: t.account,
      balance: t.balance,
      ord: t.ord || 0,
      is_transfer: isTransfer,
      refund,
    };
  });
  pairCardPayments(out, stored, ruled);
  orderWithinDays(out);
  out.sort((a, b) => b.ts - a.ts || b.ord - a.ord);
  return out;
}

// A card paid from a bank account shows up twice: money leaving the bank
// account and the same amount arriving on the card a day or so later. Both
// halves are a transfer. Each is normally recognised by its own wording; this
// catches a half that was not, by finding its other half. It only looks at
// cards that came through a bank connection (a card's CSV export labels its
// payments itself), and never overrides a category you set by rule.
function pairCardPayments(out, stored, ruled) {
  const viaPlaid = new Set(stored.filter(t => t.source === 'plaid').map(t => t.id));
  const credits = out.filter(t => t.kind === 'credit_card' && t.amount > 0 && viaPlaid.has(t.id));
  if (!credits.length) return;
  const debits = new Map(); // cents -> bank withdrawals of that amount
  for (const t of out) {
    if (t.kind === 'credit_card' || t.amount >= 0) continue;
    const k = Math.round(-t.amount * 100);
    if (!debits.has(k)) debits.set(k, []);
    debits.get(k).push(t);
  }
  const used = new Set();
  const isPayment = t => t.category === 'Credit Card Payment' || t.category === 'Payment';
  const mark = t => { t.category = 'Credit Card Payment'; t.is_transfer = true; t.refund = false; };
  for (const c of credits) {
    const near = (debits.get(Math.round(c.amount * 100)) || [])
      .filter(d => !used.has(d.id) && Math.abs(d.ts - c.ts) <= 5.5 * 86400000)
      .sort((a, b) => isPayment(b) - isPayment(a) || Math.abs(a.ts - c.ts) - Math.abs(b.ts - c.ts))[0];
    if (!near) continue;
    // One half must already read as a card payment; a refund that happens to
    // equal some unrelated withdrawal is left alone.
    if (!isPayment(c) && !isPayment(near)) continue;
    used.add(near.id);
    if (!isPayment(c) && !ruled.has(c.id)) mark(c);
    if (!isPayment(near) && !ruled.has(near.id)) mark(near);
  }
}

function fromRule(merchantRules, amountRules, merchant, absAmt) {
  return Object.prototype.hasOwnProperty.call(merchantRules, merchant)
    || amountRules.some(r => amountRuleMatches(r, merchant, absAmt));
}

// Rows of one bank account on one day, put in the order they happened. `ord`
// only orders rows within the file they came from, so a small refresh and an
// older, larger export disagree. The balances do not: each row opens on the
// balance the one before it closed on.
const cents = n => Math.round(n * 100);
function chain(rows) {
  const left = [...rows];
  const start = left.findIndex(r => !left.some(o => o !== r && cents(o.balance) === cents(r.balance - r.amount)));
  if (start < 0) return null;
  const out = left.splice(start, 1);
  while (left.length) {
    const prev = out[out.length - 1];
    const i = left.findIndex(r => cents(r.balance - r.amount) === cents(prev.balance));
    if (i < 0) return null;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}
function orderWithinDays(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.balance == null) continue;
    const k = t.account + '|' + t.date_iso;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const g of groups.values()) {
    if (g.length < 2 || g.length > 200) continue;
    const ordered = chain(g);
    if (ordered) ordered.forEach((t, i) => { t.ord = i + 1; });
  }
}

// ── Recurring streams ──────────────────────────────────────────────────────────

export function findRecurringStreams(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.is_transfer) continue;
    if (!groups.has(t.merchant)) groups.set(t.merchant, []);
    groups.get(t.merchant).push(t);
  }
  const streams = [];
  for (const [merchant, group] of groups) {
    if (group.length < 3) continue;
    group.sort((a, b) => a.ts - b.ts || a.ord - b.ord);
    const intervals = [];
    for (let i = 0; i < group.length - 1; i++) {
      intervals.push(daysBetween(group[i].date_iso, group[i + 1].date_iso));
    }
    const avgInt = mean(intervals);
    const stdInt = intervals.length > 1 ? Math.sqrt(mean(intervals.map(x => (x - avgInt) ** 2))) : 0;
    if (avgInt === 0 || stdInt / avgInt >= 0.5) continue;

    let freq;
    if (avgInt < 10) freq = 'Weekly';
    else if (avgInt < 20) freq = 'Bi-weekly';
    else if (avgInt < 45) freq = 'Monthly';
    else if (avgInt < 100) freq = 'Quarterly';
    else freq = 'Occasional';

    streams.push({
      merchant,
      frequency: freq,
      avg_amount: round2(mean(group.map(t => Math.abs(t.amount)))),
      occurrences: group.length,
      last_date: group[group.length - 1].date_fmt,
      direction: mean(group.map(t => t.amount)) > 0 ? 'income' : 'expense',
      category: mode(group.map(t => t.category)),
      transactions: group.map(t => ({ date: t.date_fmt, amount: t.amount })),
    });
  }
  streams.sort((a, b) => b.avg_amount - a.avg_amount);
  return streams.slice(0, 20);
}

// ── Combined assets over time ──────────────────────────────────────────────────

// Every bank account's latest balance, minus the credit card balance rebuilt
// from the starting balance forward, for each day anything happened.
// An account that has no rows yet on a given day is carried at the balance it
// had just before its first row, so the line does not jump when a second
// export starts later than the first. `legacy` reproduces the Python original
// (such accounts count as zero, and card-only days are skipped).
export function buildAssetSeries(txns, ccStart = 0, { legacy = false } = {}) {
  const chron = [...txns].sort((a, b) => a.ts - b.ts || a.ord - b.ord);
  const bank = chron.filter(t => t.balance != null && !t.account.startsWith('Credit Card'));
  if (!bank.length) return [];
  const cc = chron.filter(t => t.account.startsWith('Credit Card'));

  const latest = {};
  let days = bank.map(t => t.date_iso);
  if (!legacy) {
    for (const t of bank) if (!(t.account in latest)) latest[t.account] = t.balance - t.amount;
    days = days.concat(cc.map(t => t.date_iso).filter(d => d >= bank[0].date_iso));
  }
  const dates = [...new Set(days)].sort();
  let bi = 0, ci = 0, ccCum = ccStart;
  const out = [];
  for (const date of dates) {
    while (bi < bank.length && bank[bi].date_iso <= date) {
      latest[bank[bi].account] = bank[bi].balance;
      bi++;
    }
    while (ci < cc.length && cc[ci].date_iso <= date) {
      ccCum += -cc[ci].amount;
      ci++;
    }
    const totalBank = Object.values(latest).reduce((s, v) => s + v, 0);
    const ccOut = cc.length && (ci > 0 || !legacy) ? round2(Math.max(0, ccCum)) : 0;
    out.push({
      date,
      total_bank: round2(totalBank),
      cc_outstanding: ccOut,
      net: round2(totalBank - ccOut),
    });
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function round2(n) { return Math.round(n * 100) / 100; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function mode(a) {
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null, bestN = -1;
  for (const [k, n] of [...counts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}
function daysBetween(a, b) { return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86400000); }
function ymd(s) { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d]; }
export function localTs(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(s) { const [y, m, d] = s.split('-').map(Number); return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`; }
