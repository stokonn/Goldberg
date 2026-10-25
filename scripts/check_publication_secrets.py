"""Fail closed on recognized credential shapes in publication files;never print values.

Private forensic originals stay ignored and outside the default publication scope.
This is a pattern screen,not proof that arbitrary credentials cannot exist.
"""
import argparse,hashlib,json,os,re,subprocess,sys,zipfile
from pathlib import Path

RULES={
 'google_api_key':re.compile(rb'AIza[0-9A-Za-z_-]{35}'),
 'github_token':re.compile(rb'gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,}'),
 'aws_access_key_id':re.compile(rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),
 'private_key':re.compile(rb'-----BEGIN (?P<keykind>(?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)-----[\s\S]*?(?:-----END (?P=keykind)-----|\Z)'),
 'slack_token':re.compile(rb'xox[baprs]-[0-9A-Za-z-]{20,}'),
}

def findings(data,label):
 result=[]
 for kind,pattern in RULES.items():
  for m in pattern.finditer(data):result.append({'path':label,'kind':kind,'line':data.count(b'\n',0,m.start())+1,'fingerprint':hashlib.sha256(m.group()).hexdigest()[:16]})
 return result

def scan_paths(root,paths,archives=False):
 result=[];count=0
 for path in sorted(set(paths)):
  p=Path(path)
  if not p.is_absolute():p=root/p
  if not p.is_file():raise RuntimeError('Publication file missing or not regular:'+str(path))
  count+=1;label=os.path.relpath(p,root);result+=findings(p.read_bytes(),label)
  if archives and zipfile.is_zipfile(p):
   with zipfile.ZipFile(p) as z:
    total=0
    for info in z.infolist():
     total+=info.file_size
     if info.file_size>128*1024*1024 or total>512*1024*1024:raise RuntimeError('Archive scan limit exceeded;manual review required:'+label)
     if not info.is_dir():result+=findings(z.read(info),label+'!'+info.filename)
 return count,result

def main():
 parser=argparse.ArgumentParser(description=__doc__);scope=parser.add_mutually_exclusive_group();scope.add_argument('--staged',action='store_true');scope.add_argument('--paths',nargs='+');scope.add_argument('--commits',help='Git revision range;scan every added/modified blob,including intermediate commits');parser.add_argument('--archives',action='store_true');parser.add_argument('--report',type=Path)
 a=parser.parse_args();root=Path(subprocess.check_output(['git','rev-parse','--show-toplevel'],text=True).strip())
 if a.commits:
  result=[];count=0
  revisions=subprocess.check_output(['git','rev-list',a.commits],cwd=root,text=True).splitlines()
  for revision in revisions:
   paths=[os.fsdecode(x) for x in subprocess.check_output(['git','diff-tree','--root','--no-commit-id','-r','-m','--diff-filter=AM','--name-only','-z',revision],cwd=root).split(b'\0') if x]
   for path in sorted(set(paths)):
    blob=subprocess.check_output(['git','show',revision+':'+path],cwd=root);result+=findings(blob,revision+':'+path);count+=1
 elif a.staged:
  paths=[os.fsdecode(x) for x in subprocess.check_output(['git','ls-files','-z'],cwd=root).split(b'\0') if x];result=[]
  for path in paths:
   blob=subprocess.check_output(['git','show',':'+path],cwd=root);result+=findings(blob,path)
  count=len(paths)
 else:
  if a.paths:
   paths=[]
   for value in a.paths:
    p=Path(value);paths.extend([q for q in p.rglob('*') if q.is_file()] if p.is_dir() else [p])
  else:paths=[os.fsdecode(x) for x in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).split(b'\0') if x]
  count,result=scan_paths(root,paths,a.archives)
 report={'scope':'commit range '+a.commits if a.commits else ('index' if a.staged else 'working/publication paths'),'filesScanned':count,'findings':result,'result':'FAIL' if result else 'PASS','limits':'Recognized credential-pattern scan;no validation/use/revocation of credentials;not a full Git-history cleanup or universal secret detector.'}
 if a.report:a.report.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2));return 1 if result else 0
if __name__=='__main__':raise SystemExit(main())
