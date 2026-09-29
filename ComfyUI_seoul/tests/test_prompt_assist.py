import unittest

from seoul_studio.prompt_assist import (
    generate_template,
    split_positive_negative,
    validate_structured_text,
    assist,
    PromptAssistError,
)


class PromptAssistTests(unittest.TestCase):
    def test_validate_and_split(self) -> None:
        sample = (
            "[global prompt]\n\nFixed CCTV view.\n\n"
            "[camera]\n\nNo movement.\n\n"
            "[event start]\n\nCalm start.\n\n"
            "[motion / subject]\n\nSmall flame flickers.\n\n"
            "[motion constraint]\n\nNothing else moves.\n\n"
            "[negative prompt]\n\nblurry, shake"
        )
        self.assertTrue(validate_structured_text(sample))
        positive, negative = split_positive_negative(sample)
        self.assertIn("[global prompt]", positive)
        self.assertEqual(negative, "blurry, shake")

    def test_template_has_all_sections(self) -> None:
        result = generate_template("공장 CCTV 화재", "fire")
        positive_lower = result["positive"].lower()
        for header in ("[global prompt]", "[camera]", "[event start]", "[motion / subject]", "[motion constraint]"):
            self.assertIn(header, positive_lower)
        self.assertIn("fire", result["positive"].lower())
        self.assertTrue(result["negative"])

    def test_assist_empty_intent(self) -> None:
        with self.assertRaises(PromptAssistError):
            assist("  ")

    def test_assist_template_fallback(self) -> None:
        result = assist("창고 CCTV, 작은 연기", "smoke")
        self.assertEqual(result["source"], "template")
        self.assertIn("[camera]", result["positive"])
        self.assertTrue(result["negative"])


if __name__ == "__main__":
    unittest.main()
