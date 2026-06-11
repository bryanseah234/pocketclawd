"""Slide generation module for creating PPTX presentations from summaries."""

from .generator import (
    SlideGenerator,
    SlideTemplate,
    SlideResult,
    generate_slides,
)

__all__ = [
    "SlideGenerator",
    "SlideTemplate",
    "SlideResult",
    "generate_slides",
]
