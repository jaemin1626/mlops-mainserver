import io
import json
import os
import shlex
import sys
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from detector import Jobs, remote_command, SCRIPT


class DetectorTests(unittest.TestCase):
    def test_mapping(self):
        params = dict(type='detector', data='data/dataset.yaml', epochs=100, batch=128,
                      gpu='0,1,2,3', img_size=896, weights='weights/yolo26x.pt', name='detector_v1', resume=True)
        self.assertEqual(shlex.split(remote_command(params)), [SCRIPT, '--type', 'detector',
            '--data', 'data/dataset.yaml', '--epochs', '100', '--batch', '128', '--gpu', '0,1,2,3',
            '--img-size', '896', '--weights', 'weights/yolo26x.pt', '--name', 'detector_v1', '--resume'])
        self.assertEqual(shlex.split(remote_command(dict(type='detector', resume=False))), [SCRIPT, '--type', 'detector'])

    def test_invalid_values(self):
        invalid = {'type': ['vlm', None, 1], 'epochs': [True, 0, -1, 1.5, '100', None],
                   'batch': [False, 0, -10], 'img_size': [0, 1.1], 'gpu': ['', ',1', '1,', '1,,2', '0;id', '１'],
                   'name': ['', 'a.b', 'a b', 'x$(id)', '../x'], 'resume': ['false', 0, None],
                   'data': ['/etc/passwd', 'data/../weights/a.yaml', 'data/x.json', 'dataevil/x.yaml', 'data/a\n.yaml', None],
                   'weights': ['weights/../../x.pt', '/tmp/a.pt', 'weights/x.yaml', 'https://host/a.pt']}
        for key, values in invalid.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    remote_command(dict(type='detector', **{key:value}) if key != 'type' else {key:value})
        for params in [{}, [], None, {'type':'detector','learning_rate':0.1}]:
            with self.assertRaises(ValueError):
                remote_command(params)

    def test_path_escaping(self):
        value = "weights/a '$(touch injected);x.pt"
        args = shlex.split(remote_command(dict(type='detector', weights=value)))
        self.assertEqual(args[-1], value)
        for key, value in [('data','/home/intellivix/train/Detector/data/dataset.yaml'),
                           ('weights','/home/intellivix/train/Detector/runs/Detector/v1/weights/last.pt')]:
            self.assertEqual(shlex.split(remote_command({'type':'detector',key:value}))[-1], value)

    def test_exit_codes_and_both_streams(self):
        for code in [0, 2, 255]:
            jobs = Jobs()
            jobs.jobs['test'] = dict(id='test',status='queued',logs='')
            with self.assertLogs('detector') as captured:
                jobs.run('test', [sys.executable, '-c', f'import sys;print("out");print("err",file=sys.stderr);sys.exit({code})'])
            result = jobs.get('test')
            self.assertEqual(result['status'], 'completed' if code == 0 else 'failed')
            self.assertEqual(result['ssh_exit_code'], code)
            self.assertEqual(result['script_exit_code'], None if code == 255 else code)
            self.assertIn('[stdout] out', result['logs'])
            self.assertIn('[stderr] err', result['logs'])
            self.assertTrue(captured.output)

    def test_spawn_failure(self):
        jobs = Jobs(); jobs.jobs['test'] = dict(id='test',status='queued',logs='')
        with patch('detector.subprocess.Popen', side_effect=OSError('missing ssh')), self.assertLogs('detector'):
            jobs.run('test', ['ssh'])
        self.assertEqual(jobs.get('test')['status'], 'failed')

    def test_duplicate_and_bounded_logs(self):
        jobs = Jobs(); jobs.jobs['test'] = dict(id='test',status='running',logs='')
        with patch('detector.ssh_command', return_value=['ssh']), self.assertRaises(RuntimeError):
            jobs.start({'type':'detector'})
        with self.assertLogs('detector'):
            jobs.append('test', 'stdout', 'a'*70000)
        self.assertEqual(len(jobs.get('test')['logs']),65536)

    def test_stop_checks_remote_state(self):
        import subprocess
        jobs=Jobs()
        for running in [True, False]:
            with patch('detector.command', return_value=['ssh']), patch('detector.subprocess.run', return_value=subprocess.CompletedProcess([],0,'stop requested','')), patch.object(jobs,'remote_running',return_value=running):
                self.assertEqual(jobs.stop_remote()['status'], 'failed' if running else 'stopped')
        with patch('detector.command', return_value=['ssh']), patch('detector.subprocess.run',return_value=subprocess.CompletedProcess([],0,'detector     running (train-one)   remote-train-detector','')):
            self.assertTrue(jobs.remote_running())
        with patch('detector.command', return_value=['ssh']), patch('detector.subprocess.run',return_value=subprocess.CompletedProcess([],255,'','connection failed')):
            with self.assertRaises(RuntimeError):jobs.remote_running()

    def test_stop_success_and_failure(self):
        jobs = Jobs();jobs.jobs['test'] = dict(id='test', status='running', logs='')
        with patch.object(jobs, 'stop_remote', return_value={'status':'failed','logs':'denied'}), self.assertLogs('detector'):
            self.assertEqual(jobs.stop('test')['status'], 'failed')
            self.assertEqual(jobs.get('test')['status'], 'running')
        with patch.object(jobs, 'stop_remote', return_value={'status':'stopped','logs':'done'}), self.assertLogs('detector'):
            self.assertEqual(jobs.stop('test')['status'], 'stopped')
        jobs.jobs['test']['status']='stopping'
        self.assertEqual(len(jobs.active()), 1)
        with patch('detector.ssh_command', return_value=['ssh']), self.assertRaises(RuntimeError):
            jobs.start({'type':'detector'})


