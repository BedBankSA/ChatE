export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 500) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function publicError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, status: error.statusCode };
  }
  return { code: "INTERNAL", message: "تعذر إكمال الطلب", status: 500 };
}
