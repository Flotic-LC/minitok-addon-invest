"use strict";

class TossApiError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "TossApiError";
    this.code = opts.code;
    this.mappedCode = opts.mappedCode;
    this.status = opts.status;
    this.apiError = opts.apiError;
    this.detail = opts.detail;
  }
}

module.exports = { TossApiError };
