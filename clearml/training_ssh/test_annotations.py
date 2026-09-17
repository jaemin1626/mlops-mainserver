import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from annotation_builder import detector_bundle, validate_classes
from transfer_annotations import transfer_detector_bundle, BUNDLE_FILES
from client import sftp_command


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base/'datasets'; self.root.mkdir()
        self.out = self.base/'out'
        for folder in ['one', 'two/nested']:
            directory = self.root/folder; directory.mkdir(parents=True)
            for i in range(5):
                (directory/f'{i}.jpg').touch()
                (directory/f'{i}.txt').write_text('1 0.5 0.5 0.2 0.2\n')

    def build(self, classes=None, folders=None):
        return detector_bundle(folders or [self.root], '/workspace/Dataset/detector', self.out,
                               ['person','car'] if classes is None else classes, self.root)

    def test_lists_yaml_dedup_and_reproducibility(self):
        result = self.build(folders=[self.root, self.root/'one'])
        self.assertEqual((result['train'],result['test']), (9,1))
        self.assertEqual(set(p.name for p in self.out.iterdir()), {'train.txt', 'test.txt', 'data.yaml'})
        manifests=[]
        for split in ['train','test']:
            items = (self.out/f'{split}.txt').read_text().splitlines()
            self.assertFalse((self.out/f'{split}.json').exists())
            manifests.append(items)
        self.assertFalse(set(manifests[0])&set(manifests[1]))
        self.assertEqual(len(set(manifests[0]+manifests[1])),10)
        self.assertIn('/workspace/Dataset/detector/two/nested/0.jpg',manifests[0]+manifests[1])
        before = (self.out/'train.txt').read_bytes()
        result = self.build(classes=['pedestrian','vehicle'])
        self.assertEqual(before,(self.out/'train.txt').read_bytes())
        self.assertIn('val: test.txt', result['yaml'])
        self.assertIn('nc: 2', result['yaml'])
        self.assertIn('names: ["pedestrian", "vehicle"]', result['yaml'])
        self.assertNotIn('path:', result['yaml'])

    def test_invalid_class_names_and_label_ids(self):
        for classes in [[], 'person', ['a','a'], ['a',' a '], [''], ['a\nb'], [1]]:
            with self.subTest(classes=classes), self.assertRaises(ValueError):
                validate_classes(classes)
        with self.assertRaisesRegex(ValueError,'클래스 ID'):
            self.build(classes=['person'])
        label=self.root/'one/0.txt'
        for value in ['-1', '1.5', 'abc', '２']:
            label.write_text(value+' 0.5 0.5 0.2 0.2\n')
            with self.assertRaises(ValueError):
                self.build()

    def test_unicode_and_yaml_metacharacters(self):
        names=['사람: #1', 'car "two"']
        result=self.build(classes=names)
        # names are emitted as one "  <index>: <json string>" line each, not a single-line JSON array.
        block=result['yaml'].split('names:\n',1)[1].split('\n\n',1)[0]
        parsed=[json.loads(line.split(': ',1)[1]) for line in block.splitlines()]
        self.assertEqual(parsed,names)

    def test_yolo_images_labels_layout_and_missing_labels(self):
        images=self.root/'third/images'; images.mkdir(parents=True)
        labels=self.root/'third/labels'; labels.mkdir()
        (images/'a.jpg').touch(); (images/'b.jpg').touch()
        (labels/'a.txt').write_text('2 0.5 0.5 0.1 0.1')
        with self.assertRaisesRegex(ValueError,'클래스 ID'):
            self.build(folders=[images])
        (labels/'a.txt').write_text('0 0.5 0.5 0.1 0.1')
        result=self.build(folders=[images])
        self.assertEqual(result['missing_labels'],1)
        self.assertEqual((result['train'],result['test']),(1,1))

    def test_escapes_and_empty_data(self):
        outside=self.base/'outside.jpg'; outside.touch()
        (self.root/'escape.jpg').symlink_to(outside)
        with self.assertRaisesRegex(ValueError,'outside'):
            self.build()
        (self.root/'escape.jpg').unlink()
        outside_label=self.base/'outside.txt'; outside_label.write_text('0')
        label=self.root/'one/0.txt'; label.unlink(); label.symlink_to(outside_label)
        with self.assertRaisesRegex(ValueError,'outside'):
            self.build()
        empty=self.root/'empty'; empty.mkdir()
        with self.assertRaises(ValueError):
            self.build(folders=[empty])
        with self.assertRaises(ValueError):
            self.build(folders=[self.base])

    def test_newline_path_is_rejected(self):
        (self.root/'bad\nname.jpg').touch()
        with self.assertRaises(ValueError):
            self.build()

    def test_sftp_publication_is_atomic_and_no_remote_shell(self):
        self.build()
        credential=self.base/'key'; credential.touch()
        env={'TRAINING_SSH_KEY_FILE':str(credential),'TRAINING_SSH_KNOWN_HOSTS':str(credential)}
        with patch.dict(os.environ,env), patch('transfer_annotations.subprocess.run') as run:
            run.return_value=subprocess.CompletedProcess([],0,'','')
            result=transfer_detector_bundle(self.out)
        argv=run.call_args.args[0]
        self.assertEqual(argv[0],'sftp');self.assertNotIn('-T',argv)
        self.assertIn('StrictHostKeyChecking=yes',argv);self.assertIn('-P',argv)
        commands=run.call_args.kwargs['input'].splitlines()
        self.assertEqual(sum(c.startswith('put ') for c in commands),3)
        self.assertFalse(any('.json' in c for c in commands))
        self.assertTrue(commands[-1].startswith('rename '))
        self.assertIn('data/generated/',result['data'])
        self.assertEqual(set(result['files']),set(BUNDLE_FILES))
        self.assertNotIn('shell',run.call_args.kwargs)
        with patch.dict(os.environ,env), patch('transfer_annotations.subprocess.run') as run:
            run.return_value=subprocess.CompletedProcess([],1,'','transfer error')
            with self.assertLogs('detector.transfer'), self.assertRaises(subprocess.CalledProcessError):
                transfer_detector_bundle(self.out)
        (self.out/'data.yaml').unlink()
        with self.assertRaises(ValueError):
            transfer_detector_bundle(self.out)

    def test_sftp_password_uses_same_validation(self):
        credential=self.base/'known';credential.touch()
        args=sftp_command({'TRAINING_SSH_PASSWORD':'secret','TRAINING_SSH_KNOWN_HOSTS':str(credential)})
        self.assertEqual(args[:3],['sshpass','-e','sftp'])
        self.assertNotIn('secret',args)
        self.assertIn('BatchMode=no',args)
        with self.assertRaises(ValueError):
            sftp_command({'TRAINING_SSH_HOST':'-oBad'})

if __name__ == '__main__':
    unittest.main()
