"""Unified progress bar for all LTX merger operations."""

import sys
import time

class ProgressBar:
    """Simple, reusable progress bar for console output."""

    def __init__(self, total, desc="Processing", width=40):
        self.total = total
        self.current = 0
        self.desc = desc
        self.width = width
        self.start_time = None

    def start(self):
        """Initialize the progress bar."""
        self.start_time = time.time()
        self.update(0)

    def update(self, n=1):
        """Advance progress by n steps."""
        self.current += n
        self._draw()

    def set(self, value):
        """Set progress to specific value."""
        self.current = value
        self._draw()

    def _draw(self):
        """Draw the progress bar."""
        if self.total == 0:
            return

        percent = min(1.0, self.current / self.total)
        filled = int(self.width * percent)
        bar = "█" * filled + "░" * (self.width - filled)

        # Calculate elapsed time
        elapsed = time.time() - self.start_time if self.start_time else 0
        if self.current > 0 and percent < 1.0:
            eta = elapsed / percent * (1 - percent)
            time_str = f" {int(eta)}s"
        else:
            time_str = ""

        # Clear line and draw
        sys.stdout.write(f"\r{self.desc}: [{bar}] {self.current}/{self.total} ({percent*100:.1f}%){time_str}")
        sys.stdout.flush()

        # New line when complete
        if self.current >= self.total:
            sys.stdout.write(f"\n{self.desc} completed in {int(elapsed)}s\n")
            sys.stdout.flush()

    def finish(self):
        """Force completion of the progress bar."""
        self.current = self.total
        self._draw()


def progress_iterator(items, desc="Processing"):
    """Wrap an iterable with a progress bar.

    Usage:
        for item in progress_iterator(my_list, "Loading"):
            process(item)
    """
    total = len(items) if hasattr(items, '__len__') else None
    if total is None:
        # No progress bar for unknown length iterables
        for item in items:
            yield item
        return

    bar = ProgressBar(total, desc)
    bar.start()
    for item in items:
        yield item
        bar.update(1)