class ApiTests(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault('TRAINING_DATASET_LOCAL_ROOT','/tmp')
        os.environ.setdefault('ANNOTATION_ALLOWED_ORIGIN','http://test')
        import annotation_api
        self.api = annotation_api
        self.auth = patch.object(annotation_api.H, 'authenticated', return_value=True)
        self.auth.start(); self.addCleanup(self.auth.stop)
        self.server = ThreadingHTTPServer(('127.0.0.1',0), annotation_api.H)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close); self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def request(self, path, params=None, origin='http://test'):
        req = urllib.request.Request(self.url+path, data=json.dumps(params).encode() if params is not None else None,
                                     headers={'Origin':origin,'Content-Type':'application/json'})
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.load(response)

    def test_stop_post_routes(self):
        with patch.object(self.api.JOBS, 'stop', return_value={'status':'stopped'}) as stop:
            self.assertEqual(self.request('/jobs/abc/stop', {})[0], 200)
            stop.assert_called_once_with('abc')
        with patch.object(self.api.JOBS, 'stop_remote', return_value={'status':'failed','logs':'denied'}):
            self.assertEqual(self.request('/stop', {})[0], 502)
            self.assertEqual(self.request('/stop', {}, origin='http://evil')[0], 403)
        self.assertEqual(self.request('/stop')[0], 404)

    def test_launch_and_lookup(self):
        with patch.object(self.api.JOBS, 'start', return_value={'id':'abc','status':'queued'}) as start:
            self.assertEqual(self.request('/jobs',{'type':'detector'})[0],202)
            start.assert_called_once_with({'type':'detector'})
        with patch.object(self.api.JOBS, 'get', return_value={'id':'abc','status':'completed'}):
            self.assertEqual(self.request('/jobs/abc')[1]['status'],'completed')
        self.assertEqual(self.request('/jobs/missing')[0],404)
        self.assertTrue(self.request('/capabilities')[1]['launch'])

    def test_auth_origin_validation(self):
        self.assertEqual(self.request('/jobs',{'type':'vlm'})[0],400)
        self.assertEqual(self.request('/jobs',{'type':'detector'}, origin='http://evil')[0],403)
        with patch.object(self.api.H,'authenticated',return_value=False):
            self.assertEqual(self.request('/jobs',{'type':'detector'})[0],401)
            self.assertEqual(self.request('/jobs/abc')[0],401)

    def test_detector_dataset_api(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=root/'set'; folder.mkdir()
            (folder/'a.jpg').touch(); (folder/'b.jpg').touch()
            (root/'label.txt').write_text('person\ncar\n')
            with patch.object(self.api,'ROOT',root):
                status,result=self.request('/detector/datasets')
                self.assertEqual(result['classes'],['person','car'])
                self.assertIn('set',result['items'])
                def uploaded(directory):
                    self.assertTrue((Path(directory)/'data.yaml').exists())
                    return {'data':'data/generated/test/data.yaml'}
                with patch.object(self.api,'transfer_detector_bundle',side_effect=uploaded) as transfer:
                    status,result=self.request('/detector/annotations',{'folders':['set'],'classes':['person','car']})
                    self.assertEqual(status,200)
                    self.assertEqual(result['data'],'data/generated/test/data.yaml')
                    self.assertEqual((result['train'],result['test']),(1,1))
                    self.assertIn('nc: 2',result['yaml'])
                    transfer.assert_called_once()
                for payload in [[], {'folders':['../'],'classes':['x']}, {'folders':['set'],'classes':[]},
                                {'folders':['set'],'classes':['x'],'data':'/tmp/evil'}]:
                    self.assertEqual(self.request('/detector/annotations',payload)[0],400)
                with patch.object(self.api,'transfer_detector_bundle',side_effect=OSError('SFTP unavailable')):
                    with self.assertLogs('detector.annotations'):
                        self.assertEqual(self.request('/detector/annotations',{'folders':['set'],'classes':['x']})[0],502)
                self.assertEqual(self.request('/detector/annotations',{'folders':['set'],'classes':['x']},origin='http://evil')[0],403)
                with patch.object(self.api.H,'authenticated',return_value=False):
                    self.assertEqual(self.request('/detector/annotations',{'folders':['set'],'classes':['x']})[0],401)


if __name__ == '__main__':
    unittest.main()
