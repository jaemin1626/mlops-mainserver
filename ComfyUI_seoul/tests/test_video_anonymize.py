import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from seoul_studio.video_anonymize import default_blur_ratio, default_weights_path, format_blur_classes


class VideoAnonymizeTests(unittest.TestCase):
    def test_default_weights_path(self) -> None:
        path = default_weights_path()
        self.assertTrue(str(path).endswith("best.pt") or path.name.endswith(".pt"))

    def test_default_blur_ratio_positive(self) -> None:
        self.assertGreaterEqual(default_blur_ratio(), 1)

    def test_format_blur_classes(self) -> None:
        self.assertEqual(format_blur_classes(None), "")
        self.assertEqual(format_blur_classes([]), "")
        self.assertEqual(format_blur_classes([0, 2, 5]), "0,2,5")

    @patch("seoul_studio.video_anonymize.cv2.VideoCapture")
    @patch("seoul_studio.video_anonymize.cv2.VideoWriter")
    @patch("seoul_studio.video_anonymize._encode_h264")
    def test_anonymize_video_writes_output(self, encode_mock, writer_cls, capture_cls) -> None:
        import numpy as np

        from seoul_studio.video_anonymize import anonymize_video

        cap = MagicMock()
        cap.isOpened.return_value = True
        cap.get.side_effect = lambda prop: {5: 30.0, 3: 64, 4: 48}.get(prop, 0)
        frame = np.zeros((48, 64, 3), dtype=np.uint8)
        cap.read.side_effect = [(True, frame), (True, frame), (False, None)]
        capture_cls.return_value = cap

        writer = MagicMock()
        writer.isOpened.return_value = True
        writer_cls.return_value = writer

        fake_box = MagicMock()
        fake_box.cpu.return_value.numpy.return_value = [[0, 0, 10, 10]]
        fake_result = MagicMock()
        fake_result.boxes = MagicMock()
        fake_result.boxes.__len__.return_value = 1
        fake_result.boxes.xyxy = fake_box

        fake_model = MagicMock()
        fake_model.predict.return_value = [fake_result]

        with patch("seoul_studio.video_anonymize.load_blur_model", return_value=fake_model):
            with patch.object(Path, "is_file", return_value=True):
                result = anonymize_video(
                    Path("/tmp/sample.mp4"),
                    weights=Path("/tmp/best.pt"),
                    dest=Path("/tmp/sample_anony.mp4"),
                    class_ids=[0],
                    save_txt=False,
                )

        self.assertEqual(result["frame_count"], 2)
        self.assertGreaterEqual(result["blurred_boxes"], 1)
        encode_mock.assert_called_once()
        writer.release.assert_called_once()


if __name__ == "__main__":
    unittest.main()
