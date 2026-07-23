"""Scoped investment-news catalog data."""

from .catalog import (
    ArticleAccess,
    FeedEndpoint,
    NewsCatalog,
    NewsScope,
    SourceAssignment,
    group_endpoints,
    load_catalog,
)

__all__ = [
    "ArticleAccess",
    "FeedEndpoint",
    "NewsCatalog",
    "NewsScope",
    "SourceAssignment",
    "group_endpoints",
    "load_catalog",
]
