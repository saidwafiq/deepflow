/**
 * Minimal TypeScript fixture for lsp-query.test.js.
 * Exercises documentSymbol (interface + class + function),
 * findReferences (greet is defined on line 10 and called on line 28),
 * and workspaceSymbol (query: "Greeter").
 */

export interface Config {
  host: string;
  port: number;
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class Greeter {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  run(): string {
    return greet(this.config.host);
  }
}

// Reference site: greet is called here (line 28, char 14)
const result = greet('fixture');
console.log(result);
