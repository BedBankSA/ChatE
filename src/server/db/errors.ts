export class StoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "StoreError";
    this.code = code;
  }
}
