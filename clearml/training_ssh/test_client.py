import tempfile
import unittest
from pathlib import Path
from client import command

class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        f = Path(self.temp.name) / 'credential'
        f.touch()
        self.env = {'TRAINING_SSH_HOST': '172.16.4.113', 'TRAINING_SSH_KEY_FILE': str(f), 'TRAINING_SSH_KNOWN_HOSTS': str(f)}

    def test_key_mode(self):
        args = command(['doctor'], self.env)
        self.assertEqual(args[0], 'ssh')
        self.assertIn('StrictHostKeyChecking=yes', args)
        self.assertIn('BatchMode=yes', args)

    def test_detector_uses_common_script(self):
        self.assertEqual(command(['detector'], self.env)[-1],
                         '/home/intellivix/train/scripts/train.sh --type detector')

    def test_password_mode_without_key(self):
        self.env.update(TRAINING_SSH_PASSWORD='secret', TRAINING_SSH_KEY_FILE='/missing')
        args = command(['status'], self.env)
        self.assertEqual(args[:2], ['sshpass', '-e'])
        self.assertNotIn('secret', args)
        self.assertNotIn('-i', args)

    def test_injection_is_quoted(self):
        self.env['TRAINING_SSH_TEST_SCRIPT'] = './scripts/test.sh'
        args = command(['test', '$(touch /tmp/injected); echo bad'], self.env)
        self.assertIn("'$(touch /tmp/injected); echo bad'", args[-1])

    def test_reject_invalid_requests(self):
        for args in (['unknown'], ['stop', 'all'], ['detector', '--bad'], ['test']):
            with self.assertRaises(ValueError):
                command(args, self.env)
        self.env['TRAINING_SSH_HOST'] = '-oProxyCommand=bad'
        with self.assertRaises(ValueError):
            command(['status'], self.env)

if __name__ == '__main__':
    unittest.main()
