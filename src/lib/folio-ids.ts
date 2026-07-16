import { randomBytes } from "node:crypto";

export function newFolioId(date = new Date()): string {
  const timestamp = date.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw new RangeError("UUIDv7 timestamp must fit in 48 bits.");
  }

  const bytes = randomBytes(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
