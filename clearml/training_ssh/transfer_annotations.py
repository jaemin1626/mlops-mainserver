"""Verified SSH transfer into a new directory; never overwrite an existing run."""
import os
import datetime
import re
import shlex
import subprocess
import uuid
from client import command

def transfer(train_file, val_file, date):
    if not re.fullmatch(r'\d{8}', date):
        raise ValueError('Invalid date')
    root = os.environ['TRAINING_ANNOTATION_DIR'].rstrip('/')
    if not root.startswith('/') or '..' in root.split('/'):
        raise ValueError('Invalid annotation directory')
    ssh = command(['doctor'])[:-1]
    def run(remote, data=None):
        return subprocess.run([*ssh, remote], input=data, check=True, capture_output=True, timeout=60)
    run('mkdir -p -- '+shlex.quote(root))
    dest = root+'/'+date
    try:
        run('mkdir -- '+shlex.quote(dest))
    except subprocess.CalledProcessError:
        dest += '-'+uuid.uuid4().hex[:8]
        run('mkdir -- '+shlex.quote(dest))
    for name, source in [('train.json', train_file), ('val.json', val_file)]:
        data = source.read_bytes()
        run('cat > '+shlex.quote(dest+'/'+name+'.part')+' && mv -- '+shlex.quote(dest+'/'+name+'.part')+' '+shlex.quote(dest+'/'+name), data)
    run('test -s '+shlex.quote(dest+'/train.json')+' && test -s '+shlex.quote(dest+'/val.json'))
    return dest


BUNDLE_FILES = ('train.txt', 'valid.txt', 'test.txt', 'data.yaml')


def transfer_detector_bundle(source):
    """Publish a complete new configuration using SFTP only; existing runs keep their config."""
    import logging
    from pathlib import Path
    from client import sftp_command
    root = 'train/Detector/data/generated'
    kst = datetime.timezone(datetime.timedelta(hours=9))
    name = datetime.datetime.now(kst).strftime('%Y%m%d%H%M%S')
    staging, destination = root+'/.'+name+'.part', root+'/'+name
    def quote(value):
        value = str(value)
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Invalid SFTP path')
        return '"'+value.replace('\\', '\\\\').replace('"', '\\"')+'"'
    batch = ['-mkdir '+quote(root), 'mkdir '+quote(staging)]
    source_path = Path(source)
    yaml_path = source_path/'data.yaml'
    yaml_text = yaml_path.read_text(encoding='utf-8').replace('<timestamp>', name).replace('/workspace/Detector/annotation/detector/latest/', '/workspace/Detector/data/generated/'+name+'/')
    yaml_path.write_text(yaml_text, encoding='utf-8')
    for filename in BUNDLE_FILES:
        file = source_path/filename
        if not file.is_file() or not file.stat().st_size:
            raise ValueError('Incomplete Detector bundle')
        batch.append('put '+quote(file)+' '+quote(staging+'/'+filename))
    batch.append('rename '+quote(staging)+' '+quote(destination))
    env = dict(os.environ)
    password = env.pop('TRAINING_SSH_PASSWORD', '')
    if password:
        env['SSHPASS'] = password
    result = subprocess.run(sftp_command(), input='\n'.join(batch)+'\n', text=True,
                            capture_output=True, timeout=120, env=env)
    log = logging.getLogger('detector.transfer')
    if result.stdout:
        log.warning('[sftp stdout] %s', result.stdout)
    if result.stderr:
        log.warning('[sftp stderr] %s', result.stderr)
    result.check_returncode()
    return {'data': 'data/generated/'+name+'/data.yaml', 'server_dir': destination,
            'files': {filename: destination+'/'+filename for filename in BUNDLE_FILES}}
