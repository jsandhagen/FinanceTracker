// What a salary turns into after federal income tax, Social Security, Medicare
// and Virginia income tax. Pure functions, no DOM, so they run under Node.
//
// This is an estimate of the year's tax, not a copy of a pay stub. It knows the
// standard deduction and nothing else about a return: no credits, no itemizing,
// no other income. The Income view closes that gap by calibrating against the
// take-home you actually receive (see calibrate).

// Tax year these tables are for. Federal: Rev. Proc. 2025-32. Social Security
// wage base: SSA, October 2025. Virginia: Code of Virginia 58.1-320 (rates),
// 58.1-322.03 (standard deduction and the $930 personal exemption).
export const TAX_YEAR = 2026;

// [upper limit of the band, rate], on taxable income.
const FEDERAL = {
  single:  { deduction: 16100, bands: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]] },
  married: { deduction: 32200, bands: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]] },
  hoh:     { deduction: 24150, bands: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]] },
};

// Virginia has one schedule for every filing status; only the deduction and the
// number of exemptions change.
export const VIRGINIA = {
  bands: [[3000, 0.02], [5000, 0.03], [17000, 0.05], [Infinity, 0.0575]],
  deduction: { single: 8750, married: 17500, hoh: 8750 },
  exemption: 930,
  exemptions: { single: 1, married: 2, hoh: 1 },
};

const FICA = {
  ssRate: 0.062, ssBase: 184500,
  medicareRate: 0.0145,
  extraRate: 0.009, extraOver: { single: 200000, married: 250000, hoh: 200000 },
};

export const FILING = { single: 'Single', married: 'Married filing jointly', hoh: 'Head of household' };

const round2 = n => Math.round(n * 100) / 100;

// Tax on `taxable` through a set of bands, and the rate the last dollar paid.
export function bandTax(taxable, bands) {
  let tax = 0, floor = 0, marginal = 0;
  for (const [top, rate] of bands) {
    if (taxable <= floor) break;
    tax += (Math.min(taxable, top) - floor) * rate;
    marginal = rate;
    floor = top;
  }
  return { tax, marginal };
}

// One year of pay.
//   gross        salary plus bonus
//   filing       'single' | 'married' | 'hoh'
//   pretaxRate   share of gross that leaves before income tax (401(k), health
//                premiums). It lowers federal and Virginia taxable income, not
//                Social Security or Medicare wages.
//   taxScale     multiplies the two income taxes; 1 is the plain estimate
export function yearOf({ gross, filing = 'single', pretaxRate = 0, taxScale = 1 }) {
  const fed = FEDERAL[filing] || FEDERAL.single;
  gross = Math.max(0, Number(gross) || 0);
  const pretax = gross * pretaxRate;
  const wages = gross - pretax;

  const fedTaxable = Math.max(0, wages - fed.deduction);
  const f = bandTax(fedTaxable, fed.bands);
  const vaTaxable = Math.max(0, wages - VIRGINIA.deduction[filing] - VIRGINIA.exemption * VIRGINIA.exemptions[filing]);
  const v = bandTax(vaTaxable, VIRGINIA.bands);

  const ss = Math.min(gross, FICA.ssBase) * FICA.ssRate;
  const medicare = gross * FICA.medicareRate + Math.max(0, gross - FICA.extraOver[filing]) * FICA.extraRate;
  const federal = f.tax * taxScale, virginia = v.tax * taxScale;
  const net = gross - pretax - federal - virginia - ss - medicare;
  return {
    gross, pretax, federal, virginia, ss, medicare, net,
    taxes: federal + virginia + ss + medicare,
    fedTaxable, vaTaxable,
    fedMarginal: f.marginal, vaMarginal: v.marginal,
  };
}

// Backs the two unknowns out of a take-home figure. Given the gross and what
// actually arrives over a year of ordinary paychecks:
//   - if less arrives than the plain estimate, the gap is money taken out before
//     tax, and pretaxRate is solved so the model lands on the real figure;
//   - if more arrives (credits, lighter withholding), nothing is assumed to be
//     deducted and the income taxes are scaled down instead.
// `fit` is false when the take-home is not reachable at all (more than gross
// less Social Security and Medicare).
export function calibrate({ gross, net, filing = 'single' }) {
  const plain = yearOf({ gross, filing });
  if (!(gross > 0) || !(net > 0)) return { pretaxRate: 0, taxScale: 1, fit: false, plainNet: plain.net };
  if (net <= plain.net) {
    // Net falls as pretaxRate rises, so bisect.
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (yearOf({ gross, filing, pretaxRate: mid }).net > net) lo = mid; else hi = mid;
    }
    return { pretaxRate: (lo + hi) / 2, taxScale: 1, fit: true, plainNet: plain.net };
  }
  const incomeTax = plain.federal + plain.virginia;
  const need = gross - plain.ss - plain.medicare - net; // income tax the take-home leaves room for
  if (need < 0 || incomeTax <= 0) return { pretaxRate: 0, taxScale: 0, fit: false, plainNet: plain.net };
  return { pretaxRate: 0, taxScale: need / incomeTax, fit: true, plainNet: plain.net };
}

// Where each dollar between two years of pay went. Used for "of a $5,000 raise,
// you keep $3,400".
export function difference(before, after) {
  const d = k => round2(after[k] - before[k]);
  return { gross: d('gross'), pretax: d('pretax'), federal: d('federal'), virginia: d('virginia'), ss: d('ss'), medicare: d('medicare'), net: d('net') };
}

// The Virginia schedule with the slice of income that falls in each band.
export function virginiaBands(vaTaxable) {
  let floor = 0;
  return VIRGINIA.bands.map(([top, rate]) => {
    const amount = Math.max(0, Math.min(vaTaxable, top) - floor);
    const row = { from: floor, to: top, rate, amount, tax: amount * rate };
    floor = top;
    return row;
  });
}
