"""
Minimal Python fixture for lsp-query.test.js.
Exercises documentSymbol (class + function),
findReferences (greet defined on line 11, called on line 24),
and workspaceSymbol (query: "Greeter").
"""
from dataclasses import dataclass


@dataclass
class Config:
    host: str
    port: int


def greet(name: str) -> str:
    """Return a greeting string."""
    return f"Hello, {name}!"


class Greeter:
    """Wraps Config and exposes run()."""

    def __init__(self, config: Config) -> None:
        self.config = config

    def run(self) -> str:
        return greet(self.config.host)


# Reference site: greet is called here (line 29, char 10)
result = greet("fixture")
print(result)
