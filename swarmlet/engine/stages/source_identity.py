"""Reject an engine checkout whose actual source differs from the pinned overlay."""
import pathlib, subprocess, sys

def verify_source(source, patch, revision):
 def git(*args):return subprocess.check_output(['git','-C',str(source),*args])
 if git('rev-parse','HEAD').decode().strip()!=revision:raise RuntimeError('engine revision mismatch')
 actual=git('-c','core.abbrev=7','-c','diff.algorithm=myers','diff','--no-ext-diff','--no-color','--binary','HEAD')
 if actual!=pathlib.Path(patch).read_bytes():raise RuntimeError('engine source differs from exact stage overlay')
 extra=git('ls-files','--others','--exclude-standard').decode().splitlines()
 if extra:raise RuntimeError('untracked engine files: '+', '.join(extra[:10]))
 return True
if __name__=='__main__':verify_source(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]),sys.argv[3])
