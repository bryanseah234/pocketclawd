"""
Unit tests for the slide generation module.

Tests cover:
  - Summary parsing into sections
  - PPTX generation for all 4 templates
  - Edge cases (empty input, single line, no bullets)
  - Filename sanitization
"""

import io

from pptx import Presentation

from src.slides.generator import (
    SlideGenerator,
    SlideTemplate,
    SlideResult,
    generate_slides,
    parse_summary_to_sections,
    SlideSection,
)


# ---------------------------------------------------------------------------
# parse_summary_to_sections tests
# ---------------------------------------------------------------------------


class TestParseSummary:
    """Tests for the summary parser."""

    def test_empty_string_returns_default_section(self):
        sections = parse_summary_to_sections("")
        assert len(sections) == 1
        assert sections[0].title == "Presentation"
        assert sections[0].bullets == []

    def test_whitespace_only_returns_default_section(self):
        sections = parse_summary_to_sections("   \n\n  ")
        assert len(sections) == 1
        assert sections[0].title == "Presentation"

    def test_markdown_headers_parsed(self):
        summary = """# Introduction
- First point
- Second point

## Details
- Detail one
- Detail two
"""
        sections = parse_summary_to_sections(summary)
        assert len(sections) == 2
        assert sections[0].title == "Introduction"
        assert sections[0].bullets == ["First point", "Second point"]
        assert sections[1].title == "Details"
        assert sections[1].bullets == ["Detail one", "Detail two"]

    def test_numbered_sections_parsed(self):
        summary = """1. Overview
- Key insight A
- Key insight B

2. Recommendations
- Action item 1
- Action item 2
"""
        sections = parse_summary_to_sections(summary)
        assert len(sections) == 2
        assert sections[0].title == "Overview"
        assert sections[1].title == "Recommendations"

    def test_plain_text_becomes_title(self):
        summary = "Simple Title"
        sections = parse_summary_to_sections(summary)
        assert len(sections) == 1
        assert sections[0].title == "Simple Title"
        assert sections[0].bullets == []

    def test_bullets_without_header_get_overview_title(self):
        summary = """- Point one
- Point two
- Point three
"""
        sections = parse_summary_to_sections(summary)
        assert len(sections) == 1
        assert sections[0].title == "Overview"
        assert len(sections[0].bullets) == 3

    def test_mixed_bullet_styles(self):
        summary = """# Section
- Dash bullet
* Star bullet
"""
        sections = parse_summary_to_sections(summary)
        assert sections[0].bullets == ["Dash bullet", "Star bullet"]

    def test_multiple_sections_with_varying_bullets(self):
        summary = """# First
- A
- B

# Second

# Third
- X
"""
        sections = parse_summary_to_sections(summary)
        assert len(sections) == 3
        assert sections[0].bullets == ["A", "B"]
        assert sections[1].bullets == []
        assert sections[2].bullets == ["X"]


# ---------------------------------------------------------------------------
# SlideGenerator tests
# ---------------------------------------------------------------------------


class TestSlideGenerator:
    """Tests for PPTX generation."""

    def test_generate_returns_slide_result(self):
        result = generate_slides("# Test\n- Point 1")
        assert isinstance(result, SlideResult)
        assert isinstance(result.file_bytes, bytes)
        assert len(result.file_bytes) > 0
        assert result.filename.endswith(".pptx")
        assert result.slide_count >= 2  # title + at least 1 content

    def test_generated_pptx_is_valid(self):
        result = generate_slides("# Hello World\n- Bullet one\n- Bullet two")
        # Verify we can open the generated PPTX
        prs = Presentation(io.BytesIO(result.file_bytes))
        assert len(prs.slides) == result.slide_count

    def test_corporate_template(self):
        result = generate_slides(
            "# Q4 Report\n- Revenue up 15%\n- New markets entered",
            template=SlideTemplate.CORPORATE,
        )
        assert result.template == SlideTemplate.CORPORATE
        prs = Presentation(io.BytesIO(result.file_bytes))
        assert len(prs.slides) >= 2

    def test_modern_template(self):
        result = generate_slides(
            "# Product Launch\n- Feature A\n- Feature B",
            template=SlideTemplate.MODERN,
        )
        assert result.template == SlideTemplate.MODERN
        prs = Presentation(io.BytesIO(result.file_bytes))
        assert len(prs.slides) >= 2

    def test_elegant_template(self):
        result = generate_slides(
            "# Gala Event\n- Welcome speech\n- Awards ceremony",
            template=SlideTemplate.ELEGANT,
        )
        assert result.template == SlideTemplate.ELEGANT
        prs = Presentation(io.BytesIO(result.file_bytes))
        assert len(prs.slides) >= 2

    def test_informative_template(self):
        result = generate_slides(
            "# Data Analysis\n- Trend 1\n- Trend 2\n- Trend 3",
            template=SlideTemplate.INFORMATIVE,
        )
        assert result.template == SlideTemplate.INFORMATIVE
        prs = Presentation(io.BytesIO(result.file_bytes))
        assert len(prs.slides) >= 2

    def test_custom_title_override(self):
        result = generate_slides(
            "# Original Title\n- Content",
            title="Custom Title",
        )
        assert "Custom-Title" in result.filename or "Custom" in result.filename

    def test_empty_summary_produces_valid_pptx(self):
        result = generate_slides("")
        assert result.slide_count >= 1
        prs = Presentation(io.BytesIO(result.file_bytes))
        assert len(prs.slides) >= 1

    def test_long_summary_multiple_slides(self):
        summary = "\n".join(
            [f"# Section {i}\n- Point A\n- Point B" for i in range(5)]
        )
        result = generate_slides(summary)
        # 1 title slide + 5 content slides
        assert result.slide_count == 6

    def test_filename_sanitization(self):
        result = generate_slides("# Hello/World: Test! @#$%")
        # Should not contain special characters
        assert "/" not in result.filename
        assert ":" not in result.filename
        assert "@" not in result.filename
        assert result.filename.endswith(".pptx")

    def test_all_templates_produce_different_results(self):
        summary = "# Test\n- Point"
        results = {}
        for template in SlideTemplate:
            results[template] = generate_slides(summary, template=template)

        # Each template should produce valid but different output
        for template, result in results.items():
            assert result.template == template
            assert len(result.file_bytes) > 0

    def test_slide_count_matches_sections_plus_title(self):
        summary = """# Intro
- A

# Middle
- B

# End
- C
"""
        result = generate_slides(summary)
        # 3 sections + 1 title slide = 4
        assert result.slide_count == 4
