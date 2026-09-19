"""MLOps -> training host client; no shell evaluation of caller arguments."""
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

# Shared with every other module that builds a remote path (detector.py, vlm.py,
# deploy.py, dataset_api.py, training_cleanup.py, annotation_api.py) so a single
# TRAINING_SSH_ROOT change in .env actually reaches every remote command instead
# of only the generic doctor/status/logs/stop/test CLI below.
TRAINING_ROOT = os.environ.get('TRAINING_SSH_ROOT', '/home/intellivix/train')


def command(args, env=os.environ):
    if not args:
        args = ['doctor']
    action, *extra = args
    if action not in {'doctor', 'status', 'detector', 'vlm', 'logs', 'stop', 'test'}:
        raise ValueError('Use: doctor | status | detector | vlm | logs PROJECT | stop PROJECT | test [ARGS...]')
    if action in {'logs', 'stop'}:
        if len(extra) != 1 or extra[0] not in {'detector', 'vlm'}:
            raise ValueError('logs/stop requires detector or vlm')
    elif action != 'test' and extra:
        raise ValueError(f'{action} takes no arguments')
    if action == 'detector':
        from detector import remote_command
        return ssh_command(remote_command({'type': 'detector'}), env)
    root = env.get('TRAINING_SSH_ROOT', TRAINING_ROOT)
    script = env.get('TRAINING_SSH_SCRIPT', './scripts/remote_train.sh')
    remote_args = args
    if action == 'test':
        script = env.get('TRAINING_SSH_TEST_SCRIPT', '')
        if not script:
            raise ValueError('Set TRAINING_SSH_TEST_SCRIPT to an existing executable test script on the training server')
        remote_args = extra
    if not root.startswith('/') or not script or script.startswith('-'):
        raise ValueError('Use an absolute training root and a valid script path')
    remote = f'cd -- {shlex.quote(root)} && ' + shlex.join([script, *remote_args])
    return ssh_command(remote, env)


def ssh_command(remote, env=os.environ):
    host = env.get('TRAINING_SSH_HOST') or env.get('TRAINING_SERVER_IP', '')
    user = env.get('TRAINING_SSH_USER', 'intellivix')
    port = env.get('TRAINING_SSH_PORT', '22')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._:-]*', host):
        raise ValueError('Invalid TRAINING_SSH_HOST')
    if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_-]*', user):
        raise ValueError('Invalid TRAINING_SSH_USER')
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError('Invalid TRAINING_SSH_PORT')
    key = env.get('TRAINING_SSH_KEY_FILE', '/run/training-ssh/id_ed25519')
    known = env.get('TRAINING_SSH_KNOWN_HOSTS', '/run/training-ssh/known_hosts')
    password = env.get("TRAINING_SSH_PASSWORD", "")
    for filename in ((known,) if password else (key, known)):
        if not Path(filename).is_file():
            raise ValueError(f'Missing SSH file: {filename}; prepare SSH credentials first')
    ssh = ['ssh', '-F', '/dev/null', '-T', '-o', f'BatchMode={"no" if password else "yes"}', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={known}',
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3', '-i', key, '-p', port, f'{user}@{host}', remote]
    if password:
        ssh[ssh.index('-i'):ssh.index('-i') + 2] = []
        ssh[1:1] = ['-o', 'PreferredAuthentications=keyboard-interactive,password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1']
        return ['sshpass', '-e', *ssh]
    return ssh


if __name__ == '__main__':
    try:
        child_env = dict(os.environ)
        password = child_env.pop("TRAINING_SSH_PASSWORD", "")
        if password:
            child_env["SSHPASS"] = password
        sys.exit(subprocess.call(command(sys.argv[1:]), env=child_env))
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)


def sftp_command(env=os.environ):
    """Reuse validated SSH identity/host options without issuing a remote shell command."""
    ssh = ssh_command('', env)
    start = ssh.index('ssh')
    options = ['-P' if arg == '-p' else arg for arg in ssh[start+1:-2] if arg != '-T']
    return [*ssh[:start], 'sftp', *options, '-b', '-', ssh[-2]]
