from typing import Optional


class Widgets:
    """Widgets API resource."""

    def list_widgets(
        self,
        *,
        limit: Optional[int] = None,
        before: Optional[str] = None,
        after: Optional[str] = None,
        search: Optional[str] = None,
    ) -> None:
        """List widgets."""
        ...
