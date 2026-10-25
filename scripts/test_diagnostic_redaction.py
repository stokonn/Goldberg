"""Regression checks use generated dummy shapes;never print or validate real keys."""
import hashlib,json,sys,unittest,subprocess,tempfile,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/stage8/independent'))
from redact_diagnostics import redact_text
from check_publication_secrets import findings

class DiagnosticRedactionTest(unittest.TestCase):
 def test_repeated_gboard_fields_and_json_command_stream(self):
  dummy='AIza'+'Z'*35
  raw='expressive_stickers_api_key{finalValue='+dummy+', PHENOTYPE='+dummy+'}'
  clean=redact_text(raw)
  self.assertFalse(bool(findings(clean.encode(),'diagnostic')),'Credential shape remains')
  self.assertEqual(2,clean.count('[REDACTED_GOOGLE_API_KEY_SHA256_'))
  self.assertIn(hashlib.sha256(dummy.encode()).hexdigest()[:16],clean)
  line=json.dumps({'stdout':raw,'code':0})
  result=json.loads(redact_text(line))
  self.assertEqual(0,result['code']);self.assertFalse(bool(findings(result['stdout'].encode(),'stdout')))
 def test_machine_evidence_without_credentials_is_unchanged(self):
  raw='mInputShown=true\nrotation=1\ncredit=6008\nPříliš žluťoučký\n'
  self.assertEqual(raw,redact_text(raw))
 def test_all_recognized_shapes_fail_screen_and_redact(self):
  values=['ghp_'+'A'*36,'AKIA'+'B'*16,'xoxb-'+'C'*24]
  for dummy in values:
   self.assertTrue(bool(findings(dummy.encode(),'generated')))
   self.assertFalse(bool(findings(redact_text(dummy).encode(),'redacted')))
 def test_private_key_body_and_unterminated_body_are_removed(self):
  begin='-----BEGIN '+'PRIVATE KEY-----'
  end='-----END '+'PRIVATE KEY-----'
  raw=begin+'\nSYNTHETIC_PRIVATE_BODY\n'+end
  clean=redact_text(raw)
  self.assertNotIn('SYNTHETIC_PRIVATE_BODY',clean)
  self.assertFalse(bool(findings(clean.encode(),'redacted')))
  self.assertNotIn('SYNTHETIC_PRIVATE_BODY',redact_text(begin+'\nSYNTHETIC_PRIVATE_BODY'))
 def test_private_originals_are_restricted_and_not_publication_files(self):
  dummy='AIza'+'Y'*35;redact_text(dummy)
  p=ROOT/'.gradle/private-diagnostic-originals'/(hashlib.sha256(dummy.encode()).hexdigest()+'.txt')
  self.assertEqual(0o600,p.stat().st_mode&0o777)
  self.assertEqual(0o700,p.parent.stat().st_mode&0o777)

class PublicationGateTest(unittest.TestCase):
 def run_git(self,root,*args):
  return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL)
 def scan(self,root,*args):
  return subprocess.run([sys.executable,str(ROOT/'scripts/check_publication_secrets.py'),*args],cwd=root,capture_output=True)
 def test_index_and_intermediate_commit_are_scanned(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);self.run_git(p,'init');self.run_git(p,'config','user.name','Synthetic');self.run_git(p,'config','user.email','synthetic@example.invalid')
   f=p/'diagnostic.txt';f.write_text('clean');self.run_git(p,'add','.');self.run_git(p,'commit','-m','baseline');base=self.run_git(p,'rev-parse','HEAD').decode().strip()
   dummy='AIza'+'X'*35;f.write_text(dummy);self.run_git(p,'add','.')
   f.write_text('clean working copy')
   result=self.scan(p,'--staged');self.assertEqual(1,result.returncode);self.assertNotIn(dummy.encode(),result.stdout)
   self.run_git(p,'commit','-m','synthetic exposure');self.run_git(p,'add','.');self.run_git(p,'commit','-m','synthetic redaction')
   self.assertEqual(0,self.scan(p,'--staged').returncode)
   result=self.scan(p,'--commits',base+'..HEAD');self.assertEqual(1,result.returncode);self.assertNotIn(dummy.encode(),result.stdout)
 def test_archive_member_is_scanned_without_printing_value(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'synthetic.zip';dummy='AIza'+'W'*35
   with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('nested/diagnostic.txt',dummy)
   result=self.scan(ROOT,'--paths',str(p),'--archives');self.assertEqual(1,result.returncode);self.assertNotIn(dummy.encode(),result.stdout)
   self.assertIn(b'nested/diagnostic.txt',result.stdout)
 def test_missing_explicit_artifact_fails_closed(self):
  self.assertNotEqual(0,self.scan(ROOT,'--paths','/tmp/nonexistent-goldberg-publication-artifact').returncode)

if __name__=='__main__':unittest.main()
