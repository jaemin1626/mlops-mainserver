import unittest
from unittest.mock import patch
from training_cleanup import remote_delete_command

class TrainingCleanupTests(unittest.TestCase):
    def test_detector_path_is_bounded(self):
        with patch('training_cleanup.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            remote = remote_delete_command('Detector', 'detector_20260916073830')[1]
        self.assertIn('/home/intellivix/train/Detector/runs/Detector', remote)
        self.assertIn('detector_20260916073830', remote)
        self.assertIn('p.resolve().parent==r', remote)

    def test_vlm_checks_only_modality_roots(self):
        with patch('training_cleanup.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            remote = remote_delete_command('VLM', 'vlm_20260916073830')[1]
        for modality in ('image', 'video', 'both'):
            self.assertIn('/VLM/runs/train/' + modality, remote)

    def test_vlm_also_targets_plots_sibling_folder(self):
        with patch('training_cleanup.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            remote = remote_delete_command('VLM', 'vlm_20260916073830')[1]
        self.assertIn('vlm_20260916073830_plots', remote)

    def test_detector_does_not_target_plots_sibling_folder(self):
        with patch('training_cleanup.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            remote = remote_delete_command('Detector', 'detector_20260916073830')[1]
        self.assertNotIn('_plots', remote)

    def test_vlm_strips_modality_prefix_to_match_real_folder_name(self):
        # ClearML Task 이름은 "Image_202609160950"이지만 실제 폴더는 "202609160950".
        # 접두어를 그대로 쓰면 아무 경로도 존재하지 않아 삭제가 조용히 실패(no-op)한다.
        with patch('training_cleanup.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            remote = remote_delete_command('VLM', 'Image_202609160950')[1]
        self.assertIn('202609160950', remote)
        self.assertIn('202609160950_plots', remote)
        # 원래 Task 이름 형태(및 그 _plots)도 후보로 유지해 다른 명명 규칙에도 대비한다.
        self.assertIn('Image_202609160950', remote)
        self.assertIn('Image_202609160950_plots', remote)

    def test_vlm_without_modality_prefix_is_unaffected(self):
        with patch('training_cleanup.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            remote = remote_delete_command('VLM', 'vlm_20260916081556')[1]
        self.assertIn('vlm_20260916081556', remote)
        self.assertIn('vlm_20260916081556_plots', remote)
        self.assertIn('20260916081556', remote)
        self.assertIn('20260916081556_plots', remote)

    def test_vlm_modality_prefix_is_case_insensitive(self):
        with patch('training_cleanup.ssh_command', side_effect=lambda remote: ['ssh', remote]):
            remote = remote_delete_command('VLM', 'both_20260917004303')[1]
        self.assertIn('20260917004303', remote)
        self.assertIn('20260917004303_plots', remote)

    def test_rejects_unsafe_names_and_ignores_other_projects(self):
        self.assertIsNone(remote_delete_command('Dataset', 'Detector'))
        for name in ('../x', 'a/b', 'a b', '', 'x$(id)'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                remote_delete_command('Detector', name)

if __name__ == '__main__': unittest.main()
