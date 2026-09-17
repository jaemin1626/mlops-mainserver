import unittest
from mlops_dataset_tree import vlm_path_visible

class VlmTreeVisibilityTests(unittest.TestCase):
    def test_image_only(self):
        self.assertTrue(vlm_path_visible("images/fire/a.jpg", "image"))
        self.assertFalse(vlm_path_visible("videos/fire/a.mp4", "image"))
    def test_video_only(self):
        self.assertTrue(vlm_path_visible("videos/fire/a.mp4", "video"))
        self.assertFalse(vlm_path_visible("images/fire/a.jpg", "video"))
    def test_both_and_internal_hidden(self):
        self.assertTrue(vlm_path_visible("Images/Generate/a.jpg", "both"))
        self.assertTrue(vlm_path_visible("Videos/Generate/a.mp4", "both"))
        for path in ["images_json/a.json", "videos_json/a.json", "annotation/a.json", "backup/a.jpg", "generated/a.mp4"]:
            self.assertFalse(vlm_path_visible(path, "both"), path)

if __name__ == "__main__": unittest.main()
