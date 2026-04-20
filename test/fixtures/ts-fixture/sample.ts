/**
 * Minimal TypeScript fixture for LSP spike testing.
 * Used by bin/.lsp-spike.js to validate documentSymbol, findReferences,
 * and workspaceSymbol operations against the shared lsp-transport.js module.
 */

export interface Config {
  host: string;
  port: number;
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class Server {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  start(): void {
    console.log(`Starting on ${this.config.host}:${this.config.port}`);
  }

  stop(): void {
    console.log('Stopping server');
  }
}

// Call site for findReferences spike target (greet is referenced here)
const msg = greet('world');
console.log(msg);
