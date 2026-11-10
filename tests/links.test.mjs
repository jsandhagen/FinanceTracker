import { cleanLink, downloadLink } from '../js/links.js';
import assert from 'node:assert/strict';

const id = 'AbC123+xYz/Q9=';                       // made up; real ids look like this, with + and =
const dl = `https://myaccounts.capitalone.com/Bank/${id.replace('/', '')}/downloadTransactions`;
assert.equal(downloadLink(dl), dl, 'a download address is kept exactly');
assert.equal(downloadLink(dl.replace('downloadTransactions', 'transactions?x=1#top')), dl, 'another page of the account becomes its download page');
assert.equal(downloadLink(dl.replace('/downloadTransactions', '')), dl, 'the bare account address too');
assert.ok(downloadLink(dl).includes('+') && downloadLink(dl).endsWith('/downloadTransactions'), '+ and = in the id survive');
assert.equal(downloadLink('https://myaccounts.capitalone.com/Card/zzz/transactions'), 'https://myaccounts.capitalone.com/Card/zzz/transactions', 'other shapes are left alone');
for (const bad of ['javascript:alert(1)', 'http://myaccounts.capitalone.com/Bank/a/b', 'https://evil.example/capitalone.com', 'https://capitalone.com.evil.example/', 'https://notcapitalone.com/', 'nonsense', '']) {
  assert.equal(downloadLink(bad), null, bad);
  assert.equal(cleanLink(bad), null, bad);
}
console.log('links tests passed');
