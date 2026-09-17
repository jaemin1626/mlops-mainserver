import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import deploy
from deploy import (
    ExportJobs,
    _detector_model_sizes,
    export_output_paths,
    export_remote_command,
    onnx_cat_command,
    onnx_test_command,
    validate_export_params,
    vlm_test_command,
    vlm_zip_command,
)


class ExportParamsTests(unittest.TestCase):
    def test_defaults_when_omitted(self):
        params = validate_export_params({'weights': 'runs/Detector/train/weights/best.pt'})
        self.assertEqual(params, dict(
            weights='runs/Detector/train/weights/best.pt',
            imgsz_h=640, imgsz_w=640, batch=1, opset=17, max_det=300, conf=0.2, iou=0.5,
        ))

    def test_imgsz_w_defaults_to_imgsz_h(self):
        params = validate_export_params({'weights': 'weights/a.pt', 'imgsz_h': 960})
        self.assertEqual((params['imgsz_h'], params['imgsz_w']), (960, 960))

    def test_rectangular_imgsz(self):
        params = validate_export_params({'weights': 'weights/a.pt', 'imgsz_h': 640, 'imgsz_w': 384})
        self.assertEqual((params['imgsz_h'], params['imgsz_w']), (640, 384))

    def test_invalid_values_rejected(self):
        base = {'weights': 'weights/a.pt'}
        invalid = {
            'imgsz_h': [0, -1, 1.5, 'x', 5000],
            'batch': [0, -1, 100],
            'opset': [1, 30],
            'max_det': [0, 5000],
            'conf': [-0.1, 1.1, 'x'],
            'iou': [-0.1, 1.1],
        }
        for key, values in invalid.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    validate_export_params({**base, key: value})

    def test_weights_path_reuses_detector_allowlist(self):
        for bad in ['/etc/passwd', 'weights/../../x.pt', 'weights/x.onnx', None, '']:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_export_params({'weights': bad})

    def test_not_a_dict(self):
        for bad in [None, [], 'x']:
            with self.assertRaises(ValueError):
                validate_export_params(bad)


class DetectorModelSizeTests(unittest.TestCase):
    def test_parses_grep_output_into_size_labels(self):
        stdout = (
            '/x/runs/Detector/train-19/args.yaml:model: /workspace/Detector/weights/yolo26n.pt\n'
            '/x/runs/Detector/train-18/args.yaml:model: /workspace/Detector/weights/yolo26l.pt\n'
            '/x/runs/Detector/train-17/args.yaml:model: /workspace/Detector/weights/yolo26x.pt\n'
            '/x/runs/Detector/train-16/args.yaml:model: /workspace/Detector/weights/some_custom.pt\n'
        )
        with patch('deploy.ssh_command', return_value=[sys.executable, '-c', f'import sys;sys.stdout.write({stdout!r})']):
            sizes = _detector_model_sizes('/x/runs/Detector')
        self.assertEqual(sizes['/x/runs/Detector/train-19'], 'Small')
        self.assertEqual(sizes['/x/runs/Detector/train-18'], 'Medium')
        self.assertEqual(sizes['/x/runs/Detector/train-17'], 'Large')
        self.assertIsNone(sizes['/x/runs/Detector/train-16'])

    def test_returns_empty_on_command_failure(self):
        with patch('deploy.ssh_command', return_value=[sys.executable, '-c', 'import sys;sys.exit(1)']):
            self.assertEqual(_detector_model_sizes('/x/runs/Detector'), {})


class ExportOutputPathsTests(unittest.TestCase):
    def test_square_size_tag(self):
        paths = export_output_paths('/x/runs/Detector/train/weights/best.pt', 640, 640)
        self.assertEqual(paths['raw'], '/x/runs/Detector/train/weights/best_640_nms.onnx')
        self.assertEqual(paths['final'], '/x/runs/Detector/train/weights/best_640_e_nms.onnx')

    def test_rectangular_size_tag(self):
        paths = export_output_paths('/x/weights/best.pt', 640, 384)
        self.assertEqual(paths['raw'], '/x/weights/best_640x384_nms.onnx')
        self.assertEqual(paths['final'], '/x/weights/best_640x384_e_nms.onnx')


class OnnxDownloadPathTests(unittest.TestCase):
    def test_accepts_paths_under_allowed_roots(self):
        with patch('deploy.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            for path in [
                '/home/intellivix/train/Detector/runs/Detector/train/weights/best_640_e_nms.onnx',
                '/home/intellivix/train/Detector/weights/custom_640_nms.onnx',
            ]:
                command = onnx_cat_command(path)
                self.assertIn(path, command[-1])
                self.assertTrue(command[-1].startswith('cat --'))

    def test_rejects_outside_roots_or_wrong_suffix(self):
        for bad in [
            '/etc/passwd',
            '/home/intellivix/train/Detector/runs/Detector/train/weights/best.pt',
            '/home/intellivix/train/Detector/data/x.onnx',
            '../x.onnx',
            None,
            '',
        ]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                onnx_cat_command(bad)


