/**
 * Errors that carry a machine-readable `code`.
 *
 * The HTTP layer maps codes to status codes and the report/event layer puts the
 * code next to the message, so a caller can tell "your request was wrong"
 * (`BAD_MULTIPART`, `UNKNOWN_CHECKLIST`, `UNSUPPORTED_FORMAT`) apart from
 * "the upstream model failed" (`VISION_ERROR`, `TIMEOUT`). Without a code every
 * failure had to be reported as a bare 500.
 *
 * @module vision-qc-agent/core/errors
 */

export class QcError extends Error {
  /**
   * @param {string} message - human-readable message (shown to the user as-is).
   * @param {string} [code] - stable identifier, e.g. `UNSUPPORTED_FORMAT`.
   * @param {object} [details] - extra context for the caller (never secrets).
   */
  constructor(message, code = "QC_ERROR", details = undefined) {
    super(message);
    this.name = "QcError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** HTTP status for a code, used by `server.mjs` so the mapping lives in one place. */
const STATUS = {
  BAD_MULTIPART: 400,
  BAD_JSON: 400,
  BAD_FIELD: 400,
  UNKNOWN_CHECKLIST: 400,
  UNSUPPORTED_FORMAT: 422,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
};

/**
 * @param {Error} error
 * @returns {number} the HTTP status that matches `error.code`.
 */
export function httpStatusFor(error) {
  return STATUS[error?.code] ?? 500;
}
