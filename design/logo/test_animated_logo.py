import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BRAND = ROOT / "brand"
UI = ROOT / "pilotdeck-mobile/upstream-official/ui"
NS = "{http://www.w3.org/2000/svg}"


class AnimatedLogoTest(unittest.TestCase):
    def test_unboxed_final_and_ordered_letters(self):
        for name in ("pilotv-logo-animated.svg", "pilotv-logo-animated-dark.svg"):
            svg = (BRAND / name).read_text()
            root = ET.fromstring(svg)
            self.assertEqual([node.get("class") for node in root.findall(f"{NS}g")],
                             ["letter-P", "letter-i", "letter-l", "letter-o", "letter-t", "v"])
            self.assertEqual(len(root.findall(f"{NS}rect")), 1)
            self.assertEqual(root.find(f"{NS}rect").get("class"), "bar")
            self.assertNotIn("infinite", svg)
            self.assertEqual(svg, (UI / "public/brand" / name).read_text())
            self.assertRegex(svg, r"@keyframes pv-v\{0%,28%.*37%,100%")
            for index, letter in enumerate("Pilot"):
                start = 37 + index * 10
                self.assertIn(f"{start}%{{opacity:0", svg)
                self.assertIn(f"{start + 8}%,100%{{opacity:1", svg)
            self.assertIn("prefers-reduced-motion:reduce", svg)

    def test_react_static_and_motion_parity(self):
        css = (UI / "src/components/app-shell/PilotVLogo.css").read_text()
        tsx = (UI / "src/components/app-shell/PilotVLogo.tsx").read_text()
        self.assertIn(".pv-logo:not(.pv-logo--animated) * { animation: none !important; }", css)
        self.assertIn(".pv-logo__spark { opacity: 0; }", css)
        self.assertIn("animation:pv-line 7.2s", css)
        self.assertIn("animation:pv-t 7.2s", css)
        self.assertIn("letter.ch === 'V'", tsx)
        self.assertNotIn("pv-logo__carriage", tsx)


if __name__ == "__main__":
    unittest.main()
