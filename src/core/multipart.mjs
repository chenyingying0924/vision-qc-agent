/**
 * Minimal `multipart/form-data` parser — enough for `<input type=file multiple>`
 * plus a couple of text fields, with no dependencies.
 *
 * @module vision-qc-agent/core/multipart
 */

/**
 * Parse a multipart body.
 * @param {Buffer} buffer - the raw request body.
 * @param {string} contentType - the request's `content-type` header.
 * @returns {{fields: Record<string,string>, files: Array<{name: string, type: string, buffer: Buffer}>}}
 * @throws {Error} when the boundary is missing.
 */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=("?)([^";]+)\1/.exec(contentType ?? "");
  if (!boundaryMatch) throw new Error("缺少 multipart boundary");
  const boundary = Buffer.from(`--${boundaryMatch[2]}`);
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    const partStart = cursor + boundary.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === "--") break;
    const headerEnd = buffer.indexOf("\r\n\r\n", partStart);
    if (headerEnd === -1) break;
    const headerText = buffer.subarray(partStart, headerEnd).toString("utf8");
    const next = buffer.indexOf(boundary, headerEnd);
    if (next === -1) break;
    const body = buffer.subarray(headerEnd + 4, next - 2);
    const nameMatch = /name="([^"]*)"/.exec(headerText);
    const fileMatch = /filename="([^"]*)"/.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const fieldName = nameMatch?.[1] ?? "unnamed";
    if (fileMatch && fileMatch[1]) {
      files.push({ name: fileMatch[1], type: (typeMatch?.[1] ?? "").trim(), buffer: body });
    } else {
      fields[fieldName] = body.toString("utf8");
    }
    cursor = next;
  }
  return { fields, files };
}
