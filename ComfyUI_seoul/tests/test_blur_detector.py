import unittest
from pathlib import Path

from seoul_studio.blur_detector import friendly_blur_load_error
from seoul_studio.yolov7_backend import weights_look_like_yolov7


class BlurDetectorTests(unittest.TestCase):
    def test_friendly_yolov5_message(self) -> None:
        exc = TypeError(
            "ERROR ❌️ model.pt appears to be an Ultralytics YOLOv5 model "
            "originally trained with yolov5. This model is NOT forwards compatible with YOLOv8"
        )
        msg = friendly_blur_load_error(exc)
        self.assertIn("YOLOv5", msg)

    def test_detect_obd_v7_weights(self) -> None:
        weights = Path("/opt/clearml/models/anonymize/04_OBD_BASE_INTEGRATED_v2.1.8.pt")
        if not weights.is_file():
            self.skipTest("OBD v7 weights not present on host")
        self.assertTrue(weights_look_like_yolov7(weights))


if __name__ == "__main__":
    unittest.main()
