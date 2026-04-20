// Minimal Go fixture for lsp-query.test.js.
// Exercises documentSymbol (interface + struct + function),
// findReferences (Greet defined on line 16, called on line 30),
// and workspaceSymbol (query: "Greeter").
package sample

import "fmt"

// Config holds connection parameters.
type Config struct {
	Host string
	Port int
}

// Greet returns a greeting string.
func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

// Greeter wraps a Config and exposes Run.
type Greeter struct {
	config Config
}

// NewGreeter constructs a Greeter.
func NewGreeter(c Config) *Greeter {
	return &Greeter{config: c}
}

// Run calls Greet with the configured host.
func (g *Greeter) Run() string {
	return Greet(g.config.Host)
}
