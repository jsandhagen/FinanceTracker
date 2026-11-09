"""Write synthetic Capital One exports (checking, savings, credit card) for the
parity test. Fake data only; nothing here comes from a real account."""
import csv
import random
import sys
from datetime import date, timedelta
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rng = random.Random(7)
start = date(2025, 1, 2)
days = 300

# Checking: one transaction per day so the closing balance of a day is unambiguous.
bal = 4200.0
rows = []
spend = ['SAFEWAY 0075', 'NETFLIX.COM', 'CHIPOTLE 1234', 'SHELL OIL 5741', 'Debit Card Purchase - CORNER STORE',
         'Zelle money sent to Alex', 'CAPITAL ONE MOBILE PMT', 'Withdrawal to 360 Performance Savings XXXXXXX1234',
         'DOMINION ENERGY BILLPAY', 'RENT PAYMENT PORTAL', 'GEICO INS PREM', 'Planet Fitness']
for i in range(days):
    d = start + timedelta(days=i)
    if i % 14 == 0:
        desc, typ, amt = 'ACME CORP PAYROLL', 'Credit', 2650.00
    elif d.day == 1:
        desc, typ, amt = 'RENT PAYMENT PORTAL', 'Debit', 1650.00
    elif i % 30 == 5:
        desc, typ, amt = 'NETFLIX.COM', 'Debit', 15.49
    else:
        desc = rng.choice(spend)
        typ, amt = 'Debit', round(rng.uniform(4, 180), 2)
    bal += amt if typ == 'Credit' else -amt
    rows.append(['12345678', desc, d.strftime('%m/%d/%y'), typ, f'{amt:.2f}', f'{bal:.2f}'])
rows.reverse()  # Capital One lists newest first
with open(out / 'checking.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Account Number', 'Transaction Description', 'Transaction Date',
                'Transaction Type', 'Transaction Amount', 'Balance'])
    w.writerows(rows)

# Savings: a transfer in every two weeks, interest monthly.
bal = 10000.0
rows = []
for i in range(3, days, 7):
    d = start + timedelta(days=i)
    if d.day <= 7:
        desc, amt = 'Monthly Interest Paid', round(bal * 0.0035, 2)
    else:
        desc, amt = 'Deposit from 360 Checking XXXXXXX5678', 250.00
    bal += amt
    rows.append(['87654321', desc, d.strftime('%m/%d/%y'), 'Credit', f'{amt:.2f}', f'{bal:.2f}'])
rows.reverse()
with open(out / 'savings.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Account Number', 'Transaction Description', 'Transaction Date',
                'Transaction Type', 'Transaction Amount', 'Balance'])
    w.writerows(rows)

# Credit card.
cats = [('WHOLEFDS MKT 10234', 'Groceries'), ('AMAZON.COM*2K4', 'Merchandise'),
        ('SPOTIFY USA', 'Other Services'), ('UBER *TRIP', 'Other Travel'),
        ('COTHTL HOTEL BOOKING', 'Lodging'), ('LOCAL DINER', 'Dining/Restaurant'),
        ('WEIRD THING LLC', 'Gift Shops')]
rows = []
for i in range(1, days, 2):
    d = start + timedelta(days=i)
    if i % 31 == 1:
        rows.append([d.isoformat(), d.isoformat(), '4321', 'CAPITAL ONE AUTOPAY PYMT', 'Payment/Credit', '', '600.00'])
    elif i % 30 == 3:
        rows.append([d.isoformat(), d.isoformat(), '4321', 'SPOTIFY USA', 'Other Services', '11.99', ''])
    else:
        desc, cat = rng.choice(cats)
        rows.append([d.isoformat(), d.isoformat(), '4321', desc, cat, f'{rng.uniform(5, 140):.2f}', ''])
rows.reverse()
with open(out / 'credit.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'])
    w.writerows(rows)
print('fixtures written to', out)
