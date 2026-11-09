"""Run the original analyzer.py over the fixtures with the ML fallback stubbed out.
usage: python run_python.py <FinanceTracker dir> <fixtures dir> <rules json> <out json>"""
import json
import shutil
import sys
import tempfile
import types
from pathlib import Path

src, fixtures, rules, out = map(Path, sys.argv[1:5])
work = Path(tempfile.mkdtemp())
shutil.copy(src / 'analyzer.py', work / 'analyzer.py')
shutil.copy(rules, work / 'custom_rules.json')
sys.path.insert(0, str(work))
sys.modules['ml_categorizer'] = types.SimpleNamespace(predict=lambda text: (None, 0.0))

import pandas as pd  # noqa: E402
from analyzer import analyze_transactions  # noqa: E402

dfs = [pd.read_csv(fixtures / f) for f in ('checking.csv', 'savings.csv', 'credit.csv')]
res = analyze_transactions(dfs, cc_starting_balance=1987.39)
out.write_text(json.dumps(res, default=str))
print('python analysis written to', out)