class ShellSyntaxTests(unittest.TestCase):
    """Actually runs the generated existence-check command through a real shell.

    `test`/`[` (unlike cat/zip/rm) does not understand `--` as an end-of-options
    marker, so `test -f -- /path` is a shell *syntax* error (exit 2), not a
    normal not-found result (exit 1). A pure mock of ssh_command would never
    catch that class of bug, so this test swaps in a local `bash -c` instead of
    real SSH and checks we get a real 0/1 result rather than a shell error.
    """

    def _run(self, command):
        return subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    def test_onnx_test_command_has_valid_shell_syntax(self):
        with patch('deploy.ssh_command', side_effect=lambda remote: ['bash', '-c', remote]):
            command, _ = onnx_test_command('/home/intellivix/train/Detector/weights/does-not-exist.onnx')
        result = self._run(command)
        self.assertIn(result.returncode, (0, 1), msg=f'stderr={result.stderr!r}')

    def test_vlm_test_command_has_valid_shell_syntax(self):
        with patch('deploy.ssh_command', side_effect=lambda remote: ['bash', '-c', remote]):
            command, _ = vlm_test_command('/workspace/VLM/runs/train/image/202609161019')
        result = self._run(command)
        self.assertIn(result.returncode, (0, 1), msg=f'stderr={result.stderr!r}')


class VlmDownloadPathTests(unittest.TestCase):
    def test_accepts_workspace_model_paths(self):
        with patch('deploy.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            command = vlm_zip_command('/workspace/VLM/runs/train/image/202609161019')
        remote = command[-1]
        self.assertIn('/home/intellivix/train/VLM/runs/train', remote)
        self.assertIn('zip -rq', remote)
        self.assertIn('&& zip -rq - -- best', remote)
        self.assertNotIn('202609161019 best', remote)

    def test_rejects_paths_outside_trained_root(self):
        for bad in [
            '/workspace/VLM/data/vlm/train.json',
            '/workspace/VLM/runs/train',
            '/workspace/VLM/weights/../scripts',
            '/etc/passwd',
            None,
            '',
        ]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                vlm_zip_command(bad)


class ExportCommandTests(unittest.TestCase):
    def test_uses_training_root_docker_export_entrypoint(self):
        command = export_remote_command({
            'weights': '/home/intellivix/train/Detector/runs/Detector/train-17/weights/best.pt',
            'imgsz_h': 640, 'imgsz_w': 640, 'batch': 1, 'opset': 17,
            'max_det': 300, 'conf': 0.2, 'iou': 0.5,
        })
        self.assertIn('cd -- /home/intellivix/train', command)
        self.assertIn('./scripts/export.sh --weights', command)
        self.assertIn('--height 640 --width 640', command)
        self.assertIn('--confidence 0.2 --iou 0.5', command)
        self.assertIn('--max-detections 300 --opset 17', command)
        self.assertNotIn('python3', command)
        self.assertNotIn('run_export.sh', command)


class ExportJobsTests(unittest.TestCase):
    def _fake_command(self, code, out='exporting\n'):
        return [sys.executable, '-c', f'import sys;print({out!r},end="");sys.exit({code})']

    def test_start_rejects_when_training_active(self):
        jobs = ExportJobs()
        with patch.object(deploy.JOBS, 'active', return_value=[{'status': 'running'}]):
            with self.assertRaises(RuntimeError):
                jobs.start({'weights': 'weights/a.pt'})

    def test_start_rejects_duplicate_export(self):
        jobs = ExportJobs()
        jobs.jobs['existing'] = dict(id='existing', status='running', logs='')
        with patch.object(deploy.JOBS, 'active', return_value=[]), \
             patch.object(deploy.JOBS, 'remote_running', return_value=False):
            with self.assertRaises(RuntimeError):
                jobs.start({'weights': 'weights/a.pt'})

    def test_delete_history_removes_only_requested_record(self):
        jobs = ExportJobs()
        first = 'a' * 32
        second = 'b' * 32
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'DEPLOY_HISTORY_FILE', directory + '/history.json'):
            jobs._write_history([{'id': first}, {'id': second}])
            self.assertTrue(jobs.delete_history(first))
            self.assertEqual(jobs.history(), [{'id': second}])
            self.assertFalse(jobs.delete_history(first))
            with self.assertRaises(ValueError):
                jobs.delete_history('../history.json')

    def test_run_marks_completed_on_zero_exit(self):
        jobs = ExportJobs()
        jobs.jobs['job1'] = dict(id='job1', status='queued', logs='', exit_code=None, error=None,
                                  params={}, outputs={})
        with patch('deploy.ssh_command', return_value=self._fake_command(0, 'done\n')):
            jobs._run('job1', {'weights': 'weights/a.pt', 'imgsz_h': 640, 'imgsz_w': 640,
                                'batch': 1, 'opset': 17, 'max_det': 300, 'conf': 0.2, 'iou': 0.5})
        result = jobs.get('job1')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['exit_code'], 0)
        self.assertIn('done', result['logs'])

    def test_run_marks_failed_on_nonzero_exit(self):
        jobs = ExportJobs()
        jobs.jobs['job1'] = dict(id='job1', status='queued', logs='', exit_code=None, error=None,
                                  params={}, outputs={})
        with patch('deploy.ssh_command', return_value=self._fake_command(1, 'boom\n')):
            jobs._run('job1', {'weights': 'weights/a.pt', 'imgsz_h': 640, 'imgsz_w': 640,
                                'batch': 1, 'opset': 17, 'max_det': 300, 'conf': 0.2, 'iou': 0.5})
        result = jobs.get('job1')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['exit_code'], 1)
        self.assertIn('boom', result['logs'])


if __name__ == '__main__':
    unittest.main()
