"""Redact recognized credentials from diagnostics;preserve evidence privately first."""
import hashlib,os,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts'))
from check_publication_secrets import RULES


def redact_text(value:str)->str:
 data=value.encode('utf-8');clean=data
 for kind,pattern in RULES.items():
  clean=pattern.sub(lambda m:('[REDACTED_'+kind.upper()+'_SHA256_'+hashlib.sha256(m.group()).hexdigest()[:16]+']').encode(),clean)
 if clean!=data:
  private=ROOT/'.gradle/private-diagnostic-originals';private.mkdir(mode=0o700,exist_ok=True);os.chmod(private,0o700)
  p=private/(hashlib.sha256(data).hexdigest()+'.txt')
  if not p.exists():
   fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'wb') as f:f.write(data)
 return clean.decode('utf-8')
