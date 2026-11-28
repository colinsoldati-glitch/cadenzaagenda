"""Local, read-only comparison of two Firebase RTDB exports; never upload backups."""
import json,sys
from pathlib import Path
if len(sys.argv)!=3:raise SystemExit('Usage: python3 tests/audit_backup.py before.json after.json')
a,b=(json.loads(Path(p).read_text()) for p in sys.argv[1:]); issues=[]
for eid,old in (a.get('ensembles') or {}).items():
    new=(b.get('ensembles') or {}).get(eid)
    if not new:issues.append(f'ensemble missing: {eid}');continue
    for bucket in ('members','polls','archivedPolls','rehearsals'):
        for key,record in (old.get(bucket) or {}).items():
            candidate=(new.get(bucket) or {}).get(key)
            if candidate is None:issues.append(f'missing {eid}/{bucket}/{key}');continue
            if bucket=='members':
                for field in ('id','name','instrument'):
                    if record.get(field)!=candidate.get(field):issues.append(f'changed {eid}/{bucket}/{key}/{field}')
                # Absence keys can be changed by deduplication; compare periods and reasons, not IDs.
                periods={(u.get('startDate'),u.get('endDate'),u.get('reason') or '') for u in (candidate.get('unavailabilities') or {}).values()}
                for u in (record.get('unavailabilities') or {}).values():
                    if (u.get('startDate'),u.get('endDate'),u.get('reason') or '') not in periods:issues.append(f'absence missing {eid}/{bucket}/{key}/{u.get("id")}')
            elif record!=candidate:issues.append(f'changed {eid}/{bucket}/{key}')
for issue in issues:print(issue)
print(f'{len(issues)} difference(s) to review; expected edits after migration may be legitimate.')
sys.exit(bool(issues))
